/**
 * Fachada única de almacenamiento de objetos. Dos drivers con la MISMA interfaz:
 *   - 'wasabi' (producción): S3-compatible sobre Wasabi.
 *   - 'local'  (desarrollo): sistema de archivos del backend, para completar los
 *     flujos sin credenciales de Wasabi.
 *
 * Selección (variable STORAGE_DRIVER):
 *   - Si STORAGE_DRIVER está definido ('wasabi' | 'local'), manda.
 *   - Si no, se autodetecta: 'wasabi' cuando hay credenciales completas, 'local'
 *     en caso contrario. Producción (con credenciales) queda intacta.
 *
 * Convención de keys (idéntica en ambos drivers):
 *   El `ruta_almacenamiento` en BD siempre se guarda como `/uploads/<tipo>/<yyyy>/<mm>/<archivo>`.
 *   La key real es ese path sin el `/` inicial — `uploads/<tipo>/<yyyy>/<mm>/<archivo>`.
 *   `keyDesdeRuta()` y `rutaDesdeKey()` son las dos únicas funciones que conocen esa relación.
 */

const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const {
  WASABI_ACCESS_KEY,
  WASABI_SECRET_KEY,
  WASABI_REGION,
  WASABI_ENDPOINT,
  WASABI_BUCKET,
  WASABI_URL_TTL
} = process.env;

const WASABI_CONFIGURADO = !!(WASABI_ACCESS_KEY && WASABI_SECRET_KEY && WASABI_BUCKET && WASABI_ENDPOINT);
const DRIVER = (process.env.STORAGE_DRIVER || (WASABI_CONFIGURADO ? 'wasabi' : 'local')).toLowerCase();
const LOCAL = DRIVER === 'local';

// Directorio raíz para el driver local (por defecto backend/uploads-local).
const LOCAL_DIR = process.env.UPLOAD_LOCAL_DIR
  ? path.resolve(process.env.UPLOAD_LOCAL_DIR)
  : path.join(__dirname, '..', 'uploads-local');

if (LOCAL) {
  console.log(`[storage] Driver LOCAL activo — archivos en ${LOCAL_DIR} (sin Wasabi).`);
} else if (!WASABI_CONFIGURADO) {
  console.warn('[storage] Driver WASABI seleccionado pero faltan WASABI_* en env. Las operaciones de archivo fallarán (usa STORAGE_DRIVER=local para trabajar sin Wasabi).');
}

/**
 * Tamaño de cada parte del multipart upload. S3/Wasabi exigen un mínimo de 5 MiB
 * por parte (salvo la última) y admiten hasta 10 000 partes: con 16 MiB el techo
 * por archivo queda en ~160 GB y el backend nunca retiene en memoria más de una
 * parte a la vez, sea cual sea el peso del video que suba el técnico.
 */
const PARTE_MB = Math.max(5, Number(process.env.UPLOAD_PART_MB) || 16);
const PARTE_BYTES = PARTE_MB * 1024 * 1024;

const REGION = WASABI_REGION || 'us-east-1';
const BUCKET = WASABI_BUCKET;
const URL_TTL = Number(WASABI_URL_TTL) || 3600;

const client = new S3Client({
  region: REGION,
  endpoint: WASABI_ENDPOINT,
  credentials: { accessKeyId: WASABI_ACCESS_KEY || '', secretAccessKey: WASABI_SECRET_KEY || '' },
  // Path-style URLs (bucket en path, no subdomain). Wasabi soporta ambos pero path-style
  // evita problemas de DNS cuando el bucket aún no existe y simplifica el desarrollo local.
  forcePathStyle: true
});

function asegurarConfig() {
  if (!WASABI_ACCESS_KEY || !WASABI_SECRET_KEY || !BUCKET) {
    throw new Error('Wasabi no configurado: faltan WASABI_ACCESS_KEY / WASABI_SECRET_KEY / WASABI_BUCKET');
  }
}

/**
 * Ruta absoluta en disco de una key, para el driver local. Bloquea path
 * traversal: la ruta resuelta debe quedar dentro de LOCAL_DIR.
 */
function rutaAbsoluta(key) {
  const limpio = String(key || '').replace(/^\/+/, '');
  const base = path.resolve(LOCAL_DIR);
  const abs = path.resolve(base, limpio);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('Key inválida: fuera del directorio de uploads');
  }
  return abs;
}

/** Convierte la `ruta_almacenamiento` de BD (con /uploads/ prefix) en la S3 key real. */
function keyDesdeRuta(ruta) {
  if (!ruta) return null;
  return ruta.replace(/^\/+/, '');
}

/** Inverso de keyDesdeRuta — para construir la ruta a guardar en BD a partir de una key. */
function rutaDesdeKey(key) {
  if (!key) return null;
  return key.startsWith('/') ? key : `/${key}`;
}

// ---------------------------------------------------------------------
// Driver WASABI (producción)
// ---------------------------------------------------------------------

async function subirObjetoWasabi({ key, body, contentType }) {
  asegurarConfig();
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream'
  }));
  return { key, ruta: rutaDesdeKey(key) };
}

/**
 * Sube un stream a Wasabi con multipart upload, sin conocer de antemano el
 * tamaño y sin acumular el archivo entero en memoria: se van cortando partes de
 * PARTE_BYTES y subiéndolas una a una. El `await` dentro del `for await` aplica
 * contrapresión sobre el stream de entrada, así que la petición HTTP avanza al
 * ritmo al que Wasabi acepta los datos.
 *
 * Si algo falla se aborta el multipart para no dejar partes huérfanas facturando
 * en el bucket.
 */
async function subirObjetoStreamWasabi({ key, stream, contentType, onProgress }) {
  asegurarConfig();
  const creado = await client.send(new CreateMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || 'application/octet-stream'
  }));
  const uploadId = creado.UploadId;
  const partes = [];
  let bytes = 0;
  let acumulado = [];
  let pendiente = 0;

  const subirParte = async (body) => {
    const PartNumber = partes.length + 1;
    const r = await client.send(new UploadPartCommand({
      Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber, Body: body
    }));
    partes.push({ ETag: r.ETag, PartNumber });
  };

  try {
    for await (const chunk of stream) {
      acumulado.push(chunk);
      pendiente += chunk.length;
      bytes += chunk.length;
      if (pendiente >= PARTE_BYTES) {
        const body = Buffer.concat(acumulado);
        acumulado = [];
        pendiente = 0;
        await subirParte(body);
      }
      if (onProgress) onProgress(bytes);
    }
    // Última parte (o archivo más pequeño que una parte: igual necesita 1 parte).
    if (pendiente > 0 || partes.length === 0) {
      await subirParte(Buffer.concat(acumulado));
    }
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: partes }
    }));
    return { key, ruta: rutaDesdeKey(key), bytes };
  } catch (err) {
    try {
      await client.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
    } catch (e) {
      console.warn('[storage] no se pudo abortar el multipart upload:', e.message);
    }
    throw err;
  }
}

async function eliminarObjetoWasabi(key) {
  asegurarConfig();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function existeObjetoWasabi(key) {
  asegurarConfig();
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.$metadata && err.$metadata.httpStatusCode === 404) return false;
    if (err.name === 'NotFound' || err.name === 'NoSuchKey') return false;
    throw err;
  }
}

/**
 * URL firmada GET. Por defecto se descarga inline (mismo archivo, sin force-download).
 * Si `nombreDescarga` viene definido, se setea Content-Disposition: attachment.
 */
async function urlPresignedWasabi(key, { nombreDescarga, expiresIn } = {}) {
  asegurarConfig();
  const params = { Bucket: BUCKET, Key: key };
  if (nombreDescarga) {
    params.ResponseContentDisposition = `attachment; filename="${nombreDescarga.replace(/"/g, '')}"`;
  }
  return getSignedUrl(client, new GetObjectCommand(params), { expiresIn: expiresIn || URL_TTL });
}

async function obtenerStreamWasabi(key) {
  asegurarConfig();
  const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return r;
}

async function asegurarBucketWasabi() {
  asegurarConfig();
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return { creado: false };
  } catch (err) {
    if (err.$metadata && err.$metadata.httpStatusCode === 404) {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
      return { creado: true };
    }
    throw err;
  }
}

async function listarObjetosWasabi(prefijo) {
  asegurarConfig();
  const out = [];
  let continuationToken;
  do {
    const r = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefijo,
      ContinuationToken: continuationToken
    }));
    if (r.Contents) out.push(...r.Contents);
    continuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

// ---------------------------------------------------------------------
// Driver LOCAL (desarrollo) — sistema de archivos del backend
// ---------------------------------------------------------------------

async function subirObjetoLocal({ key, body }) {
  const abs = rutaAbsoluta(key);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, body);
  return { key, ruta: rutaDesdeKey(key) };
}

/** Equivalente local: vuelca el stream a disco contando los bytes de paso. */
async function subirObjetoStreamLocal({ key, stream, onProgress }) {
  const abs = rutaAbsoluta(key);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  let bytes = 0;
  const contador = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (onProgress) onProgress(bytes);
      cb(null, chunk);
    }
  });
  try {
    await pipeline(stream, contador, fs.createWriteStream(abs));
  } catch (err) {
    // Un archivo a medias es peor que ninguno: se borra el parcial.
    try { await fs.promises.unlink(abs); } catch { /* no existía */ }
    throw err;
  }
  return { key, ruta: rutaDesdeKey(key), bytes };
}

async function eliminarObjetoLocal(key) {
  try {
    await fs.promises.unlink(rutaAbsoluta(key));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // borrado idempotente
  }
}

async function existeObjetoLocal(key) {
  try {
    await fs.promises.access(rutaAbsoluta(key));
    return true;
  } catch {
    return false;
  }
}

/**
 * En local no hay URL firmada: se devuelve la ruta pública `/uploads/<key>` que
 * sirve el propio backend (ruta `/uploads/*` en index.js). `nombreDescarga`
 * agrega `?download=1&n=...` para forzar la descarga con ese nombre.
 */
async function urlPresignedLocal(key, { nombreDescarga } = {}) {
  const ruta = rutaDesdeKey(key);
  if (nombreDescarga) {
    return `${ruta}?download=1&n=${encodeURIComponent(nombreDescarga)}`;
  }
  return ruta;
}

async function obtenerStreamLocal(key) {
  const abs = rutaAbsoluta(key);
  if (!fs.existsSync(abs)) {
    const err = new Error('NoSuchKey'); err.name = 'NoSuchKey'; throw err;
  }
  // Misma forma que la respuesta S3: los consumidores solo leen `.Body`.
  return { Body: fs.createReadStream(abs) };
}

async function asegurarBucketLocal() {
  await fs.promises.mkdir(path.resolve(LOCAL_DIR), { recursive: true });
  return { creado: true };
}

async function listarObjetosLocal(prefijo) {
  const base = path.resolve(LOCAL_DIR);
  const out = [];
  const walk = async (dir) => {
    let entradas;
    try {
      entradas = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entradas) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
      } else {
        const key = path.relative(base, abs).split(path.sep).join('/');
        if (!prefijo || key.startsWith(prefijo)) out.push({ Key: key });
      }
    }
  };
  await walk(base);
  return out;
}

// ---------------------------------------------------------------------
// Fachada: elige el driver activo. La interfaz pública es idéntica en ambos.
// ---------------------------------------------------------------------

module.exports = {
  client,
  BUCKET,
  REGION,
  URL_TTL,
  DRIVER,
  esLocal: () => LOCAL,
  rutaAbsoluta,
  keyDesdeRuta,
  rutaDesdeKey,
  subirObjeto:    LOCAL ? subirObjetoLocal    : subirObjetoWasabi,
  subirObjetoStream: LOCAL ? subirObjetoStreamLocal : subirObjetoStreamWasabi,
  eliminarObjeto: LOCAL ? eliminarObjetoLocal : eliminarObjetoWasabi,
  existeObjeto:   LOCAL ? existeObjetoLocal   : existeObjetoWasabi,
  urlPresigned:   LOCAL ? urlPresignedLocal   : urlPresignedWasabi,
  obtenerStream:  LOCAL ? obtenerStreamLocal  : obtenerStreamWasabi,
  asegurarBucket: LOCAL ? asegurarBucketLocal : asegurarBucketWasabi,
  listarObjetos:  LOCAL ? listarObjetosLocal  : listarObjetosWasabi
};

/**
 * Cliente único de almacenamiento de objetos sobre Wasabi (S3-compatible).
 *
 * Convención de keys:
 *   El `ruta_almacenamiento` en BD siempre se guarda como `/uploads/<tipo>/<yyyy>/<mm>/<archivo>`.
 *   La key real en Wasabi es ese path sin el `/` inicial — `uploads/<tipo>/<yyyy>/<mm>/<archivo>`.
 *   `keyDesdeRuta()` y `rutaDesdeKey()` son las dos únicas funciones que conocen esa relación.
 */

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command
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

if (!WASABI_ACCESS_KEY || !WASABI_SECRET_KEY || !WASABI_BUCKET || !WASABI_ENDPOINT) {
  // No reventamos al cargar el módulo — Prisma seed / scripts auxiliares pueden no necesitar S3.
  // Las funciones individuales lanzan si faltan credenciales al usarse.
  console.warn('[storage] Wasabi no configurado (faltan WASABI_* en env). Las operaciones de archivo fallarán.');
}

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

async function subirObjeto({ key, body, contentType }) {
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
 * Copia un objeto existente en Wasabi a una nueva key (copia del lado servidor,
 * sin descargar/subir el contenido). Devuelve la nueva key y su ruta para BD.
 */
async function copiarObjeto({ keyOrigen, keyDestino }) {
  asegurarConfig();
  await client.send(new CopyObjectCommand({
    Bucket: BUCKET,
    // CopySource debe incluir el bucket y venir URL-encoded.
    CopySource: encodeURIComponent(`${BUCKET}/${keyOrigen}`),
    Key: keyDestino
  }));
  return { key: keyDestino, ruta: rutaDesdeKey(keyDestino) };
}

async function eliminarObjeto(key) {
  asegurarConfig();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function existeObjeto(key) {
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
async function urlPresigned(key, { nombreDescarga, expiresIn } = {}) {
  asegurarConfig();
  const params = { Bucket: BUCKET, Key: key };
  if (nombreDescarga) {
    params.ResponseContentDisposition = `attachment; filename="${nombreDescarga.replace(/"/g, '')}"`;
  }
  return getSignedUrl(client, new GetObjectCommand(params), { expiresIn: expiresIn || URL_TTL });
}

async function obtenerStream(key) {
  asegurarConfig();
  const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return r;
}

async function asegurarBucket() {
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

async function listarObjetos(prefijo) {
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

module.exports = {
  client,
  BUCKET,
  REGION,
  URL_TTL,
  keyDesdeRuta,
  rutaDesdeKey,
  subirObjeto,
  copiarObjeto,
  eliminarObjeto,
  existeObjeto,
  urlPresigned,
  obtenerStream,
  asegurarBucket,
  listarObjetos
};

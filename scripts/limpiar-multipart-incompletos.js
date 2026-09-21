/**
 * Aborta los multipart uploads que quedaron a medias en Wasabi.
 *
 * Las subidas de evidencias van por multipart upload (ver utils/storage.js). El
 * código aborta el upload cuando una parte falla o cuando el técnico corta la
 * subida, pero si el proceso muere en medio —un deploy, un reinicio del
 * contenedor— las partes ya enviadas se quedan en el bucket ocupando espacio
 * facturable sin ser visibles como objeto.
 *
 * Uso:
 *   node backend/scripts/limpiar-multipart-incompletos.js            # lista, sin borrar
 *   node backend/scripts/limpiar-multipart-incompletos.js --abortar  # aborta los antiguos
 *   node backend/scripts/limpiar-multipart-incompletos.js --abortar --horas=6
 *
 * Por defecto solo toca los iniciados hace más de 24 h, para no cortar una
 * subida en curso de un video grande.
 *
 * Alternativa permanente: una regla de ciclo de vida en el bucket con
 * AbortIncompleteMultipartUpload. Este script cubre el caso mientras no exista.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand
} = require('@aws-sdk/client-s3');
const { client, BUCKET, esLocal } = require('../utils/storage');

const ABORTAR = process.argv.includes('--abortar');
const argHoras = process.argv.find(a => a.startsWith('--horas='));
const HORAS = argHoras ? Number(argHoras.split('=')[1]) : 24;

async function listarTodos() {
  const encontrados = [];
  let KeyMarker;
  let UploadIdMarker;
  do {
    const r = await client.send(new ListMultipartUploadsCommand({
      Bucket: BUCKET, KeyMarker, UploadIdMarker
    }));
    if (r.Uploads) encontrados.push(...r.Uploads);
    KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
    UploadIdMarker = r.IsTruncated ? r.NextUploadIdMarker : undefined;
  } while (KeyMarker || UploadIdMarker);
  return encontrados;
}

async function main() {
  if (esLocal()) {
    console.log('Driver local: no hay multipart uploads que limpiar (los archivos van a disco).');
    return;
  }
  if (!process.env.WASABI_ACCESS_KEY) {
    console.error('Falta WASABI_ACCESS_KEY en .env');
    process.exit(1);
  }

  const uploads = await listarTodos();
  if (uploads.length === 0) {
    console.log(`Bucket ${BUCKET}: no hay multipart uploads incompletos.`);
    return;
  }

  const corte = Date.now() - HORAS * 60 * 60 * 1000;
  const antiguos = uploads.filter(u => new Date(u.Initiated).getTime() < corte);

  console.log(`Bucket ${BUCKET}: ${uploads.length} multipart upload(s) incompleto(s), ` +
              `${antiguos.length} con más de ${HORAS} h.`);
  for (const u of uploads) {
    const edadH = ((Date.now() - new Date(u.Initiated).getTime()) / 3600000).toFixed(1);
    const viejo = new Date(u.Initiated).getTime() < corte;
    console.log(`  ${viejo ? '[antiguo]' : '[reciente]'} ${u.Key} — iniciado hace ${edadH} h`);
  }

  if (!ABORTAR) {
    console.log('\nNada se ha borrado. Repite con --abortar para abortar los antiguos.');
    return;
  }

  let abortados = 0;
  for (const u of antiguos) {
    try {
      await client.send(new AbortMultipartUploadCommand({
        Bucket: BUCKET, Key: u.Key, UploadId: u.UploadId
      }));
      abortados++;
      console.log(`  abortado: ${u.Key}`);
    } catch (err) {
      console.warn(`  no se pudo abortar ${u.Key}: ${err.message}`);
    }
  }
  console.log(`\n${abortados} de ${antiguos.length} upload(s) abortado(s).`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

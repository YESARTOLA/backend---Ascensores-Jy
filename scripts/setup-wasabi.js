/**
 * Crea el bucket configurado en WASABI_BUCKET si no existe.
 * Se invoca manualmente: `node backend/scripts/setup-wasabi.js`.
 * Idempotente: si el bucket ya existe, no hace nada.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { asegurarBucket, BUCKET, REGION } = require('../utils/storage');

async function main() {
  if (!process.env.WASABI_ACCESS_KEY) {
    console.error('Falta WASABI_ACCESS_KEY en .env');
    process.exit(1);
  }
  console.log(`[setup-wasabi] región=${REGION} bucket=${BUCKET}`);
  try {
    const r = await asegurarBucket();
    if (r.creado) console.log(`[setup-wasabi] ✓ Bucket "${BUCKET}" creado.`);
    else console.log(`[setup-wasabi] ✓ Bucket "${BUCKET}" ya existía.`);
  } catch (err) {
    console.error('[setup-wasabi] ✗ Error:', err.message || err);
    process.exit(1);
  }
}

main();

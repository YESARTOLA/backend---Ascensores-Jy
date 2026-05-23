const multer = require('multer');

/**
 * Multer en modo memoria. El controlador que recibe el upload se encarga de
 * tomar `req.file.buffer` y enviarlo a Wasabi (ver `utils/storage.js`).
 *
 * No hay almacenamiento en disco — todo el ciclo del archivo vive primero en
 * memoria y termina en S3, evitando archivos huérfanos en el sistema de archivos
 * del backend.
 */

const TIPOS_VALIDOS = new Set([
  'guias',
  'evidencias',
  'comprobantes',
  'facturas',
  'entregas',
  'cotizaciones',
  'contratos',
  'ot',
  'documents'
]);
const TIPO_DEFECTO = 'documents';

function resolverTipo(req) {
  const crudo = (req.body?.tipo || req.params?.tipo || req.query?.tipo || TIPO_DEFECTO).toString();
  return TIPOS_VALIDOS.has(crudo) ? crudo : TIPO_DEFECTO;
}

/** Construye la key destino en S3: `uploads/<tipo>/<yyyy>/<mm>/<unique>.<ext>` */
function construirKey(tipo, originalname) {
  const path = require('path');
  const ahora = new Date();
  const anio = ahora.getFullYear();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const ext = path.extname(originalname);
  return `uploads/${tipo}/${anio}/${mes}/${unique}${ext}`;
}

// Default amplio para soportar videos de evidencias (override por env: UPLOAD_MAX_MB).
const TAMANO_MAX_MB = Number(process.env.UPLOAD_MAX_MB) || 200;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANO_MAX_MB * 1024 * 1024 }
});

module.exports = upload;
module.exports.upload = upload;
module.exports.TIPOS_VALIDOS = TIPOS_VALIDOS;
module.exports.TIPO_DEFECTO = TIPO_DEFECTO;
module.exports.resolverTipo = resolverTipo;
module.exports.construirKey = construirKey;

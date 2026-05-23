/**
 * Lectura de configuración del sistema desde tbl_configuracion.
 *
 * - Centraliza valores que antes podrían estar hardcodeados (IGV, validez por defecto,
 *   datos de empresa para PDF, etc.).
 * - Cache en memoria con TTL corto para no martillar la BD en cada request.
 * - Fallback a env vars y luego a defaults explícitos si la clave no existe en BD.
 */

const prisma = require('../config/prisma');

const TTL_MS = 60 * 1000;
const cache = new Map(); // clave -> { valor, hasta }

const DEFAULTS = Object.freeze({
  IGV_RATE: '0.18',
  COTIZACION_VALIDEZ_DIAS: '15',
  COTIZACION_TERMINOS: 'Cotización válida hasta la fecha indicada. Precios en soles, incluyen IGV. Forma de pago se acuerda al confirmar el servicio.',
  EMPRESA_RAZON_SOCIAL: 'Ascensores Jy S.A.C.',
  EMPRESA_RUC: '20000000000',
  EMPRESA_DIRECCION: 'Lima, Perú',
  EMPRESA_TELEFONO: '',
  EMPRESA_CORREO: '',
  CLIENTES_DIAS_AVISO_VENCIMIENTO_CONTRATO: '30',
  // Centro y zoom por defecto para el mapa de ubicación de clientes.
  // Lima Metropolitana (Plaza Mayor). Se leen tanto en el formulario de
  // creación/edición como en las vistas read-only cuando un cliente todavía
  // no tiene coordenadas registradas.
  MAPA_CENTRO_LAT: '-12.0464',
  MAPA_CENTRO_LNG: '-77.0428',
  MAPA_ZOOM_DEFAULT: '12'
});

const TIPOS = Object.freeze({
  IGV_RATE: 'number',
  COTIZACION_VALIDEZ_DIAS: 'number',
  COTIZACION_TERMINOS: 'string',
  EMPRESA_RAZON_SOCIAL: 'string',
  EMPRESA_RUC: 'string',
  EMPRESA_DIRECCION: 'string',
  EMPRESA_TELEFONO: 'string',
  EMPRESA_CORREO: 'string',
  CLIENTES_DIAS_AVISO_VENCIMIENTO_CONTRATO: 'number',
  MAPA_CENTRO_LAT: 'number',
  MAPA_CENTRO_LNG: 'number',
  MAPA_ZOOM_DEFAULT: 'number'
});

function ahora() {
  return Date.now();
}

function parsear(valor, tipo) {
  if (tipo === 'number') return Number(valor);
  if (tipo === 'boolean') return valor === 'true' || valor === '1';
  return String(valor);
}

async function obtener(clave) {
  const cached = cache.get(clave);
  if (cached && cached.hasta > ahora()) return cached.valor;

  let crudo;
  try {
    const fila = await prisma.tbl_configuracion.findUnique({ where: { clave } });
    if (fila && fila.estado === 1) crudo = fila.valor;
  } catch (err) {
    // Si la tabla no existe aún (antes del db push), seguimos con env/defaults
  }

  if (crudo === undefined) crudo = process.env[clave];
  if (crudo === undefined) crudo = DEFAULTS[clave];

  const tipo = TIPOS[clave] || 'string';
  const valor = parsear(crudo, tipo);
  cache.set(clave, { valor, hasta: ahora() + TTL_MS });
  return valor;
}

async function obtenerVarios(claves) {
  const out = {};
  for (const k of claves) out[k] = await obtener(k);
  return out;
}

function invalidar(clave) {
  if (clave) cache.delete(clave);
  else cache.clear();
}

/**
 * Asegura que las claves base existan en la BD. Se llama al boot del backend.
 * No sobreescribe valores ya configurados por el usuario.
 */
async function asegurarDefaults() {
  for (const [clave, valor] of Object.entries(DEFAULTS)) {
    try {
      await prisma.tbl_configuracion.upsert({
        where: { clave },
        update: {},
        create: {
          clave,
          valor,
          tipo: TIPOS[clave] || 'string',
          descripcion: null
        }
      });
    } catch (err) {
      // Si la tabla no existe (primera ejecución antes de db push), no rompe.
    }
  }
}

module.exports = {
  obtener,
  obtenerVarios,
  invalidar,
  asegurarDefaults,
  DEFAULTS,
  TIPOS
};

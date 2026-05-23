const prisma = require('../config/prisma');

/**
 * Genera un código correlativo para cotizaciones: COT-YYYY-NNNNNN.
 * Se cuenta sobre todas las cotizaciones del año (incluidas anuladas) para
 * que el código sea estable y nunca se reutilice.
 */
async function generarCodigoCotizacion() {
  const anio = new Date().getFullYear();
  const count = await prisma.tbl_cotizaciones.count({
    where: { codigo: { startsWith: `COT-${anio}-` } }
  });
  const correlativo = String(count + 1).padStart(6, '0');
  return `COT-${anio}-${correlativo}`;
}

module.exports = { generarCodigoCotizacion };

const prisma = require('../config/prisma');

/**
 * Genera un código correlativo para cotizaciones: COT-YYYY-NNNNNN.
 * Se basa en el MÁXIMO correlativo existente del año (incluidas anuladas), no
 * en el conteo: así el código nunca se reutiliza ni colisiona aunque haya
 * huecos por borrados (un conteo con huecos genera un número ya usado → viola
 * el unique de `codigo`). El relleno a 6 dígitos hace que el orden
 * lexicográfico descendente coincida con el numérico.
 */
async function generarCodigoCotizacion() {
  const anio = new Date().getFullYear();
  const ultima = await prisma.tbl_cotizaciones.findFirst({
    where: { codigo: { startsWith: `COT-${anio}-` } },
    orderBy: { codigo: 'desc' },
    select: { codigo: true }
  });
  const ultimoNum = ultima ? parseInt(ultima.codigo.split('-').pop(), 10) || 0 : 0;
  return `COT-${anio}-${String(ultimoNum + 1).padStart(6, '0')}`;
}

module.exports = { generarCodigoCotizacion };

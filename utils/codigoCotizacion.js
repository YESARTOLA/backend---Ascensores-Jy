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

/**
 * Condición Prisma del buscador por N.º de cotización. Acepta el número suelto
 * ("393", "000393"), con año ("2026-393") o el código completo
 * ("COT-2026-000393"). El número se compara EXACTO contra el correlativo y no
 * con `contains`: "39" no debe traer la 000393, ni "20" todas las del 2026.
 * Sin año trae ese número en todos los años. Cualquier otro texto (p.ej. el
 * código a medio escribir, "COT-2026") busca dentro del código.
 */
function whereNumeroCotizacion(texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const correlativo = (n) => String(Number(n)).padStart(6, '0');
  if (/^\d+$/.test(t)) return { codigo: { endsWith: `-${correlativo(t)}` } };
  const conAnio = t.match(/^(?:COT)?-?(\d{4})-(\d+)$/i);
  if (conAnio) return { codigo: `COT-${conAnio[1]}-${correlativo(conAnio[2])}` };
  return { codigo: { contains: t, mode: 'insensitive' } };
}

module.exports = { generarCodigoCotizacion, whereNumeroCotizacion };

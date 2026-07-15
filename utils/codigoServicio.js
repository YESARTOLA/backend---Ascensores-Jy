const prisma = require('../config/prisma');

/**
 * Genera un código correlativo para servicios/proyectos: SRV-YYYY-NNNNNN.
 * Se basa en el MÁXIMO correlativo existente del año (no en el conteo): así
 * tolera huecos por borrados sin reutilizar ni colisionar códigos (un conteo
 * con huecos genera un número ya usado → viola el unique de `codigo`).
 * Los códigos van con relleno a 6 dígitos, por lo que el orden lexicográfico
 * descendente coincide con el numérico.
 */
async function generarCodigoServicio(db = prisma) {
  // `db` puede ser el cliente global o una transacción. Pasar la transacción es
  // CLAVE cuando se generan varios códigos seguidos dentro de un mismo $transaction
  // (ej. N servicios por ascensor de un plan): así cada llamada ve los servicios
  // recién creados en la misma transacción y no colisiona el correlativo.
  const anio = new Date().getFullYear();
  const ultimo = await db.tbl_servicios_proyectos.findFirst({
    where: { codigo: { startsWith: `SRV-${anio}-` } },
    orderBy: { codigo: 'desc' },
    select: { codigo: true }
  });
  const ultimoNum = ultimo ? parseInt(ultimo.codigo.split('-').pop(), 10) || 0 : 0;
  return `SRV-${anio}-${String(ultimoNum + 1).padStart(6, '0')}`;
}

module.exports = { generarCodigoServicio };

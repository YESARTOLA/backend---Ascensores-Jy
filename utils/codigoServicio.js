const prisma = require('../config/prisma');

// Prefijo del código según el tipo de registro: los Proyectos usan 'PRY-' y los
// Servicios 'SRV-', para diferenciarlos a simple vista. El correlativo es
// INDEPENDIENTE por prefijo (cada uno lleva su propia secuencia anual).
const PREFIJO_POR_TIPO = { proyecto: 'PRY', servicio: 'SRV' };

/**
 * Genera un código correlativo para servicios/proyectos: {PRY|SRV}-YYYY-NNNNNN.
 * Se basa en el MÁXIMO correlativo existente del año PARA ESE PREFIJO (no en el
 * conteo): así tolera huecos por borrados sin reutilizar ni colisionar códigos
 * (un conteo con huecos genera un número ya usado → viola el unique de `codigo`).
 * Los códigos van con relleno a 6 dígitos, por lo que el orden lexicográfico
 * descendente coincide con el numérico.
 *
 * @param {'servicio'|'proyecto'} tipoRegistro  Deriva el prefijo (default: servicio).
 * @param {object} [client=prisma]  Cliente Prisma o transaccional (`tx`). Pasar el
 *   `tx` cuando se generan VARIOS códigos dentro de una misma transacción (p.ej. un
 *   plan de mantenimiento multi-ascensor: N servicios en un solo tx): así la
 *   consulta ve los servicios ya creados en el mismo tx y no repite el correlativo.
 */
async function generarCodigoServicio(tipoRegistro = 'servicio', client = prisma) {
  const prefijo = PREFIJO_POR_TIPO[tipoRegistro] || PREFIJO_POR_TIPO.servicio;
  const anio = new Date().getFullYear();
  const ultimo = await client.tbl_servicios_proyectos.findFirst({
    where: { codigo: { startsWith: `${prefijo}-${anio}-` } },
    orderBy: { codigo: 'desc' },
    select: { codigo: true }
  });
  const ultimoNum = ultimo ? parseInt(ultimo.codigo.split('-').pop(), 10) || 0 : 0;
  return `${prefijo}-${anio}-${String(ultimoNum + 1).padStart(6, '0')}`;
}

module.exports = { generarCodigoServicio };

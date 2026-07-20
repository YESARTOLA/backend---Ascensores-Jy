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
 */
async function generarCodigoServicio(tipoRegistro = 'servicio') {
  const prefijo = PREFIJO_POR_TIPO[tipoRegistro] || PREFIJO_POR_TIPO.servicio;
  const anio = new Date().getFullYear();
  const ultimo = await prisma.tbl_servicios_proyectos.findFirst({
    where: { codigo: { startsWith: `${prefijo}-${anio}-` } },
    orderBy: { codigo: 'desc' },
    select: { codigo: true }
  });
  const ultimoNum = ultimo ? parseInt(ultimo.codigo.split('-').pop(), 10) || 0 : 0;
  return `${prefijo}-${anio}-${String(ultimoNum + 1).padStart(6, '0')}`;
}

module.exports = { generarCodigoServicio };

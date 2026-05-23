const prisma = require('../config/prisma');

/**
 * Genera un código correlativo para servicios/proyectos: SRV-YYYY-NNNNNN
 */
async function generarCodigoServicio() {
  const anio = new Date().getFullYear();
  const count = await prisma.tbl_servicios_proyectos.count({
    where: { codigo: { startsWith: `SRV-${anio}-` } }
  });
  const correlativo = String(count + 1).padStart(6, '0');
  return `SRV-${anio}-${correlativo}`;
}

module.exports = { generarCodigoServicio };

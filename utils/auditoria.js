const prisma = require('../config/prisma');

async function registrarAuditoria({ id_usuario, entidad, id_entidad, accion, valor_anterior, valor_nuevo, ip }) {
  try {
    await prisma.tbl_auditoria.create({
      data: {
        id_usuario: id_usuario || null,
        entidad,
        id_entidad: id_entidad || null,
        accion,
        valor_anterior: valor_anterior || null,
        valor_nuevo: valor_nuevo || null,
        ip: ip || null
      }
    });
  } catch (err) {
    console.error('Error registrando auditoría:', err.message);
  }
}

module.exports = { registrarAuditoria };

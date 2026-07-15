const prisma = require('../config/prisma');

/**
 * Resuelve los datos de presentación (nombre + rol) de varios usuarios en una
 * sola consulta y devuelve un mapa { id -> usuario }.
 *
 * Varias tablas (tbl_auditoria, tbl_cotizaciones, tbl_cotizaciones_versiones)
 * guardan ids de usuario en columnas sueltas (user_id_registration,
 * aprobada_por, rechazada_por, id_usuario, …) SIN relación FK declarada en
 * Prisma, así que no se pueden `include`. Este helper centraliza la
 * hidratación para que todos los controllers la hagan igual y sin duplicar.
 *
 * @param {Array<number|null|undefined>} ids  ids crudos (admite repetidos/nulos)
 * @param {object} client  cliente Prisma o transaccional (`tx`); por defecto prisma
 * @returns {Promise<Object<number, {id,nombres,correo,rol}>>}
 */
async function mapaUsuariosPorId(ids, client = prisma) {
  const unicos = Array.from(new Set((ids || []).map(Number).filter(Boolean)));
  if (unicos.length === 0) return {};
  const usuarios = await client.tbl_usuarios.findMany({
    where: { id: { in: unicos } },
    select: {
      id: true,
      nombres: true,
      correo: true,
      rol: { select: { codigo: true, nombre: true } }
    }
  });
  return Object.fromEntries(usuarios.map(u => [u.id, u]));
}

module.exports = { mapaUsuariosPorId };

const prisma = require('../config/prisma');

/**
 * Autor de los registros del técnico (evidencias, guías de salida) que no
 * quedaron a nombre de un técnico.
 *
 * Estos registros se atribuyen al técnico que los cargó o, si los carga un rol
 * de gestión, al técnico asignado al servicio. Cuando el servicio todavía no
 * tiene técnico, `id_tecnico` queda NULL y el autor es el usuario que lo
 * registró (`user_id_registration`, que no tiene relación Prisma). Esta función
 * completa `usuario_registro: { id, nombres }` en esas filas para que la UI
 * tenga un nombre que mostrar en lugar de dejar el registro sin autor.
 *
 * Muta y devuelve el mismo arreglo.
 */
async function adjuntarAutorSinTecnico(filas, db = prisma) {
  const lista = filas || [];
  const ids = [...new Set(
    lista.filter(f => f.id_tecnico == null && f.user_id_registration).map(f => f.user_id_registration)
  )];
  if (ids.length === 0) return lista;
  const usuarios = await db.tbl_usuarios.findMany({
    where: { id: { in: ids } },
    select: { id: true, nombres: true }
  });
  const porId = new Map(usuarios.map(u => [u.id, u]));
  for (const f of lista) {
    if (f.id_tecnico == null) f.usuario_registro = porId.get(f.user_id_registration) || null;
  }
  return lista;
}

module.exports = { adjuntarAutorSinTecnico };

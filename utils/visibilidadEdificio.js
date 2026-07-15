/**
 * SSoT de VISIBILIDAD por estado de EDIFICIO.
 *
 * Cuando un edificio se inactiva (tbl_edificios.estado = 0), sus servicios,
 * proyectos y registros operativos (emergencias, correctivos, mantenimientos,
 * atención rápida) deben dejar de verse para TODOS los roles excepto el
 * Super Admin, que sigue viendo absolutamente todo. La inactivación solo oculta:
 * no borra ni desactiva los registros relacionados.
 *
 * Regla de ocultamiento (para roles distintos de super_admin):
 *   Un registro se oculta SOLO si tiene ascensores asociados Y ninguno de ellos
 *   pertenece a un edificio activo. Dicho de otro modo, se MUESTRA si:
 *     - no tiene ascensor asociado (no depende de ningún edificio), o
 *     - al menos uno de sus ascensores está en un edificio activo (estado = 1).
 *   Así un registro suelto (sin ascensor) nunca se oculta por esta regla.
 *
 * Toda la lógica de visibilidad por edificio vive aquí; no debe duplicarse ni
 * hardcodearse en los controladores.
 */

// Único rol que ve todo, incluidos los edificios inactivos y sus registros.
const ROL_VE_TODO = 'super_admin';

/** ¿Este usuario ve todo (no se le oculta nada por edificio inactivo)? */
function veTodoPorEdificio(user) {
  return !!user && user.rol_codigo === ROL_VE_TODO;
}

/**
 * Fragmento Prisma para entidades con relación N:M a ascensores vía junction
 * (tbl_servicios_proyectos → ascensores, tbl_mantenimientos_planes → ascensores).
 * `relacion` = nombre de la relación junction (cada fila tiene `estado` y
 * `ascensor.edificio.estado`).
 * Devuelve `{}` para super_admin (sin restricción) o cuando no hay usuario.
 */
function visibilidadPorJunctionWhere(user, relacion = 'ascensores') {
  if (veTodoPorEdificio(user)) return {};
  return {
    OR: [
      { [relacion]: { none: { estado: 1 } } },
      { [relacion]: { some: { estado: 1, ascensor: { edificio: { estado: 1 } } } } }
    ]
  };
}

/**
 * Fragmento Prisma para entidades con FK directa a un ascensor
 * (tbl_emergencias / tbl_correctivos: id_ascensor obligatorio;
 *  tbl_atenciones_rapidas: id_ascensor opcional).
 * `fk` = nombre del campo escalar; `relacion` = nombre de la relación al ascensor.
 * `permitirSinAscensor` agrega la rama "sin ascensor" (`{ fk: null }`): SOLO debe
 * activarse cuando el FK es OPCIONAL (atención rápida). En tablas con FK
 * obligatorio (emergencias/correctivos) filtrar `{ id_ascensor: null }` rompe
 * Prisma ("Argument `id_ascensor` must not be null"), así que por defecto se omite.
 * Devuelve `{}` para super_admin (sin restricción) o cuando no hay usuario.
 */
function visibilidadPorAscensorWhere(user, { fk = 'id_ascensor', relacion = 'ascensor', permitirSinAscensor = false } = {}) {
  if (veTodoPorEdificio(user)) return {};
  const cond = { [relacion]: { edificio: { estado: 1 } } };
  return permitirSinAscensor ? { OR: [{ [fk]: null }, cond] } : cond;
}

/**
 * Adjunta un fragmento de visibilidad al `where` existente bajo `AND`, sin pisar
 * los filtros previos (OR de búsqueda, relación servicio, etc.). No hace nada si
 * el fragmento está vacío (super_admin).
 */
function aplicarVisibilidadWhere(where, fragmento) {
  if (!fragmento || Object.keys(fragmento).length === 0) return where;
  where.AND = [...(where.AND || []), fragmento];
  return where;
}

/**
 * Predicado en memoria para un servicio/proyecto ya cargado con sus ascensores
 * activos incluidos (`ascensores[].ascensor.edificio.estado`). Útil en `obtener`
 * para devolver 404 cuando el registro queda oculto para un no-super_admin.
 */
function servicioVisiblePorEdificio(user, servicio) {
  if (veTodoPorEdificio(user)) return true;
  const vinculos = (servicio?.ascensores || []).filter(sa => sa.estado === 1);
  if (vinculos.length === 0) return true;
  return vinculos.some(sa => sa.ascensor?.edificio?.estado === 1);
}

module.exports = {
  veTodoPorEdificio,
  visibilidadPorJunctionWhere,
  visibilidadPorAscensorWhere,
  aplicarVisibilidadWhere,
  servicioVisiblePorEdificio,
};

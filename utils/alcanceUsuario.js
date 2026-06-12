/**
 * SSoT de ALCANCE de acceso por usuario (Servicios / Proyectos).
 *
 * Los roles Administrador y Coordinador pueden estar acotados a uno o ambos
 * ámbitos mediante los flags `acceso_servicios` / `acceso_proyectos` del usuario
 * (tbl_usuarios). El ámbito mapea 1:1 al `tipo_registro` de
 * tbl_servicios_proyectos: Servicios → 'servicio', Proyectos → 'proyecto'.
 *
 * A partir de ese mapeo, un usuario acotado solo ve:
 *   - clientes que tengan al menos un registro de su(s) ámbito(s),
 *   - ascensores de esos clientes,
 *   - servicios/proyectos y datos derivados de su(s) ámbito(s),
 *   - los módulos correspondientes (los demás se bloquean por ruta).
 *
 * El resto de roles (super_admin, contabilidad, tecnico) NO se filtra por ámbito.
 *
 * Toda la lógica de ámbito vive aquí; no debe duplicarse ni hardcodearse en los
 * controladores ni en las rutas.
 */

const { TIPO_REGISTRO } = require('./clasificacionServicio');

// Roles cuyo acceso se acota por los flags de ámbito. Único lugar donde se define.
const ROLES_CON_ALCANCE = ['admin', 'coordinador'];

// Centinela imposible para forzar "ningún resultado" cuando un usuario acotado
// quedara sin ámbitos (no debería ocurrir: se valida al crear/editar usuario).
const NINGUNO = ['__sin_ambito__'];

/** ¿El acceso de este usuario se filtra por ámbito? */
function aplicaAlcance(user) {
  return !!user && ROLES_CON_ALCANCE.includes(user.rol_codigo);
}

/**
 * Lista de `tipo_registro` que el usuario puede ver.
 *   - rol no acotado → null (sin restricción).
 *   - rol acotado    → subconjunto de ['servicio','proyecto'] según sus flags.
 * Un flag ausente (p.ej. token emitido antes de esta función) se interpreta
 * como habilitado (!= 0) para no bloquear sesiones existentes.
 */
function tiposRegistroPermitidos(user) {
  if (!aplicaAlcance(user)) return null;
  const tipos = [];
  if (Number(user.acceso_servicios) !== 0) tipos.push(TIPO_REGISTRO.SERVICIO);
  if (Number(user.acceso_proyectos) !== 0) tipos.push(TIPO_REGISTRO.PROYECTO);
  return tipos;
}

/** ¿El usuario puede ver registros de un `tipo_registro` dado? */
function puedeVerTipoRegistro(user, tipoRegistro) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return true;
  return tipos.includes(tipoRegistro);
}

/** Helper interno: `{ in: [...] }` con centinela si la lista quedó vacía. */
function inTipos(tipos) {
  return { in: tipos.length ? tipos : NINGUNO };
}

/** Fragmento Prisma para filtrar tbl_servicios_proyectos por ámbito. */
function servicioAlcanceWhere(user) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  return { tipo_registro: inTipos(tipos) };
}

/** Fragmento Prisma para tbl_clientes: solo clientes con registros del ámbito. */
function clienteAlcanceWhere(user) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  return { servicios: { some: { estado: 1, tipo_registro: inTipos(tipos) } } };
}

/** Fragmento Prisma para tbl_ascensores: solo ascensores de clientes del ámbito (vía edificio). */
function ascensorAlcanceWhere(user) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  return {
    edificio: { is: { cliente: { is: { servicios: { some: { estado: 1, tipo_registro: inTipos(tipos) } } } } } }
  };
}

/**
 * Fragmento Prisma para una relación cuyo path llega a un servicio/proyecto.
 * `relacion` es el nombre de la relación a tbl_servicios_proyectos (por defecto
 * 'servicio'). Útil para tbl_entregas, tbl_servicios_realizados, etc.
 */
function porServicioRelacionWhere(user, relacion = 'servicio') {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  return { [relacion]: { is: { tipo_registro: inTipos(tipos) } } };
}

/**
 * Middleware: exige que el usuario tenga el ámbito indicado para acceder al
 * módulo. `tipoRegistro` = 'servicio' | 'proyecto'.
 */
function requiereAlcance(tipoRegistro) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (puedeVerTipoRegistro(req.user, tipoRegistro)) return next();
    return res.status(403).json({ error: 'No tiene acceso a este módulo según su ámbito asignado' });
  };
}

module.exports = {
  ROLES_CON_ALCANCE,
  aplicaAlcance,
  tiposRegistroPermitidos,
  puedeVerTipoRegistro,
  servicioAlcanceWhere,
  clienteAlcanceWhere,
  ascensorAlcanceWhere,
  porServicioRelacionWhere,
  requiereAlcance,
};

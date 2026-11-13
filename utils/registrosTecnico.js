/**
 * REGLA ÚNICA: ¿quién puede corregir lo que el técnico registró en un servicio?
 *
 * Los registros del técnico son las evidencias (fotos y su comentario), las
 * guías de salida, la OT, las observaciones técnicas, el checklist de
 * finalización y el informe del cierre (observaciones, descargo).
 *
 * El técnico los carga en obra, muchas veces con prisa y desde el móvil. La
 * Oficina Técnica (coordinación) es quien revisa ese material antes de pasarlo
 * a Administración, así que necesita poder corregirlo: reemplazar una foto
 * ilegible, arreglar un comentario, completar un número de OT.
 *
 * VENTANA DE EDICIÓN según el rol:
 *  - Coordinación: hasta la revisión administrativa. `esServicioPostRevision`
 *    marca el punto donde el servicio entra en revisión, cobro, facturación o
 *    cierre; a partir de ahí el expediente se le congela.
 *  - Administración (admin y super admin): también DESPUÉS, con el servicio ya
 *    cobrado, facturado o cerrado. Es quien responde por el expediente y a
 *    veces hay que completarlo o corregirlo cuando ya se cerró.
 *  - Nadie: en un servicio Cancelado (el trabajo no se hizo).
 * Un servicio "Finalizado por técnico" u "observado" TODAVÍA es editable por
 * todos los roles de gestión — es el momento en el que la corrección tiene
 * sentido.
 *
 * Toda edición queda en la auditoría, así que el expediente sigue valiendo
 * como respaldo aunque se haya tocado después del cierre.
 */
const { esServicioPostRevision, ESTADO_SERVICIO_CANCELADO } = require('./estadoServicio');

// Roles que gestionan el expediente del servicio. El técnico tiene sus propias
// reglas (solo lo suyo y mientras trabaja), definidas en cada controlador.
const ROLES_GESTION = ['super_admin', 'admin', 'coordinador'];

// Roles que siguen editando el expediente con el servicio ya cerrado (revisado,
// en cobro, facturado o cerrado). Espejo del frontend (utils/estadoServicio.js).
const ROLES_EDICION_SERVICIO_CERRADO = ['super_admin', 'admin'];

/** ¿Este rol gestiona los registros del técnico (con independencia del estado)? */
function esRolGestion(user) {
  return ROLES_GESTION.includes(user?.rol_codigo);
}

/**
 * ¿Puede este usuario editar el expediente aunque el servicio esté cerrado?
 * Sí para Administración, salvo en un servicio Cancelado.
 */
function puedeEditarServicioCerrado(user, estadoServicio) {
  return ROLES_EDICION_SERVICIO_CERRADO.includes(user?.rol_codigo)
    && estadoServicio !== ESTADO_SERVICIO_CANCELADO;
}

/**
 * ¿El estado del servicio le congela el expediente a este usuario? Solo a partir
 * de la revisión administrativa, y nunca para Administración (salvo cancelado).
 * Para el técnico y para coordinación equivale a `esServicioPostRevision`.
 */
function expedienteCongelado(user, estadoServicio) {
  if (!esServicioPostRevision(estadoServicio)) return false;
  return !puedeEditarServicioCerrado(user, estadoServicio);
}

/**
 * ¿Puede este usuario crear/editar/eliminar registros del técnico en este
 * servicio ahora mismo?
 * @param {object} user     req.user
 * @param {object} servicio fila de tbl_servicios_proyectos (basta estado_servicio)
 */
function puedeGestionarRegistros(user, servicio) {
  if (!esRolGestion(user)) return false;
  return !expedienteCongelado(user, servicio?.estado_servicio);
}

/**
 * Mensaje de por qué no se puede, para devolverlo tal cual al cliente. Devuelve
 * null cuando sí se puede (así el llamador encadena: `const m = motivo(...); if (m) return 400`).
 */
function motivoBloqueo(user, servicio, accion = 'modificar estos registros') {
  if (!esRolGestion(user)) return `No tiene permiso para ${accion}`;
  const estado = servicio?.estado_servicio;
  if (!expedienteCongelado(user, estado)) return null;
  if (estado === ESTADO_SERVICIO_CANCELADO) {
    return `El servicio está ${estado}: no se puede ${accion}`;
  }
  return `El servicio está ${estado}: ya pasó la revisión administrativa, solo Administración puede ${accion}`;
}

module.exports = {
  ROLES_GESTION,
  ROLES_EDICION_SERVICIO_CERRADO,
  esRolGestion,
  puedeEditarServicioCerrado,
  expedienteCongelado,
  puedeGestionarRegistros,
  motivoBloqueo
};

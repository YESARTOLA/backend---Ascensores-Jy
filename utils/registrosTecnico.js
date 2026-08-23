/**
 * REGLA ÚNICA: ¿quién puede corregir lo que el técnico registró en un servicio?
 *
 * Los registros del técnico son las evidencias (fotos y su comentario), las
 * guías de salida, las observaciones técnicas, el checklist de finalización y
 * el informe del cierre (observaciones, descargo, N° de OT).
 *
 * El técnico los carga en obra, muchas veces con prisa y desde el móvil. La
 * Oficina Técnica (coordinación) es quien revisa ese material antes de pasarlo
 * a Administración, así que necesita poder corregirlo: reemplazar una foto
 * ilegible, arreglar un comentario, completar un número de OT.
 *
 * VENTANA DE EDICIÓN: hasta la revisión administrativa, no más allá.
 * `esServicioPostRevision` marca el punto donde el servicio entra en revisión,
 * cobro, facturación o cierre. A partir de ahí el material es el respaldo de
 * algo que ya se revisó y probablemente se facturó: se congela para todos, y
 * ese bloqueo es justamente lo que hace que el expediente valga como evidencia.
 * Un servicio "Finalizado por técnico" u "observado" TODAVÍA es editable — es
 * el momento en el que la corrección tiene sentido.
 */
const { esServicioPostRevision } = require('./estadoServicio');

// Roles que gestionan el expediente del servicio. El técnico tiene sus propias
// reglas (solo lo suyo y mientras trabaja), definidas en cada controlador.
const ROLES_GESTION = ['super_admin', 'admin', 'coordinador'];

/** ¿Este rol gestiona los registros del técnico (con independencia del estado)? */
function esRolGestion(user) {
  return ROLES_GESTION.includes(user?.rol_codigo);
}

/**
 * ¿Puede este usuario crear/editar/eliminar registros del técnico en este
 * servicio ahora mismo?
 * @param {object} user     req.user
 * @param {object} servicio fila de tbl_servicios_proyectos (basta estado_servicio)
 */
function puedeGestionarRegistros(user, servicio) {
  if (!esRolGestion(user)) return false;
  return !esServicioPostRevision(servicio?.estado_servicio);
}

/**
 * Mensaje de por qué no se puede, para devolverlo tal cual al cliente. Devuelve
 * null cuando sí se puede (así el llamador encadena: `const m = motivo(...); if (m) return 400`).
 */
function motivoBloqueo(user, servicio, accion = 'modificar estos registros') {
  if (!esRolGestion(user)) return `No tiene permiso para ${accion}`;
  if (esServicioPostRevision(servicio?.estado_servicio)) {
    return `El servicio está ${servicio.estado_servicio}: ya pasó la revisión administrativa, no se puede ${accion}`;
  }
  return null;
}

module.exports = {
  ROLES_GESTION,
  esRolGestion,
  puedeGestionarRegistros,
  motivoBloqueo
};

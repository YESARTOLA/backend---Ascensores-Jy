/**
 * Reglas de consistencia para la lista de técnicos asignados a un servicio.
 * Punto único de validación reutilizado por:
 *  - serviciosController.asignarTecnicos
 *  - emergenciasController.create
 *  - correctivosController.create
 *
 * Mantiene la regla "un solo responsable principal por servicio"
 * (Requerimientos.md §8.6 regla 4, §9.4 validación 3).
 */

function validarConsistenciaAsignaciones(tecnicos) {
  if (!Array.isArray(tecnicos) || tecnicos.length === 0) return { ok: true };

  if (tecnicos.some(t => !t.id_tecnico)) {
    return { ok: false, error: 'Seleccione técnico en todas las filas' };
  }
  const ids = tecnicos.map(t => Number(t.id_tecnico));
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: 'No puede asignar el mismo técnico más de una vez' };
  }
  if (tecnicos.length > 1 && !tecnicos.some(t => t.responsable_documentacion)) {
    return { ok: false, error: 'Si hay varios técnicos, debe marcar responsable documental' };
  }
  if (tecnicos.filter(t => t.responsable_principal).length > 1) {
    return { ok: false, error: 'Solo puede haber un técnico principal' };
  }
  return { ok: true };
}

module.exports = { validarConsistenciaAsignaciones };

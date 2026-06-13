/**
 * Matriz de visibilidad del calendario por rol — punto único de la verdad.
 *
 * - `operativos`: alcance sobre `tbl_calendario_eventos` (siempre operativos:
 *   servicio / mantenimiento / emergencia / correctivo).
 *     - 'todos'     → ve todos los eventos operativos
 *     - 'asignados' → ve solo los servicios con asignación activa al usuario
 *     - 'ninguno'   → no se consultan eventos operativos
 *
 * - `tipos_recordatorio`: subconjunto de `tbl_recordatorios.tipo` visibles.
 *   Valores posibles: 'servicio', 'mantenimiento', 'emergencia', 'cobro'.
 *
 * Espejado en `frontend/src/utils/visibilidadCalendario.js`.
 */
const VISIBILIDAD_POR_ROL = {
  super_admin:  { operativos: 'todos',     tipos_recordatorio: ['servicio', 'mantenimiento', 'emergencia', 'cobro', 'observacion', 'observacion_alerta', 'cotizacion_urgente', 'servicio_finalizado_revisar', 'servicio_finalizado_facturar', 'servicio_finalizado_aviso'] },
  admin:        { operativos: 'todos',     tipos_recordatorio: ['servicio', 'mantenimiento', 'emergencia', 'observacion', 'observacion_alerta', 'servicio_finalizado_aviso'] },
  coordinador:  { operativos: 'todos',     tipos_recordatorio: ['servicio', 'mantenimiento', 'emergencia', 'observacion', 'cotizacion_urgente', 'servicio_finalizado_revisar'] },
  tecnico:      { operativos: 'asignados', tipos_recordatorio: ['servicio', 'mantenimiento', 'emergencia'] },
  contabilidad: { operativos: 'todos',     tipos_recordatorio: ['cobro', 'observacion_alerta', 'servicio_finalizado_facturar'] },
  // La Vendedora ve TODA la agenda operativa (solo lectura) para validar la
  // disponibilidad de los técnicos al programar; sin recordatorios.
  vendedora:    { operativos: 'todos',     tipos_recordatorio: [] }
};

function incluyeOperativos(rol) {
  return VISIBILIDAD_POR_ROL[rol]?.operativos !== 'ninguno' && VISIBILIDAD_POR_ROL[rol] !== undefined;
}

function soloOperativosAsignados(rol) {
  return VISIBILIDAD_POR_ROL[rol]?.operativos === 'asignados';
}

function tiposRecordatorioPermitidos(rol) {
  return VISIBILIDAD_POR_ROL[rol]?.tipos_recordatorio || [];
}

/**
 * Color por defecto para cada tipo de evento/recordatorio. Espejado en el
 * catálogo del frontend (`CATALOGO_TIPOS_EVENTO`). Se usa cuando el registro
 * en BD no tiene `color` propio.
 */
const COLOR_POR_TIPO = {
  servicio: '#0ea5e9',
  proyecto: '#1e40af',
  mantenimiento: '#22c55e',
  emergencia: '#ef4444',
  correctivo: '#f59e0b',
  cobro: '#8b5cf6',
  observacion: '#f97316',
  observacion_alerta: '#dc2626',
  cotizacion_urgente: '#dc2626',
  servicio_finalizado_revisar: '#f59e0b',
  servicio_finalizado_facturar: '#8b5cf6',
  servicio_finalizado_aviso: '#0ea5e9'
};

function colorPorTipo(tipo) {
  return COLOR_POR_TIPO[tipo] || COLOR_POR_TIPO.servicio;
}

/**
 * id_tecnico cuando el rol del usuario es de tipo "solo asignados" (técnico),
 * o null para roles que ven todo. El -1 fallback evita matches espurios si el
 * usuario técnico no tiene id_tecnico asociado.
 */
function idTecnicoFiltro(user) {
  if (!user) return null;
  if (!soloOperativosAsignados(user.rol_codigo)) return null;
  return user.id_tecnico || -1;
}

/**
 * Cláusula Prisma para "el servicio relacionado tiene asignación activa al
 * técnico". Devuelve `null` cuando el rol no requiere filtro. Pensada para
 * embeberse en `where.servicio = ...` de listados de emergencias / correctivos
 * / instancias de mantenimiento.
 */
function whereServicioAsignadoSiTecnico(user) {
  const idTec = idTecnicoFiltro(user);
  if (idTec === null) return null;
  return { asignaciones: { some: { id_tecnico: idTec, estado: 1 } } };
}

/**
 * Cláusula Prisma para "el plan de mantenimiento tiene al menos un servicio
 * generado donde el técnico tiene asignación activa". Devuelve `null` cuando
 * el rol no requiere filtro. Para el listado de planes de mantenimiento.
 */
function whereServicioGeneradoAsignadoSiTecnico(user) {
  const idTec = idTecnicoFiltro(user);
  if (idTec === null) return null;
  return {
    some: {
      estado: 1,
      asignaciones: { some: { id_tecnico: idTec, estado: 1 } }
    }
  };
}

module.exports = {
  VISIBILIDAD_POR_ROL,
  COLOR_POR_TIPO,
  incluyeOperativos,
  soloOperativosAsignados,
  tiposRecordatorioPermitidos,
  colorPorTipo,
  idTecnicoFiltro,
  whereServicioAsignadoSiTecnico,
  whereServicioGeneradoAsignadoSiTecnico
};

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
 *   Incluye 'manual' (recordatorios creados a mano por el usuario) para los
 *   roles que gestionan la agenda; sin él quedarían invisibles en lista y mes.
 *   NO incluye 'servicio': ese tipo genérico es redundante con los módulos
 *   específicos (emergencia, correctivo, mantenimiento, atención rápida), que ya
 *   son servicios; sus recordatorios se ocultan en lista, mes y contadores.
 *
 * Espejado en `frontend/src/utils/visibilidadCalendario.js`.
 */
const VISIBILIDAD_POR_ROL = {
  super_admin:  { operativos: 'todos',     tipos_recordatorio: ['manual', 'mantenimiento', 'emergencia', 'cobro', 'observacion', 'observacion_alerta', 'cotizacion_urgente', 'servicio_finalizado_revisar', 'servicio_finalizado_facturar', 'servicio_finalizado_aviso', 'correctivo_gratuito'] },
  admin:        { operativos: 'todos',     tipos_recordatorio: ['manual', 'mantenimiento', 'emergencia', 'observacion', 'observacion_alerta', 'cotizacion_urgente', 'servicio_finalizado_revisar', 'servicio_finalizado_facturar', 'servicio_finalizado_aviso', 'correctivo_gratuito'] },
  coordinador:  { operativos: 'todos',     tipos_recordatorio: ['manual', 'mantenimiento', 'emergencia', 'observacion', 'observacion_alerta', 'cotizacion_urgente', 'servicio_finalizado_revisar'] },
  tecnico:      { operativos: 'asignados', tipos_recordatorio: ['mantenimiento', 'emergencia'] },
  // Contabilidad recibe SOLO el aviso sin detalle (observacion_facturar), no la
  // alerta con el texto/imagen (observacion_alerta).
  contabilidad: { operativos: 'todos',     tipos_recordatorio: ['manual', 'cobro', 'observacion_facturar', 'servicio_finalizado_facturar'] },
  // La Vendedora ve la agenda operativa (solo lectura) para validar la
  // disponibilidad de los técnicos al programar y recibe la alerta de
  // observación técnica (con detalle) para armar la cotización.
  vendedora:    { operativos: 'todos',     tipos_recordatorio: ['observacion_alerta'] }
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
  observacion_facturar: '#0891b2',
  cotizacion_urgente: '#dc2626',
  servicio_finalizado_revisar: '#f59e0b',
  servicio_finalizado_facturar: '#8b5cf6',
  servicio_finalizado_aviso: '#0ea5e9',
  correctivo_gratuito: '#b45309'
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

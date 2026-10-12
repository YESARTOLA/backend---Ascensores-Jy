/**
 * Deriva la información de ejecución de un servicio a partir de su historial
 * de estados y registro de realizado. Centraliza la lógica para que Emergencias,
 * Mantenimientos y cualquier otro consumidor obtengan los mismos resultados.
 *
 * Estados terminales de "Realizado": cubre todos los que indican que el técnico
 * cerró el trabajo (independiente de revisión administrativa o cobro posterior).
 */

const ESTADOS_INICIO = ['En curso'];
const ESTADOS_FIN = [
  'Finalizado',
  'En revisión administrativa',
  'A gestión de cobro',
  'En cobro',
  'Cobrado parcial',
  'Cobrado total',
  'Facturado',
  'Cerrado'
];
const ESTADO_CANCELADO = 'Cancelado';

function estadoEjecucion(estadoServicio) {
  if (!estadoServicio) return 'Pendiente';
  if (estadoServicio === ESTADO_CANCELADO) return 'Cancelado';
  if (ESTADOS_FIN.includes(estadoServicio)) return 'Realizado';
  if (ESTADOS_INICIO.includes(estadoServicio)) return 'En curso';
  return 'Pendiente';
}

function primeraFechaHaciaEstado(historial, estadosObjetivo) {
  if (!Array.isArray(historial) || historial.length === 0) return null;
  const aceptable = new Set(estadosObjetivo);
  const matches = historial
    .filter(h => aceptable.has(h.estado_nuevo))
    .sort((a, b) => new Date(a.fecha_cambio) - new Date(b.fecha_cambio));
  return matches.length > 0 ? matches[0].fecha_cambio : null;
}

/**
 * INICIO real de la ejecución: la primera vez que el servicio pasó a "En curso"
 * (columna "Inicio" de Mantenimientos). `servicio.historial_estados` debe venir
 * solo con registros activos (estado: 1), p. ej. con INCLUDE_HISTORIAL_INICIO.
 */
function fechaInicioReal(servicio) {
  return primeraFechaHaciaEstado(servicio?.historial_estados, ESTADOS_INICIO);
}

// Relación `historial_estados` mínima para `fechaInicioReal`: solo el primer
// paso activo a "En curso".
const INCLUDE_HISTORIAL_INICIO = {
  where: { estado: 1, estado_nuevo: { in: ESTADOS_INICIO } },
  orderBy: [{ fecha_cambio: 'asc' }, { id: 'asc' }],
  take: 1,
  select: { estado_nuevo: true, fecha_cambio: true }
};

/**
 * Condición Prisma sobre el SERVICIO: su inicio (`fechaInicioReal`) cae entre
 * `desde` y `hasta` (Date; extremos opcionales e inclusivos). Null si no hay
 * rango. Un servicio que aún no arrancó no tiene inicio y no entra.
 */
function whereInicioEnRango({ desde, hasta }) {
  if (!desde && !hasta) return null;
  const inicio = { estado_nuevo: { in: ESTADOS_INICIO }, estado: 1 };
  const rango = { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) };
  return {
    historial_estados: {
      some: { ...inicio, fecha_cambio: rango },
      // Cuenta el PRIMER arranque: un servicio que ya había empezado antes del
      // rango no entra aunque se haya reanudado dentro de él.
      ...(desde ? { none: { ...inicio, fecha_cambio: { lt: desde } } } : {})
    }
  };
}

function diferenciaDias(inicio, fin) {
  if (!inicio || !fin) return null;
  const ms = new Date(fin).getTime() - new Date(inicio).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round((ms / 86400000) * 10) / 10;
}

/**
 * @param {object} servicio  Servicio incluyendo `historial_estados` y
 *                           opcionalmente `servicio_realizado`.
 * @returns {{
 *   estado_ejecucion: 'Pendiente'|'En curso'|'Realizado'|'Cancelado',
 *   fecha_inicio_real: string|null,
 *   fecha_fin_real:    string|null,
 *   dias_ejecucion:    number|null
 * }}
 */
function derivarEjecucion(servicio) {
  if (!servicio) {
    return { estado_ejecucion: 'Pendiente', fecha_inicio_real: null, fecha_fin_real: null, dias_ejecucion: null };
  }
  const historial = servicio.historial_estados || [];
  const fechaInicio = fechaInicioReal(servicio);
  const fechaFinPorHistorial = primeraFechaHaciaEstado(historial, ['Finalizado']);
  const fechaFin = fechaFinPorHistorial || servicio.servicio_realizado?.fecha_realizacion || null;
  return {
    estado_ejecucion: estadoEjecucion(servicio.estado_servicio),
    fecha_inicio_real: fechaInicio,
    fecha_fin_real: fechaFin,
    dias_ejecucion: diferenciaDias(fechaInicio, fechaFin)
  };
}

module.exports = {
  derivarEjecucion,
  fechaInicioReal,
  INCLUDE_HISTORIAL_INICIO,
  whereInicioEnRango,
  estadoEjecucion,
  ESTADOS_INICIO,
  ESTADOS_FIN,
  ESTADO_CANCELADO
};

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
  const fechaInicio = primeraFechaHaciaEstado(historial, ESTADOS_INICIO);
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
  estadoEjecucion,
  ESTADOS_INICIO,
  ESTADOS_FIN,
  ESTADO_CANCELADO
};

// "Fecha servicio" de Contabilidad y de Facturas: criterio ÚNICO para la fecha
// que se muestra en cada fila (`fechaServicioContable`) y para el filtro por
// rango (`whereFechaServicioEnRango`), así el filtro trae exactamente lo que la
// columna dice.
//
// Es la fecha en que se REALIZÓ el servicio, la misma regla para todos
// (mantenimiento, correctivo, emergencia, proyecto…): el inicio real de su
// ejecución, la de la columna "Inicio" de los módulos operativos — el primer
// paso del servicio a "En curso" (`fechaInicioReal`, utils/ejecucionFechas.js).
// Si aún no arrancó, no tiene.
//
// No se usa la aprobación de la cotización (es cuándo se vendió, no cuándo se
// hizo) ni `fecha_realizacion` del realizado: en correctivos ese registro nace
// al aprobarse la cotización, antes de ejecutar el trabajo.

const { parseYMDLima, parseYMDFinDiaLima } = require('./tiempo');
const { fechaInicioReal, INCLUDE_HISTORIAL_INICIO, whereInicioEnRango } = require('./ejecucionFechas');

/**
 * @param {object} servicio  tbl_servicios_proyectos con
 *   `historial_estados: INCLUDE_HISTORIAL_INICIO`.
 * @returns {Date|null}
 */
function fechaServicioContable(servicio) {
  return fechaInicioReal(servicio);
}

/**
 * Condición Prisma sobre tbl_servicios_realizados: "Fecha servicio" entre
 * `desde` y `hasta` (YYYY-MM-DD, días de Lima; extremos opcionales e
 * inclusivos). Null si no se pidió rango.
 */
function whereFechaServicioEnRango({ desde, hasta }) {
  const inicioEnRango = whereInicioEnRango({
    desde: desde ? parseYMDLima(desde) : null,
    hasta: hasta ? parseYMDFinDiaLima(hasta) : null
  });
  return inicioEnRango ? { servicio: inicioEnRango } : null;
}

module.exports = {
  INCLUDE_HISTORIAL_INICIO,
  fechaServicioContable,
  whereFechaServicioEnRango
};

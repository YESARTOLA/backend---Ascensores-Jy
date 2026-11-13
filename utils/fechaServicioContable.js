// "Fecha servicio" de Contabilidad y de Gestión de cobros: criterio ÚNICO para
// las fechas que se muestran en cada fila y para el filtro por rango, así el
// filtro trae exactamente lo que la columna dice. La columna lleva DOS fechas
// del servicio (pedido de la usuaria, 12/11/2026):
//
//  - Programación (la principal, la que filtra el rango "Fecha de servicio"):
//    `tbl_servicios_proyectos.fecha_programada`, el primer día programado del
//    servicio (lo deriva de su grilla de días utils/diasServicio). Es un día
//    puro (@db.Date). Sin programar → sin fecha.
//  - Ejecución (debajo, más pequeña, solo si ya se ejecutó): el inicio real
//    del trabajo, la columna "Inicio" de los módulos operativos — el primer
//    paso del servicio a "En curso" (`fechaInicioReal`, utils/ejecucionFechas.js).
//
// No se usa la aprobación de la cotización (es cuándo se vendió) ni
// `fecha_realizacion` del realizado: en correctivos ese registro nace al
// aprobarse la cotización, antes de ejecutar el trabajo.
//
// Facturas sigue mostrando en su "Fecha servicio" la de ejecución
// (`fechaServicioContable`, vía utils/fechasContables.js).

const { parseYMDUTC } = require('./tiempo');
const { fechaInicioReal, INCLUDE_HISTORIAL_INICIO } = require('./ejecucionFechas');

/**
 * Fecha de programación del servicio (día puro, @db.Date) o null.
 * @param {object} servicio  tbl_servicios_proyectos con `fecha_programada`.
 */
function fechaProgramacionServicio(servicio) {
  return servicio?.fecha_programada || null;
}

/**
 * Fecha de ejecución del servicio: su inicio real, o null si aún no arrancó.
 * @param {object} servicio  tbl_servicios_proyectos con
 *   `historial_estados: INCLUDE_HISTORIAL_INICIO`.
 * @returns {Date|null}
 */
function fechaEjecucionServicio(servicio) {
  return fechaInicioReal(servicio);
}

/**
 * Las dos fechas de la columna, listas para la fila.
 * @returns {{ fecha_programacion: Date|null, fecha_ejecucion: Date|null }}
 */
function fechasServicioContable(servicio) {
  return {
    fecha_programacion: fechaProgramacionServicio(servicio),
    fecha_ejecucion: fechaEjecucionServicio(servicio)
  };
}

// "Fecha servicio" de Facturas: la de ejecución (ver arriba).
const fechaServicioContable = fechaEjecucionServicio;

/**
 * Condición Prisma sobre tbl_servicios_realizados: la fecha de PROGRAMACIÓN del
 * servicio entre `desde` y `hasta` (YYYY-MM-DD; extremos opcionales e
 * inclusivos). Es un @db.Date, así que los límites van a medianoche UTC
 * (parseYMDUTC). Null si no se pidió rango; un servicio sin programar no entra.
 */
function whereFechaServicioEnRango({ desde, hasta }) {
  const gte = desde ? parseYMDUTC(desde) : null;
  const lte = hasta ? parseYMDUTC(hasta) : null;
  if (!gte && !lte) return null;
  return {
    servicio: {
      fecha_programada: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) }
    }
  };
}

module.exports = {
  INCLUDE_HISTORIAL_INICIO,
  fechaProgramacionServicio,
  fechaEjecucionServicio,
  fechasServicioContable,
  fechaServicioContable,
  whereFechaServicioEnRango
};

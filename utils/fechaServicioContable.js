// "Fecha servicio" de Contabilidad: criterio ÚNICO para la fecha que se muestra
// en cada fila (`fechaServicioContable`) y para el filtro por rango
// (`whereFechaServicioEnRango`), así el filtro trae exactamente lo que la
// columna dice.
//
//  - Mantenimiento (servicio de un plan o de un subtipo del módulo de
//    mantenimiento): la fecha REAL en que se ejecutó, la misma de la columna
//    "Inicio" del módulo de Mantenimientos — el primer paso del servicio a
//    "En curso" (`fechaInicioReal`, utils/ejecucionFechas.js). Si aún no
//    arrancó, no tiene.
//  - Correctivo y cualquier otro: la fecha de APROBACIÓN de su cotización. Sin
//    cotización aprobada (servicio directo, emergencia no cotizada) no existe
//    esa fecha y se usa la de ejecución (`fecha_realizacion` del realizado).

const { parseYMDLima, parseYMDFinDiaLima } = require('./tiempo');
const { ESTADOS_VERSION, whereAprobadaEnRango } = require('./estadoCotizacion');
const { ESTADO_ADMIN_EN_EJECUCION } = require('./estadoServicio');
const { fechaInicioReal, INCLUDE_HISTORIAL_INICIO, whereInicioEnRango } = require('./ejecucionFechas');

const ORIGEN_INICIO = 'inicio';
const ORIGEN_APROBACION = 'aprobacion';
const ORIGEN_SIN_COTIZACION = 'sin_cotizacion';

// Mismo criterio que el filtro "Preventivo" más las visitas de plan.
const WHERE_SERVICIO_MANTENIMIENTO = {
  OR: [{ id_mantenimiento_plan: { not: null } }, { tipo_servicio: { modulo_asociado: 'mantenimiento' } }]
};

const esServicioMantenimiento = (servicio) =>
  !!servicio?.id_mantenimiento_plan || servicio?.tipo_servicio?.modulo_asociado === 'mantenimiento';

const WHERE_VERSION_APROBADA = {
  estado: 1, estado_version: ESTADOS_VERSION.APROBADO, fecha_aprobacion: { not: null }
};

// Relación `cotizacion` a incluir en el servicio del realizado: solo la fecha de
// la versión aprobada más reciente (la que lee `fechaServicioContable`).
const INCLUDE_COTIZACION_APROBACION = {
  select: {
    versiones: {
      where: WHERE_VERSION_APROBADA,
      orderBy: [{ fecha_aprobacion: 'desc' }, { numero_version: 'desc' }],
      take: 1,
      select: { fecha_aprobacion: true }
    }
  }
};

/**
 * @param {object} realizado  tbl_servicios_realizados con `servicio` (incluye
 *   tipo_servicio, cotizacion: INCLUDE_COTIZACION_APROBACION e
 *   historial_estados: INCLUDE_HISTORIAL_INICIO).
 * @returns {{ fecha: Date|null, origen: 'inicio'|'aprobacion'|'sin_cotizacion' }}
 */
function fechaServicioContable(realizado) {
  const servicio = realizado?.servicio;
  if (esServicioMantenimiento(servicio)) return { fecha: fechaInicioReal(servicio), origen: ORIGEN_INICIO };
  const aprobacion = servicio?.cotizacion?.versiones?.[0]?.fecha_aprobacion || null;
  if (aprobacion) return { fecha: aprobacion, origen: ORIGEN_APROBACION };
  const ejecucion = realizado?.estado_administrativo === ESTADO_ADMIN_EN_EJECUCION
    ? null
    : (realizado?.fecha_realizacion || null);
  return { fecha: ejecucion, origen: ORIGEN_SIN_COTIZACION };
}

/**
 * Condición Prisma sobre tbl_servicios_realizados: "Fecha servicio" entre
 * `desde` y `hasta` (YYYY-MM-DD, días de Lima; extremos opcionales e
 * inclusivos). Null si no se pidió rango.
 */
function whereFechaServicioEnRango({ desde, hasta }) {
  if (!desde && !hasta) return null;
  const fecha_realizacion = {};
  if (desde) fecha_realizacion.gte = parseYMDLima(desde);
  if (hasta) fecha_realizacion.lte = parseYMDFinDiaLima(hasta);
  const ejecutadoEnRango = { fecha_realizacion, estado_administrativo: { not: ESTADO_ADMIN_EN_EJECUCION } };
  const inicioEnRango = whereInicioEnRango({
    desde: desde ? parseYMDLima(desde) : null,
    hasta: hasta ? parseYMDFinDiaLima(hasta) : null
  });
  const noMantenimiento = { NOT: WHERE_SERVICIO_MANTENIMIENTO };
  return {
    OR: [
      { servicio: { ...WHERE_SERVICIO_MANTENIMIENTO, ...inicioEnRango } },
      { servicio: { ...noMantenimiento, cotizacion: { is: whereAprobadaEnRango({ desde, hasta }) } } },
      {
        ...ejecutadoEnRango,
        servicio: {
          ...noMantenimiento,
          OR: [{ id_cotizacion: null }, { cotizacion: { is: { versiones: { none: WHERE_VERSION_APROBADA } } } }]
        }
      }
    ]
  };
}

module.exports = {
  INCLUDE_COTIZACION_APROBACION,
  INCLUDE_HISTORIAL_INICIO,
  fechaServicioContable,
  whereFechaServicioEnRango
};

// "Fecha servicio" de Contabilidad: criterio ÚNICO para la fecha que se muestra
// en cada fila (`fechaServicioContable`) y para el filtro por rango
// (`whereFechaServicioEnRango`), así el filtro trae exactamente lo que la
// columna dice.
//
//  - Mantenimiento (servicio de un plan o de un subtipo del módulo de
//    mantenimiento): la fecha de EJECUCIÓN, `fecha_realizacion` del realizado
//    (se fija cuando el técnico finaliza). Mientras siga 'En ejecución' no tiene.
//  - Correctivo y cualquier otro: la fecha de APROBACIÓN de su cotización. Sin
//    cotización aprobada (servicio directo, emergencia no cotizada) no existe
//    esa fecha y se usa la de ejecución.

const { parseYMDLima, parseYMDFinDiaLima } = require('./tiempo');
const { ESTADOS_VERSION, whereAprobadaEnRango } = require('./estadoCotizacion');
const { ESTADO_ADMIN_EN_EJECUCION } = require('./estadoServicio');

const ORIGEN_EJECUCION = 'ejecucion';
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
 *   tipo_servicio y cotizacion: INCLUDE_COTIZACION_APROBACION).
 * @returns {{ fecha: Date|null, origen: 'ejecucion'|'aprobacion'|'sin_cotizacion' }}
 */
function fechaServicioContable(realizado) {
  const servicio = realizado?.servicio;
  const ejecucion = realizado?.estado_administrativo === ESTADO_ADMIN_EN_EJECUCION
    ? null
    : (realizado?.fecha_realizacion || null);
  if (esServicioMantenimiento(servicio)) return { fecha: ejecucion, origen: ORIGEN_EJECUCION };
  const aprobacion = servicio?.cotizacion?.versiones?.[0]?.fecha_aprobacion || null;
  if (aprobacion) return { fecha: aprobacion, origen: ORIGEN_APROBACION };
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
  const noMantenimiento = { NOT: WHERE_SERVICIO_MANTENIMIENTO };
  return {
    OR: [
      { ...ejecutadoEnRango, servicio: WHERE_SERVICIO_MANTENIMIENTO },
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
  fechaServicioContable,
  whereFechaServicioEnRango
};

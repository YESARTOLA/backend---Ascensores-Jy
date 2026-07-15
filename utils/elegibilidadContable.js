/**
 * REGLA ÚNICA DE ELEGIBILIDAD CONTABLE
 * =====================================================================
 * Fuente de verdad para responder: ¿este servicio está habilitado para que
 * Contabilidad registre cobros y emita comprobantes?
 *
 * La existencia de un servicio NO basta. La elegibilidad depende del ORIGEN y
 * del estado alcanzado en su flujo operativo. Hay dos flujos:
 *
 *  FLUJO 1 — Servicios originados desde una COTIZACIÓN (id_cotizacion != null):
 *    Quedan habilitados en cuanto la cotización aprobada se CONVIERTE
 *    efectivamente en servicio (el servicio existe). No exigen finalización
 *    técnica ni revisión administrativa previa para cobrar/facturar.
 *
 *  FLUJO 2 — Servicios OPERATIVOS para ascensores (mantenimiento, correctivo,
 *    emergencia, directo): solo quedan habilitados cuando Administración
 *    APRUEBA la revisión (estado_administrativo = 'Revisado'). Mientras estén
 *    pendientes, en ejecución, finalizados-por-técnico-sin-revisar, observados
 *    o rechazados, NO son elegibles.
 *
 *  Excluye siempre los servicios cancelados/anulados.
 *
 * Esta regla DEBE usarse en todos los puntos que decidan cobrar/facturar o que
 * listen servicios facturables (facturas, cobros, reportes, dashboard, CxC).
 * No dupliques la lógica: importa `elegibilidadContable` (evaluación en memoria)
 * o `whereElegibleContable` (filtro Prisma sobre tbl_servicios_realizados).
 */

const {
  ESTADO_ADMIN_EN_EJECUCION,
  ESTADO_ADMIN_OBSERVADO,
  ESTADO_ADMIN_RECHAZADO,
  ESTADO_ADMIN_PENDIENTE_REVISION
} = require('./estadoServicio');

const ESTADO_SERVICIO_CANCELADO = 'Cancelado';

/**
 * Estados administrativos PREVIOS a la aprobación: mientras un servicio
 * operativo esté en cualquiera de estos, NO está habilitado para Contabilidad.
 * Cualquier otro estado (Revisado o posterior) implica que ya fue aprobado.
 * 'En ejecución' aplica solo a operativos — los de cotización se habilitan
 * por su origen antes de mirar este campo.
 */
const ESTADOS_ADMIN_NO_HABILITA = [
  ESTADO_ADMIN_EN_EJECUCION,
  ESTADO_ADMIN_PENDIENTE_REVISION,
  ESTADO_ADMIN_OBSERVADO,
  ESTADO_ADMIN_RECHAZADO
];

const ORIGEN_COTIZACION = 'cotizacion';
const ORIGEN_OPERATIVO = 'operativo';

/**
 * Evalúa la elegibilidad contable de un servicio a partir de los datos en
 * memoria. Acepta el servicio (tbl_servicios_proyectos) y, opcionalmente, su
 * servicio_realizado (para leer estado_administrativo). Tolera recibir el
 * servicio_realizado con su `servicio` anidado.
 *
 * @param {object} args
 * @param {object} [args.servicio]          Fila de tbl_servicios_proyectos.
 * @param {object} [args.servicioRealizado] Fila de tbl_servicios_realizados.
 * @returns {{ habilitado: boolean, origen: string, motivo: string|null, estado_administrativo: string|null }}
 */
function elegibilidadContable({ servicio, servicioRealizado } = {}) {
  const srv = servicio || servicioRealizado?.servicio || null;
  const realizado = servicioRealizado || servicio?.servicio_realizado || null;

  if (!srv) {
    return { habilitado: false, origen: null, motivo: 'El servicio no existe o no fue convertido.', estado_administrativo: null };
  }

  const estadoAdmin = realizado?.estado_administrativo ?? null;

  // Anulado / cancelado: nunca elegible.
  if (srv.estado === 0 || srv.estado_servicio === ESTADO_SERVICIO_CANCELADO) {
    return { habilitado: false, origen: srv.id_cotizacion ? ORIGEN_COTIZACION : ORIGEN_OPERATIVO, motivo: 'Servicio anulado o cancelado.', estado_administrativo: estadoAdmin };
  }

  // FLUJO 1: originado desde cotización → habilitado por conversión efectiva.
  if (srv.id_cotizacion) {
    return { habilitado: true, origen: ORIGEN_COTIZACION, motivo: null, estado_administrativo: estadoAdmin };
  }

  // FLUJO 2: operativo → requiere aprobación administrativa (Revisado o posterior).
  if (estadoAdmin && !ESTADOS_ADMIN_NO_HABILITA.includes(estadoAdmin)) {
    return { habilitado: true, origen: ORIGEN_OPERATIVO, motivo: null, estado_administrativo: estadoAdmin };
  }

  const motivoPorEstado = {
    [ESTADO_ADMIN_OBSERVADO]: 'El servicio fue observado en la revisión administrativa; debe corregirse.',
    [ESTADO_ADMIN_RECHAZADO]: 'El servicio fue rechazado en la revisión administrativa.',
    [ESTADO_ADMIN_PENDIENTE_REVISION]: 'El servicio está pendiente de revisión administrativa.'
  };
  const motivo = motivoPorEstado[estadoAdmin]
    || 'El servicio operativo aún no fue aprobado por la revisión administrativa.';

  return { habilitado: false, origen: ORIGEN_OPERATIVO, motivo, estado_administrativo: estadoAdmin };
}

/** Atajo booleano. */
function esElegibleContable(args) {
  return elegibilidadContable(args).habilitado;
}

/**
 * Fragmento de filtro Prisma (where) que selecciona, sobre
 * tbl_servicios_realizados, únicamente los servicios ELEGIBLES para
 * contabilidad — la traducción a consulta de la misma regla de arriba.
 *
 * Combínalo con el resto del where del consumidor:
 *   const where = { estado: 1, ...whereElegibleContable() };
 */
function whereElegibleContable() {
  return {
    // Excluir servicios cancelados (vía relación con el servicio).
    servicio: { is: { estado_servicio: { not: ESTADO_SERVICIO_CANCELADO } } },
    OR: [
      // Flujo 1: cualquier servicio originado desde cotización.
      { servicio: { is: { id_cotizacion: { not: null } } } },
      // Flujo 2: operativo ya aprobado (Revisado o estado posterior).
      { estado_administrativo: { notIn: ESTADOS_ADMIN_NO_HABILITA } }
    ]
  };
}

/**
 * Igual que whereElegibleContable pero para consultas sobre tbl_cobros: filtra
 * los cobros cuyo SERVICIO es elegible para contabilidad. Misma regla, expresada
 * a través de la relación `servicio` (y su servicio_realizado).
 *
 *   const where = { estado: 1, ...whereCobroElegible() };
 */
function whereCobroElegible() {
  return {
    OR: [
      // Cobro a nivel de plan de mantenimiento: facturación única del plan,
      // disponible desde que se crea el plan → siempre elegible (no hay servicio).
      { id_mantenimiento_plan: { not: null } },
      // Cobro por servicio: el servicio debe ser elegible (misma regla).
      {
        servicio: {
          is: {
            estado_servicio: { not: ESTADO_SERVICIO_CANCELADO },
            OR: [
              { id_cotizacion: { not: null } },
              { servicio_realizado: { is: { estado_administrativo: { notIn: ESTADOS_ADMIN_NO_HABILITA } } } }
            ]
          }
        }
      }
    ]
  };
}

module.exports = {
  elegibilidadContable,
  esElegibleContable,
  whereElegibleContable,
  whereCobroElegible,
  ORIGEN_COTIZACION,
  ORIGEN_OPERATIVO
};

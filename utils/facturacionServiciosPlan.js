/**
 * Situación contable (factura y cobro) de los mantenimientos de un PLAN
 * (modelo mensual).
 *
 * Un servicio de plan sin cobro propio no tiene comprobante ni cobro propios:
 * lo que le corresponde es el MES del plan en que cae, es decir, la cuota de
 * ese mes en el cobro único del plan. De ahí salen, con la misma información
 * que muestra el plan:
 *   · su FACTURA: la de la cuota del mes (o una factura general del plan);
 *   · su COBRO: el estado de pago de esa cuota.
 * Esta es la regla ÚNICA. La usan:
 *   · el listado de Contabilidad (serviciosController.realizados), para los
 *     estados, la fecha de comprobante y la acción de cada fila;
 *   · la sincronización de tbl_servicios_realizados.estado_facturacion y
 *     .estado_cobro, que es lo que leen los filtros y las tarjetas.
 *
 * El mes de un servicio sale de su visita del cronograma (numero_mes); si no
 * está enganchado a ninguna, de la ventana del plan en que cae su fecha
 * programada.
 *
 * Quedan fuera los planes legacy (sin cobro de plan, o servicios con cobro
 * propio vivo): facturan y cobran por servicio, como cualquier otro
 * (facturasController.recomputarEstadoFacturacionServicio, cobrosController).
 */
const { ymdDeFecha, diffDiasLima } = require('./tiempo');
const { ventanaMes } = require('./programacionPlanMantenimiento');
const {
  ESTADO_FACTURA_ANULADA,
  ESTADO_FACTURA_ENVIADA,
  ESTADO_FACTURACION_SIN,
  ESTADO_FACTURACION_FACTURADO,
  ESTADO_FACTURACION_ENVIADA
} = require('./estadoFactura');

const ESTADO_COBRO_SIN = 'Sin cobro';

function estadoFacturacionDeFactura(factura) {
  if (!factura) return ESTADO_FACTURACION_SIN;
  return factura.estado_factura === ESTADO_FACTURA_ENVIADA
    ? ESTADO_FACTURACION_ENVIADA
    : ESTADO_FACTURACION_FACTURADO;
}

const centavos = (v) => Math.round(Number(v || 0) * 100);

/**
 * Estado de cobro del MES (su cuota), con los mismos nombres y la misma regla
 * de atraso que el cobro en Gestión de cobros (cobrosController.persistirEstadoMora):
 * vencida hace 30 días o más → 'En mora'; vencida → 'Vencido'.
 *   · mes sin aprobar (sin cuota) o gratuito (cuota en 0) → 'Sin cobro';
 *   · cobro del plan Cerrado / Incobrable → ese estado;
 *   · cuota saldada → 'Pagado'; con abonos → 'Parcialmente pagado';
 *   · si no → 'Pendiente de iniciar'.
 */
function estadoCobroDeCuota(cuota, estadoCobroPlan, ahora = new Date()) {
  if (!cuota || centavos(cuota.monto) <= 0) return ESTADO_COBRO_SIN;
  if (['Cerrado', 'Incobrable'].includes(estadoCobroPlan)) return estadoCobroPlan;
  const pagado = centavos(cuota.monto_pagado);
  if (cuota.estado_cuota === 'Pagada' || pagado >= centavos(cuota.monto)) return 'Pagado';
  const dias = diffDiasLima(cuota.fecha_vencimiento, ahora);
  if (dias < 0 && Math.abs(dias) >= 30) return 'En mora';
  if (dias < 0) return 'Vencido';
  return pagado > 0 ? 'Parcialmente pagado' : 'Pendiente de iniciar';
}

// Mes del plan (1..duracion) cuya ventana contiene `fechaYMD`, o null.
function mesPorFecha(fechaInicioYMD, fechaYMD, duracion) {
  if (!fechaInicioYMD || !fechaYMD || fechaYMD < fechaInicioYMD) return null;
  for (let m = 1; m <= duracion; m++) {
    if (fechaYMD <= ventanaMes(fechaInicioYMD, m).hasta) return m;
  }
  return null;
}

/**
 * Situación contable de los servicios de plan (modelo mensual) dados.
 *
 * @param {object} client prisma o tx
 * @param {number[]} idsServicio
 * @returns {Promise<Map<number, {
 *   id_mantenimiento_plan: number, id_cobro: number, numero_mes: number|null,
 *   id_cuota: number|null, numero_cuota: number|null, cuota: object|null,
 *   factura: object|null, estado_facturacion: string, estado_cobro: string
 * }>>} solo trae los servicios que facturan y cobran por mes del plan.
 */
async function facturacionDeServiciosPlan(client, idsServicio) {
  const salida = new Map();
  const ids = [...new Set((idsServicio || []).map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return salida;

  const servicios = await client.tbl_servicios_proyectos.findMany({
    where: { id: { in: ids }, id_mantenimiento_plan: { not: null } },
    select: { id: true, id_mantenimiento_plan: true, fecha_programada: true, cobro: { select: { estado: true } } }
  });
  // Legacy con cobro propio vivo: factura por servicio (misma excepción que
  // facturasController.crear).
  const sinCobroPropio = servicios.filter(s => !(s.cobro && s.cobro.estado === 1));
  if (sinCobroPropio.length === 0) return salida;

  const planes = await client.tbl_mantenimientos_planes.findMany({
    where: { id: { in: [...new Set(sinCobroPropio.map(s => s.id_mantenimiento_plan))] } },
    select: {
      id: true, fecha_inicio: true, duracion_meses: true, tipo_plan: true,
      cobro: { select: { id: true, estado: true, estado_cobro: true } }
    }
  });
  const planPorId = new Map(planes.filter(p => p.cobro && p.cobro.estado === 1).map(p => [p.id, p]));
  const delPlan = sinCobroPropio.filter(s => planPorId.has(s.id_mantenimiento_plan));
  if (delPlan.length === 0) return salida;

  const [visitas, cuotas, facturas] = await Promise.all([
    client.tbl_mantenimientos_programacion.findMany({
      where: { id_servicio: { in: delPlan.map(s => s.id) }, estado: 1 },
      select: { id_servicio: true, numero_mes: true }
    }),
    client.tbl_cobros_cuotas.findMany({
      where: { id_cobro: { in: [...planPorId.values()].map(p => p.cobro.id) }, estado: 1, numero_mes: { not: null } },
      select: {
        id: true, id_cobro: true, numero_mes: true, numero_cuota: true,
        monto: true, monto_pagado: true, estado_cuota: true, fecha_vencimiento: true, fecha_pago: true
      }
    }),
    client.tbl_facturas.findMany({
      where: { id_mantenimiento_plan: { in: [...planPorId.keys()] }, estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA } },
      select: { id: true, id_mantenimiento_plan: true, id_cuota: true, numero_factura: true, tipo_comprobante: true, fecha_emision: true, monto: true, estado_factura: true },
      orderBy: { id: 'asc' }
    })
  ]);
  const mesPorServicio = new Map(visitas.map(v => [v.id_servicio, v.numero_mes]));
  const cuotaPorMes = new Map(cuotas.map(c => [`${c.id_cobro}:${c.numero_mes}`, c]));
  const facturaPorCuota = new Map();
  const generalPorPlan = new Map();
  for (const f of facturas) {
    if (f.id_cuota == null) generalPorPlan.set(f.id_mantenimiento_plan, f);
    else facturaPorCuota.set(f.id_cuota, f);
  }

  const ahora = new Date();
  for (const s of delPlan) {
    const plan = planPorId.get(s.id_mantenimiento_plan);
    const duracion = plan.tipo_plan === 'eventual' ? 1 : Number(plan.duracion_meses || 0);
    const numeroMes = mesPorServicio.get(s.id)
      ?? mesPorFecha(ymdDeFecha(plan.fecha_inicio), ymdDeFecha(s.fecha_programada), duracion);
    const cuota = numeroMes != null ? cuotaPorMes.get(`${plan.cobro.id}:${numeroMes}`) || null : null;
    const factura = generalPorPlan.get(plan.id) || (cuota ? facturaPorCuota.get(cuota.id) : null) || null;
    salida.set(s.id, {
      id_mantenimiento_plan: plan.id,
      id_cobro: plan.cobro.id,
      numero_mes: numeroMes ?? null,
      id_cuota: cuota?.id ?? null,
      numero_cuota: cuota?.numero_cuota ?? null,
      cuota: cuota
        ? {
            monto: Number(cuota.monto),
            monto_pagado: Number(cuota.monto_pagado || 0),
            estado_cuota: cuota.estado_cuota,
            fecha_vencimiento: cuota.fecha_vencimiento,
            fecha_pago: cuota.fecha_pago
          }
        : null,
      factura,
      estado_facturacion: estadoFacturacionDeFactura(factura),
      estado_cobro: estadoCobroDeCuota(cuota, plan.cobro.estado_cobro, ahora)
    });
  }
  return salida;
}

/**
 * Alinea tbl_servicios_realizados.estado_facturacion y .estado_cobro de los
 * mantenimientos de un plan con la cuota de su mes. Se llama tras cada
 * movimiento del plan (aprobar o revertir un mes, factura, abono, cierre) y la
 * repite Contabilidad al leer si algo quedó desalineado (p. ej. una cuota que
 * venció). Idempotente: solo escribe las filas que cambian.
 *
 * @returns {Promise<{ actualizados: number }>}
 */
async function sincronizarFacturacionServiciosPlan(client, idPlan, idUsuario = null) {
  const realizados = await client.tbl_servicios_realizados.findMany({
    where: { servicio: { is: { id_mantenimiento_plan: Number(idPlan) } } },
    select: { id_servicio: true, estado_facturacion: true, estado_cobro: true }
  });
  const situacion = await facturacionDeServiciosPlan(client, realizados.map(r => r.id_servicio));

  const grupos = new Map(); // "facturacion|cobro" → { data, ids }
  for (const r of realizados) {
    const info = situacion.get(r.id_servicio);
    if (!info) continue;
    if (info.estado_facturacion === r.estado_facturacion && info.estado_cobro === r.estado_cobro) continue;
    const clave = `${info.estado_facturacion}|${info.estado_cobro}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, { data: { estado_facturacion: info.estado_facturacion, estado_cobro: info.estado_cobro }, ids: [] });
    }
    grupos.get(clave).ids.push(r.id_servicio);
  }
  let actualizados = 0;
  for (const { data, ids } of grupos.values()) {
    const r = await client.tbl_servicios_realizados.updateMany({
      where: { id_servicio: { in: ids } },
      data: { ...data, user_id_modification: idUsuario, date_time_modification: new Date() }
    });
    actualizados += r.count;
  }
  return { actualizados };
}

/**
 * Lo mismo, a partir del cobro: si es el cobro único de un plan, sincroniza
 * sus mantenimientos. Para los movimientos que se registran sobre el cobro
 * (abonos, cierre, incobrable). Nunca lanza: el movimiento ya quedó grabado.
 */
async function sincronizarServiciosDeCobroPlan(client, cobro, idUsuario = null) {
  if (!cobro?.id_mantenimiento_plan) return;
  try {
    await sincronizarFacturacionServiciosPlan(client, cobro.id_mantenimiento_plan, idUsuario);
  } catch (err) {
    console.error(`[plan #${cobro.id_mantenimiento_plan}] sincronizar mantenimientos:`, err);
  }
}

module.exports = {
  facturacionDeServiciosPlan,
  sincronizarFacturacionServiciosPlan,
  sincronizarServiciosDeCobroPlan,
  estadoCobroDeCuota
};

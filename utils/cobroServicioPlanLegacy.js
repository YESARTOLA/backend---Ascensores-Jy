/**
 * Mantenimientos de los planes LEGACY: cobran y facturan POR SERVICIO.
 *
 * Los planes creados antes del cobro único por plan (jun–jul 2026, migración
 * 20260622170000_cobro_por_plan_mantenimiento) no tienen fila en tbl_cobros
 * con su id_mantenimiento_plan y nunca pasaron al modelo mensual: no se
 * aprueban meses ni hay cuota del plan que facturar. Cada mantenimiento lleva
 * su PROPIO cobro y se factura por servicio (excepción ya admitida en
 * facturasController.crear, situacionFacturacion.admiteFacturaPorServicio y
 * Contabilidad.jsx).
 *
 * serviciosController.finalizar solo omite el cobro propio de un servicio de
 * plan cuando el plan factura por mes (tiene cobro único). En un plan legacy
 * se lo crea con esta regla. Antes se omitía siempre y el mantenimiento
 * quedaba sin ninguna vía de cobro ni de factura (19/11/2026: 12 servicios en
 * producción; los repara scripts/cobrarServiciosPlanesLegacy.js).
 */
const { crearCobroInicial } = require('./crearCobroInicial');
const { ESTADO_FACTURA_ANULADA } = require('./estadoFactura');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** ¿El plan factura por MES (modelo mensual, con cobro único vivo)? */
async function planFacturaPorMes(client, idPlan) {
  if (!idPlan) return false;
  const cobro = await client.tbl_cobros.findFirst({
    where: { id_mantenimiento_plan: Number(idPlan), estado: 1 },
    select: { id: true }
  });
  return !!cobro;
}

/**
 * Importe del cobro propio de un mantenimiento de plan legacy:
 *   1. su precio_interno, si lo tiene (las visitas materializadas antes del
 *      modelo mensual nacían con el precio del plan);
 *   2. 0 si el plan no tiene importe (monto_mensual 0): plan sin cobro;
 *   3. lo que cobró por servicio el último mantenimiento del mismo plan, para
 *      respetar un precio por visita distinto del mensual;
 *   4. el precio del ascensor en el plan y, en su defecto, el monto mensual.
 * Las visitas materializadas desde el modelo mensual nacen con precio 0 (el
 * importe vivía en el mes del plan): por eso hacen falta los pasos 2 a 4.
 *
 * @param {object} client prisma o tx
 * @param {{ id: number, id_mantenimiento_plan: number, precio_interno: any }} servicio
 * @returns {Promise<number>}
 */
async function montoCobroServicioPlanLegacy(client, servicio) {
  const precio = round2(servicio.precio_interno);
  if (precio > 0) return precio;

  const idPlan = Number(servicio.id_mantenimiento_plan);
  const plan = await client.tbl_mantenimientos_planes.findUnique({
    where: { id: idPlan }, select: { monto_mensual: true }
  });
  const mensual = round2(plan?.monto_mensual);
  if (mensual <= 0) return 0;

  const hermano = await client.tbl_servicios_proyectos.findFirst({
    where: {
      id_mantenimiento_plan: idPlan,
      estado: 1,
      id: { not: Number(servicio.id) },
      cobro: { is: { estado: 1, monto_total: { gt: 0 } } }
    },
    orderBy: [{ fecha_programada: 'desc' }, { id: 'desc' }],
    select: { cobro: { select: { monto_total: true } } }
  });
  if (hermano?.cobro) return round2(hermano.cobro.monto_total);

  const asc = await client.tbl_servicios_ascensores.findFirst({
    where: { id_servicio: Number(servicio.id), estado: 1 },
    select: { id_ascensor: true }
  });
  if (asc) {
    const fila = await client.tbl_mantenimientos_planes_ascensores.findFirst({
      where: { id_plan: idPlan, id_ascensor: asc.id_ascensor, estado: 1 },
      select: { monto: true }
    });
    if (round2(fila?.monto) > 0) return round2(fila.monto);
  }
  return mensual;
}

/**
 * Crea el cobro propio de un mantenimiento de plan legacy, con la misma forma
 * que el de cualquier servicio cerrado sin cotización (una cuota por el total,
 * que vence en la fecha programada). Si el servicio nació con precio 0, le
 * fija ese importe para que listados y reportes muestren lo mismo que su cobro.
 *
 * @param {object} tx prisma o tx
 * @param {{ id: number, id_cliente: number, moneda: string, fecha_programada: Date|null, precio_interno: any }} servicio
 * @param {number} monto > 0 (montoCobroServicioPlanLegacy)
 * @param {number|null} idUsuario
 */
async function crearCobroServicioPlanLegacy(tx, servicio, monto, idUsuario) {
  if (round2(servicio.precio_interno) <= 0) {
    await tx.tbl_servicios_proyectos.update({
      where: { id: Number(servicio.id) },
      data: { precio_interno: monto, user_id_modification: idUsuario, date_time_modification: new Date() }
    });
  }
  return crearCobroInicial(tx, {
    idServicio: Number(servicio.id),
    idCliente: servicio.id_cliente,
    monto,
    moneda: servicio.moneda,
    fechaCuotaUnica: servicio.fecha_programada || new Date(),
    idUsuario
  });
}

/**
 * Cobro y factura de cada mantenimiento de un plan legacy, para el detalle del
 * plan (en vez de la tabla de meses, que no aplica). Lista los realizados y los
 * que ya tengan cobro; los cancelados y los pendientes sin cobro no.
 *
 * @param {object} client prisma o tx
 * @param {number} idPlan
 */
async function cobrosPorServicioDelPlan(client, idPlan) {
  const servicios = await client.tbl_servicios_proyectos.findMany({
    where: {
      id_mantenimiento_plan: Number(idPlan),
      estado: 1,
      estado_servicio: { not: 'Cancelado' },
      OR: [{ servicio_realizado: { isNot: null } }, { cobro: { isNot: null } }]
    },
    orderBy: [{ fecha_programada: 'asc' }, { id: 'asc' }],
    select: {
      id: true, codigo: true, fecha_programada: true, estado_servicio: true, sin_cobro: true,
      cobro: {
        select: {
          id: true, estado: true, monto_total: true, total_abonado: true,
          saldo_pendiente: true, estado_cobro: true, moneda: true
        }
      },
      facturas: {
        where: { estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA } },
        select: { id: true, numero_factura: true, estado_factura: true },
        orderBy: { id: 'asc' }
      }
    }
  });
  return servicios.map(s => {
    const cobro = s.cobro && s.cobro.estado === 1 ? s.cobro : null;
    return {
      id_servicio: s.id,
      codigo: s.codigo,
      fecha_programada: s.fecha_programada,
      estado_servicio: s.estado_servicio,
      gratuito: s.sin_cobro === 1,
      cobro: cobro
        ? {
            id: cobro.id,
            monto_total: Number(cobro.monto_total),
            total_abonado: Number(cobro.total_abonado),
            saldo_pendiente: Number(cobro.saldo_pendiente),
            estado_cobro: cobro.estado_cobro,
            moneda: cobro.moneda
          }
        : null,
      facturas: s.facturas
    };
  });
}

module.exports = {
  planFacturaPorMes,
  montoCobroServicioPlanLegacy,
  crearCobroServicioPlanLegacy,
  cobrosPorServicioDelPlan
};

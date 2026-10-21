// Fechas de Contabilidad y de Facturas: criterio ÚNICO para la fecha que se
// muestra en cada fila y para su filtro por rango, así el filtro trae
// exactamente lo que la columna dice. La "Fecha de servicio" de un servicio
// vive en utils/fechaServicioContable.js; aquí se usa tal cual.
//
//  - Fecha de registro: cuándo se registró la ORDEN DE TRABAJO del servicio
//    (`ot_subida_en`, la graba serviciosController.guardarOt). Sin OT, no hay.
//  - Fecha de comprobante (fila de Contabilidad): la emisión del comprobante
//    que cubre el servicio. Mantenimiento de un plan (modelo mensual): la
//    factura de su MES (utils/facturacionServiciosPlan.js). Cualquier otro: la
//    factura vigente más reciente de su cobro. Las anuladas no cuentan.
//  - En Facturas cada fila YA es un comprobante (su fecha es la de emisión):
//    las fechas de servicio y de registro son las de los servicios que cubre —
//    el suyo o, si es una factura de plan, los mantenimientos de su mes (o de
//    todo el plan, si es general). Con varios servicios se da el rango
//    (primera y última) y el filtro acepta la factura si alguno cae dentro.

const { ymdLima, ymdDeFecha, parseYMDLima, parseYMDFinDiaLima, parseYMDUTC } = require('./tiempo');
const { ESTADO_FACTURA_ANULADA } = require('./estadoFactura');
const { ESTADO_CANCELADO } = require('./ejecucionFechas');
const { facturacionDeServiciosPlan } = require('./facturacionServiciosPlan');
const { INCLUDE_HISTORIAL_INICIO, fechaServicioContable } = require('./fechaServicioContable');

const WHERE_FACTURA_VIGENTE = { estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA } };
const esFacturaVigente = (f) => !!f && f.estado === 1 && f.estado_factura !== ESTADO_FACTURA_ANULADA;

// Día (YYYY-MM-DD) de cada tipo de fecha: las de servicio y de registro son
// instantes (se leen en Lima); la de emisión es un día puro (@db.Date).
const diaDeInstante = (fecha) => (fecha ? ymdLima(new Date(fecha)) : null);
const diaDeEmision = (fecha) => (fecha ? ymdDeFecha(fecha) : null);

// ¿El día cae en el rango { desde, hasta } (YYYY-MM-DD, extremos opcionales e
// inclusivos)?
const diaEnRango = (dia, { desde, hasta }) => !!dia
  && (!desde || dia >= String(desde).substring(0, 10))
  && (!hasta || dia <= String(hasta).substring(0, 10));

const hayRango = (rango) => !!(rango && (rango.desde || rango.hasta));

// --- Fecha de registro (OT) -------------------------------------------------

const fechaRegistroOt = (servicio) => servicio?.ot_subida_en || null;

/**
 * Condición Prisma sobre el SERVICIO: su OT se registró entre `desde` y `hasta`
 * (días de Lima). Null si no se pidió rango. Sin OT no entra.
 */
function whereRegistroOtEnRango({ desde, hasta }) {
  if (!desde && !hasta) return null;
  const ot_subida_en = {};
  if (desde) ot_subida_en.gte = parseYMDLima(desde);
  if (hasta) ot_subida_en.lte = parseYMDFinDiaLima(hasta);
  return { ot_subida_en };
}

// --- Fecha de comprobante (Contabilidad) ------------------------------------

// Relación `cobro` mínima del servicio para `fechaComprobanteContable`.
const SELECT_COBRO_FACTURAS = {
  select: { facturas: { select: { estado: true, estado_factura: true, fecha_emision: true } } }
};

/**
 * @param {object} servicio  con `cobro.facturas` (estado, estado_factura, fecha_emision).
 * @param {object|undefined} infoPlan  lo que devuelve facturacionDeServiciosPlan
 *   para este servicio (solo los mantenimientos que facturan por mes del plan).
 * @returns {Date|null}
 */
function fechaComprobanteContable(servicio, infoPlan) {
  if (infoPlan) return infoPlan.factura?.fecha_emision || null;
  let ultima = null;
  for (const f of servicio?.cobro?.facturas || []) {
    if (!esFacturaVigente(f) || !f.fecha_emision) continue;
    if (!ultima || diaDeEmision(f.fecha_emision) > diaDeEmision(ultima)) ultima = f.fecha_emision;
  }
  return ultima;
}

/**
 * id_servicio de los servicios cuya "Fecha de comprobante" cae en el rango, o
 * null si no se pidió rango. La fecha de un servicio siempre es la de algún
 * comprobante vigente, así que se parte de los emitidos en el rango y se
 * confirma cada servicio con `fechaComprobanteContable` (un cobro con otra
 * factura posterior, fuera del rango, no entra: su columna muestra esa otra).
 */
async function idsServicioConComprobanteEnRango(client, { desde, hasta }) {
  if (!desde && !hasta) return null;
  const fecha_emision = {};
  if (desde) fecha_emision.gte = parseYMDUTC(desde);
  if (hasta) fecha_emision.lte = parseYMDUTC(hasta);
  const facturas = await client.tbl_facturas.findMany({
    where: { ...WHERE_FACTURA_VIGENTE, fecha_emision },
    select: { id_cobro: true, id_servicio: true, id_mantenimiento_plan: true }
  });
  const idsCobro = [...new Set(facturas.map(f => f.id_cobro).filter(Boolean))];
  // Las facturas de un plan (sin servicio) cubren mantenimientos de ese plan.
  const idsPlan = [...new Set(facturas.filter(f => f.id_servicio == null).map(f => f.id_mantenimiento_plan).filter(Boolean))];
  const candidatos = [
    ...(idsCobro.length ? [{ cobro: { is: { id: { in: idsCobro } } } }] : []),
    ...(idsPlan.length ? [{ id_mantenimiento_plan: { in: idsPlan } }] : [])
  ];
  if (!candidatos.length) return [];

  const servicios = await client.tbl_servicios_proyectos.findMany({
    where: { OR: candidatos },
    select: { id: true, cobro: SELECT_COBRO_FACTURAS }
  });
  const plan = await facturacionDeServiciosPlan(client, servicios.map(s => s.id));
  return servicios
    .filter(s => diaEnRango(diaDeEmision(fechaComprobanteContable(s, plan.get(s.id))), { desde, hasta }))
    .map(s => s.id);
}

// --- Fechas de servicio y de registro de cada factura (Facturas) ------------

// Lo que hace falta de un servicio para sus dos fechas.
const SELECT_SERVICIO_FECHAS = {
  id: true, codigo: true, ot_subida_en: true,
  historial_estados: INCLUDE_HISTORIAL_INICIO
};

function fechasDeServicio(s) {
  return {
    id: s.id,
    codigo: s.codigo,
    fecha_servicio: fechaServicioContable(s),
    fecha_registro: fechaRegistroOt(s)
  };
}

// Primera y última fecha (por día de Lima) de la lista.
function extremos(fechas) {
  let primera = null;
  let ultima = null;
  for (const f of fechas) {
    if (!f) continue;
    if (!primera || diaDeInstante(f) < diaDeInstante(primera)) primera = f;
    if (!ultima || diaDeInstante(f) > diaDeInstante(ultima)) ultima = f;
  }
  return [primera, ultima];
}

/**
 * Servicios que cubre cada factura y sus fechas.
 *
 * @param {object} client  prisma o tx
 * @param {Array<{id, id_servicio, id_mantenimiento_plan, id_cuota}>} facturas
 * @returns {Promise<Map<number, {
 *   fecha_servicio: Date|null, fecha_servicio_hasta: Date|null,
 *   fecha_registro: Date|null, fecha_registro_hasta: Date|null,
 *   servicios_fechas: Array<{id, codigo, fecha_servicio, fecha_registro}>
 * }>>}  `*_hasta` = la última, cuando la factura cubre varios servicios.
 */
async function fechasDeServiciosDeFacturas(client, facturas) {
  const salida = new Map();
  if (!facturas?.length) return salida;

  // Facturas de plan: los mantenimientos del mes de su cuota, o todos los del
  // plan si es general. Misma asignación servicio → mes → cuota → factura que
  // usa Contabilidad.
  const idsPlan = [...new Set(facturas.filter(f => !f.id_servicio && f.id_mantenimiento_plan).map(f => f.id_mantenimiento_plan))];
  const delPlan = new Map(); // id_plan → [{ id_servicio, id_cuota }]
  if (idsPlan.length) {
    const serviciosPlan = await client.tbl_servicios_proyectos.findMany({
      where: { id_mantenimiento_plan: { in: idsPlan }, estado: 1, estado_servicio: { not: ESTADO_CANCELADO } },
      select: { id: true }
    });
    const info = await facturacionDeServiciosPlan(client, serviciosPlan.map(s => s.id));
    for (const [idServicio, i] of info) {
      if (!delPlan.has(i.id_mantenimiento_plan)) delPlan.set(i.id_mantenimiento_plan, []);
      delPlan.get(i.id_mantenimiento_plan).push({ id_servicio: idServicio, id_cuota: i.id_cuota });
    }
  }
  const cubiertos = (f) => {
    if (f.id_servicio) return [f.id_servicio];
    const lista = delPlan.get(f.id_mantenimiento_plan) || [];
    return lista.filter(s => f.id_cuota == null || s.id_cuota === f.id_cuota).map(s => s.id_servicio);
  };

  const idsServicio = [...new Set(facturas.flatMap(cubiertos))];
  const servicios = idsServicio.length
    ? await client.tbl_servicios_proyectos.findMany({ where: { id: { in: idsServicio } }, select: SELECT_SERVICIO_FECHAS })
    : [];
  const fechasPorServicio = new Map(servicios.map(s => [s.id, fechasDeServicio(s)]));

  for (const f of facturas) {
    const lista = cubiertos(f).map(id => fechasPorServicio.get(id)).filter(Boolean);
    const [servicioDesde, servicioHasta] = extremos(lista.map(s => s.fecha_servicio));
    const [registroDesde, registroHasta] = extremos(lista.map(s => s.fecha_registro));
    salida.set(f.id, {
      fecha_servicio: servicioDesde,
      fecha_servicio_hasta: servicioHasta,
      fecha_registro: registroDesde,
      fecha_registro_hasta: registroHasta,
      servicios_fechas: lista
    });
  }
  return salida;
}

/** Las mismas facturas con sus fechas de servicio y de registro adjuntas. */
async function conFechasDeServicios(client, facturas) {
  const fechas = await fechasDeServiciosDeFacturas(client, facturas);
  return facturas.map(f => ({ ...f, ...fechas.get(f.id) }));
}

/**
 * id de las facturas de `where` con algún servicio cuya fecha de servicio y
 * de registro caen en sus rangos (los que se pidieron), o null si no se pidió
 * ninguno de los dos.
 */
async function idsFacturasConFechasEnRango(client, where, { servicio, registro }) {
  if (!hayRango(servicio) && !hayRango(registro)) return null;
  const facturas = await client.tbl_facturas.findMany({
    where,
    select: { id: true, id_servicio: true, id_mantenimiento_plan: true, id_cuota: true }
  });
  const fechas = await fechasDeServiciosDeFacturas(client, facturas);
  const cumple = (s) =>
    (!hayRango(servicio) || diaEnRango(diaDeInstante(s.fecha_servicio), servicio))
    && (!hayRango(registro) || diaEnRango(diaDeInstante(s.fecha_registro), registro));
  return facturas
    .filter(f => (fechas.get(f.id)?.servicios_fechas || []).some(cumple))
    .map(f => f.id);
}

module.exports = {
  fechaRegistroOt,
  whereRegistroOtEnRango,
  fechaComprobanteContable,
  idsServicioConComprobanteEnRango,
  conFechasDeServicios,
  idsFacturasConFechasEnRango
};

/**
 * PLAN DE MANTENIMIENTO MENSUAL — SSoT de cronograma y facturación.
 * =====================================================================
 * Este módulo es el único lugar donde se decide:
 *
 *   1. QUÉ se programa  → `generarProgramacion` materializa el cronograma
 *      completo (tbl_mantenimientos_programacion) + un evento de calendario
 *      por visita, respetando la frecuencia PROPIA de cada ascensor.
 *
 *   2. QUÉ se cobra     → `mesesDelPlan` agrupa ese cronograma por MES DEL PLAN
 *      y devuelve, para cada mes, el detalle de visitas y el importe. El importe
 *      es SIEMPRE `plan.monto_mensual`: no depende de cuántas visitas caigan en
 *      el mes ni de que alguna se omita.
 *
 * Contabilidad, Gestión de cobros y Facturas leen de aquí (vía el cobro único
 * del plan y sus cuotas, una por mes) — no recalculan nada por su cuenta.
 */

const { ymdDeFecha, parseYMDLima, combinarFechaHoraLima } = require('./tiempo');
const { ESTADO_EVENTO_PROGRAMADO } = require('./estadoEvento');
const { COLORES } = require('./recordatoriosAuto');
const { estaServicioRealizado } = require('./estadoServicio');
const { ESTADO_FACTURA_ANULADA } = require('./estadoFactura');
const { programacionDelPlan, ventanaMes } = require('./programacionPlanMantenimiento');

const COLOR_MANTENIMIENTO = COLORES.mantenimiento;

const MESES_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** "Mes 3 · mar 2026" a partir del YMD en que arranca la ventana. */
function etiquetaMes(numeroMes, desdeYMD) {
  const [y, m] = String(desdeYMD).split('-').map(Number);
  return `Mes ${numeroMes} · ${MESES_ES[m - 1]} ${y}`;
}

/**
 * ECONOMÍA DEL PLAN — SSoT del importe total.
 *
 * Los MESES GRATUITOS son meses que se prestan pero no se cobran: sus visitas
 * se ejecutan igual y su servicio se cierra, pero no generan cuota con importe
 * ni entran a Gestión de cobros. Por eso el total del contrato NO es
 * `monto_mensual × duración`, sino solo los meses facturables:
 *
 *     total = monto_mensual × (duración − meses gratuitos)
 *
 * Ej.: 24 meses a S/ 3.000 con 2 gratuitos → 22 × 3.000 = S/ 66.000.
 *
 * Toda la aplicación (formulario, detalle del plan, reportes y export) debe
 * calcular el total por aquí; el espejo en cliente vive en
 * frontend/src/utils/planMantenimiento.js.
 *
 * @param {object} plan  Con monto_mensual, duracion_meses,
 *                       cantidad_mantenimientos_gratuitos y tipo_plan.
 */
function totalesDelPlan(plan) {
  const meses = plan?.tipo_plan === 'eventual' ? 1 : Number(plan?.duracion_meses || 0);
  // El cupo nunca puede exceder la duración (el formulario ya lo acota, pero un
  // plan acortado después podría dejarlo por encima).
  const gratuitos = Math.min(Math.max(0, Number(plan?.cantidad_mantenimientos_gratuitos || 0)), meses);
  const facturables = Math.max(0, meses - gratuitos);
  const mensual = round2(plan?.monto_mensual || 0);
  return {
    meses,
    meses_gratuitos: gratuitos,
    meses_facturables: facturables,
    monto_mensual: mensual,
    total: round2(mensual * facturables),
    moneda: plan?.moneda || null
  };
}

/**
 * Frecuencia efectiva de una fila de la junction: la suya, y si no la tiene
 * (planes creados antes del modelo por-ascensor) la del plan.
 */
function frecuenciaDeAscensor(filaJunction, plan) {
  return {
    frecuencia: filaJunction.frecuencia || plan.frecuencia || null,
    frecuencia_dias_custom: filaJunction.frecuencia_dias_custom ?? plan.frecuencia_dias_custom ?? null
  };
}

/**
 * Nomenclatura corta del mantenimiento generado por un plan: "Mant. <Edificio>".
 */
function tituloBasePlan(edificioNombre) {
  return edificioNombre ? `Mant. ${edificioNombre}` : 'Mantenimiento';
}

/**
 * Payload de un evento de calendario para una visita del cronograma.
 */
function eventoDeVisita({ plan, fechaYMD, codigoServicio, idServicio, tituloBase, codigoAscensor }) {
  const base = codigoAscensor ? `${tituloBase} · ${codigoAscensor}` : tituloBase;
  return {
    id_servicio: idServicio || null,
    id_mantenimiento_plan: plan.id,
    titulo: codigoServicio ? `${codigoServicio} – ${base}` : base,
    tipo_evento: 'mantenimiento',
    fecha_inicio: combinarFechaHoraLima(fechaYMD, plan.hora_programada),
    estado_evento: ESTADO_EVENTO_PROGRAMADO,
    color: COLOR_MANTENIMIENTO
  };
}

/**
 * Genera el cronograma COMPLETO del plan: una fila de programación y un evento
 * de calendario por cada visita de cada ascensor, para todo el horizonte de
 * meses. Se llama al crear el plan y al regenerarlo (cambio de duración,
 * frecuencias o fecha de inicio).
 *
 * Un plan `eventual` no tiene serie: una única visita por ascensor en la fecha
 * de inicio (mes 1).
 *
 * @param {object} tx      Cliente Prisma transaccional.
 * @param {object} args
 * @param {object} args.plan            Fila del plan (ya creada).
 * @param {Array}  args.filasJunction   Filas de tbl_mantenimientos_planes_ascensores
 *                                      con `ascensor` incluido (codigo, edificio).
 * @param {number} args.userId
 * @returns {Promise<{creadas:number, porAscensor:Object<number,number>}>}
 */
async function generarProgramacion(tx, { plan, filasJunction, userId }) {
  const activos = (filasJunction || []).filter(f => f.estado === 1);
  if (activos.length === 0) return { creadas: 0, porAscensor: {} };

  const fechaInicioYMD = ymdDeFecha(plan.fecha_inicio);
  const esEventual = plan.tipo_plan === 'eventual';
  const duracionMeses = esEventual ? 1 : Number(plan.duracion_meses || 12);

  const filas = esEventual
    ? activos.map(f => ({ id_ascensor: f.id_ascensor, ordinal: 1, numero_mes: 1, fecha: fechaInicioYMD }))
    : programacionDelPlan({
        fechaInicioYMD,
        duracionMeses,
        ascensores: activos.map(f => ({ id_ascensor: f.id_ascensor, ...frecuenciaDeAscensor(f, plan) }))
      });

  const junctionPorAscensor = new Map(activos.map(f => [f.id_ascensor, f]));
  const tituloBase = tituloBasePlan(
    activos.map(f => f.ascensor?.edificio?.nombre).find(Boolean) || null
  );

  const porAscensor = {};
  for (const fila of filas) {
    const junction = junctionPorAscensor.get(fila.id_ascensor);
    if (!junction) continue;
    const evento = await tx.tbl_calendario_eventos.create({
      data: eventoDeVisita({
        plan,
        fechaYMD: fila.fecha,
        tituloBase,
        codigoAscensor: junction.ascensor?.codigo || null
      })
    });
    await tx.tbl_mantenimientos_programacion.create({
      data: {
        id_plan: plan.id,
        id_plan_ascensor: junction.id,
        id_ascensor: fila.id_ascensor,
        numero_mes: fila.numero_mes,
        ordinal: fila.ordinal,
        fecha_programada: parseYMDLima(fila.fecha),
        id_evento: evento.id,
        user_id_registration: userId
      }
    });
    porAscensor[fila.id_ascensor] = (porAscensor[fila.id_ascensor] || 0) + 1;
  }
  return { creadas: filas.length, porAscensor };
}

/**
 * Libera las visitas del cronograma enganchadas a un servicio que se CANCELA o
 * ELIMINA: la visita vuelve a ser una fecha pendiente, materializable de nuevo.
 *
 * Sin esto la visita quedaría ocupada por un servicio muerto: no contaría como
 * realizada (mesesDelPlan filtra servicios vivos/cancelados) pero tampoco se
 * podría volver a programar, y el mes jamás llegaría a "completo".
 *
 * Para cada visita ACTIVA se crea un evento de calendario nuevo en estado
 * programado (el del servicio quedó cancelado), para que la fecha siga visible
 * y materializable desde el calendario. Las visitas omitidas solo se
 * desenganchan.
 *
 * @param {object} client prisma o tx
 * @param {number} idServicio
 * @param {number} userId
 * @returns {Promise<number>} visitas liberadas
 */
async function liberarVisitasDeServicio(client, idServicio, userId) {
  const visitas = await client.tbl_mantenimientos_programacion.findMany({
    where: { id_servicio: Number(idServicio), estado: 1 },
    include: {
      plan: { select: { id: true, hora_programada: true } },
      ascensor: { select: { codigo: true, edificio: { select: { nombre: true } } } }
    }
  });
  for (const v of visitas) {
    let idEvento = null;
    if (v.activo === 1) {
      const evento = await client.tbl_calendario_eventos.create({
        data: eventoDeVisita({
          plan: v.plan,
          fechaYMD: ymdDeFecha(v.fecha_programada),
          tituloBase: tituloBasePlan(v.ascensor?.edificio?.nombre || null),
          codigoAscensor: v.ascensor?.codigo || null
        })
      });
      idEvento = evento.id;
    }
    await client.tbl_mantenimientos_programacion.update({
      where: { id: v.id },
      data: {
        id_servicio: null,
        ...(idEvento ? { id_evento: idEvento } : {}),
        user_id_modification: userId,
        date_time_modification: new Date()
      }
    });
  }
  return visitas.length;
}

/**
 * Estado de facturación del plan agrupado por MES DEL PLAN — la unidad de cobro.
 *
 * Por cada mes devuelve el detalle de visitas (qué ascensor, cuántas veces y en
 * qué fechas), el avance de ejecución, la cuota asociada del cobro único del
 * plan y el estado del periodo. El importe del mes es `plan.monto_mensual`,
 * invariable: omitir visitas o ejecutar de menos NO lo cambia.
 *
 * Estados: pendiente → completo → aprobado → facturado → pagado.
 *
 * @param {object} client prisma o tx
 * @param {number} idPlan
 */
async function mesesDelPlan(client, idPlan) {
  const plan = await client.tbl_mantenimientos_planes.findUnique({
    where: { id: Number(idPlan) },
    select: {
      id: true, fecha_inicio: true, duracion_meses: true, tipo_plan: true,
      monto_mensual: true, moneda: true, cantidad_mantenimientos_gratuitos: true,
      cobro: { select: { id: true } }
    }
  });
  if (!plan) {
    return { id_cobro: null, monto_mensual: 0, moneda: null, duracion_meses: 0, cupo_gratuito: 0, meses: [] };
  }

  const visitas = await client.tbl_mantenimientos_programacion.findMany({
    where: { id_plan: Number(idPlan), estado: 1 },
    orderBy: [{ fecha_programada: 'asc' }, { id_ascensor: 'asc' }],
    include: {
      ascensor: { select: { id: true, codigo: true, ubicacion: true, edificio: { select: { nombre: true } } } },
      servicio: { select: { id: true, codigo: true, estado_servicio: true, estado: true } }
    }
  });

  const cuotas = plan.cobro
    ? await client.tbl_cobros_cuotas.findMany({
        where: { id_cobro: plan.cobro.id, estado: 1 },
        select: { id: true, numero_cuota: true, numero_mes: true, fecha_vencimiento: true, monto: true, monto_pagado: true, estado_cuota: true }
      })
    : [];
  // Una factura ANULADA no cubre el mes: la cuota vuelve a "Por facturar" y el
  // mes debe volver a 'aprobado' (mismo criterio que cuotasNoFacturadas).
  const facturas = plan.cobro
    ? await client.tbl_facturas.findMany({
        where: {
          id_mantenimiento_plan: Number(idPlan), estado: 1,
          id_cuota: { not: null }, estado_factura: { not: ESTADO_FACTURA_ANULADA }
        },
        select: { id_cuota: true }
      })
    : [];
  const cuotaFacturada = new Set(facturas.map(f => f.id_cuota));

  const fechaInicioYMD = ymdDeFecha(plan.fecha_inicio);
  const duracion = plan.tipo_plan === 'eventual' ? 1 : Number(plan.duracion_meses || 0);
  const montoMensual = round2(plan.monto_mensual || 0);
  const cupoGratuito = Number(plan.cantidad_mantenimientos_gratuitos || 0);

  // Meses con visitas + los declarados por la duración: un mes sin visitas
  // (todas omitidas, o frecuencias que no caen ahí) sigue siendo un mes del
  // contrato y se factura igual.
  const numerosMes = new Set(visitas.map(v => v.numero_mes));
  for (let m = 1; m <= duracion; m++) numerosMes.add(m);

  const meses = [...numerosMes].sort((a, b) => a - b).map(numeroMes => {
    const delMes = visitas.filter(v => v.numero_mes === numeroMes);
    const activas = delMes.filter(v => v.activo === 1);
    const omitidas = delMes.filter(v => v.activo === 0);

    // Detalle por ascensor: cuántas visitas y en qué fechas. Es lo que ve
    // Contabilidad como desglose del cobro del mes.
    const porAscensor = new Map();
    for (const v of activas) {
      const key = v.id_ascensor;
      if (!porAscensor.has(key)) {
        porAscensor.set(key, {
          id_ascensor: key,
          codigo: v.ascensor?.codigo || null,
          ubicacion: v.ascensor?.ubicacion || null,
          edificio: v.ascensor?.edificio?.nombre || null,
          visitas: 0,
          realizadas: 0,
          fechas: []
        });
      }
      const item = porAscensor.get(key);
      const servicioVivo = v.servicio && v.servicio.estado === 1 ? v.servicio : null;
      // 'Cancelado' no cuenta: el trabajo no se hizo aunque el servicio esté
      // en un estado post-ejecución (ver estaServicioRealizado).
      const realizada = !!servicioVivo && estaServicioRealizado(servicioVivo.estado_servicio);
      item.visitas += 1;
      if (realizada) item.realizadas += 1;
      item.fechas.push({
        id_programacion: v.id,
        fecha: ymdDeFecha(v.fecha_programada),
        id_servicio: servicioVivo?.id || null,
        codigo_servicio: servicioVivo?.codigo || null,
        estado_servicio: servicioVivo?.estado_servicio || null,
        realizada
      });
    }
    const detalle = [...porAscensor.values()].sort((a, b) =>
      String(a.codigo || '').localeCompare(String(b.codigo || ''))
    );

    const total_visitas = activas.length;
    const realizadas = detalle.reduce((a, d) => a + d.realizadas, 0);
    const completo = total_visitas > 0 && realizadas === total_visitas;
    const es_gratuito = numeroMes <= cupoGratuito;

    const cuota = cuotas.find(c => c.numero_mes === numeroMes) || null;
    let estado_periodo = completo ? 'completo' : 'pendiente';
    if (cuota) {
      estado_periodo = 'aprobado';
      if (cuotaFacturada.has(cuota.id)) estado_periodo = 'facturado';
      if (String(cuota.estado_cuota) === 'Pagada' || Number(cuota.monto_pagado || 0) >= Number(cuota.monto)) {
        estado_periodo = 'pagado';
      }
    }

    const ventana = ventanaMes(fechaInicioYMD, numeroMes);
    return {
      numero_mes: numeroMes,
      desde: ventana.desde,
      hasta: ventana.hasta,
      etiqueta: etiquetaMes(numeroMes, ventana.desde),
      detalle,
      omitidas: omitidas.length,
      total_visitas,
      realizadas,
      completo,
      es_gratuito,
      monto: es_gratuito ? 0 : montoMensual,
      moneda: plan.moneda,
      cuota: cuota
        ? {
            id: cuota.id,
            numero_cuota: cuota.numero_cuota,
            numero_mes: cuota.numero_mes,
            monto: Number(cuota.monto),
            monto_pagado: Number(cuota.monto_pagado || 0),
            estado_cuota: cuota.estado_cuota
          }
        : null,
      estado_periodo
    };
  });

  return {
    id_cobro: plan.cobro?.id || null,
    monto_mensual: montoMensual,
    moneda: plan.moneda,
    duracion_meses: duracion,
    cupo_gratuito: cupoGratuito,
    // Importe del contrato descontando los meses gratuitos (SSoT del total).
    totales: totalesDelPlan({
      monto_mensual: montoMensual,
      duracion_meses: duracion,
      cantidad_mantenimientos_gratuitos: cupoGratuito,
      tipo_plan: plan.tipo_plan,
      moneda: plan.moneda
    }),
    meses
  };
}

/**
 * Detalle de las visitas que cubre UNA cuota (el mes que factura). Es el bloque
 * que Contabilidad, Cobros y Facturas muestran como desglose del pago único del
 * mes: "ascensor A ×1, ascensor C ×2", con sus fechas y servicios.
 *
 * Devuelve null si la cuota no pertenece a un cobro de plan o no tiene mes.
 *
 * @param {object} client prisma o tx
 * @param {number} idCuota
 */
async function detalleMensualDeCuota(client, idCuota) {
  const cuota = await client.tbl_cobros_cuotas.findUnique({
    where: { id: Number(idCuota) },
    select: {
      id: true, numero_mes: true, numero_cuota: true, monto: true,
      cobro: { select: { id: true, id_mantenimiento_plan: true } }
    }
  });
  const idPlan = cuota?.cobro?.id_mantenimiento_plan;
  if (!idPlan || cuota.numero_mes == null) return null;

  const info = await mesesDelPlan(client, idPlan);
  const mes = info.meses.find(m => m.numero_mes === cuota.numero_mes);
  if (!mes) return null;
  return {
    id_cuota: cuota.id,
    id_mantenimiento_plan: idPlan,
    numero_mes: mes.numero_mes,
    etiqueta: mes.etiqueta,
    desde: mes.desde,
    hasta: mes.hasta,
    monto: Number(cuota.monto),
    moneda: info.moneda,
    total_visitas: mes.total_visitas,
    realizadas: mes.realizadas,
    detalle: mes.detalle
  };
}

/**
 * Igual que `detalleMensualDeCuota` pero para TODAS las cuotas de un cobro de
 * plan, en un solo recorrido del cronograma. Lo consumen el detalle del cobro y
 * el de las facturas, que necesitan el desglose de varios meses a la vez.
 *
 * @returns {Promise<Map<number, object>>} id_cuota → detalle del mes
 */
async function detalleMensualPorCuota(client, idPlan) {
  const salida = new Map();
  if (!idPlan) return salida;
  const info = await mesesDelPlan(client, idPlan);
  for (const mes of info.meses) {
    if (!mes.cuota) continue;
    salida.set(mes.cuota.id, {
      id_cuota: mes.cuota.id,
      id_mantenimiento_plan: Number(idPlan),
      numero_mes: mes.numero_mes,
      etiqueta: mes.etiqueta,
      desde: mes.desde,
      hasta: mes.hasta,
      monto: mes.cuota.monto,
      moneda: info.moneda,
      total_visitas: mes.total_visitas,
      realizadas: mes.realizadas,
      detalle: mes.detalle
    });
  }
  return salida;
}

module.exports = {
  round2,
  etiquetaMes,
  totalesDelPlan,
  frecuenciaDeAscensor,
  tituloBasePlan,
  eventoDeVisita,
  generarProgramacion,
  liberarVisitasDeServicio,
  mesesDelPlan,
  detalleMensualDeCuota,
  detalleMensualPorCuota,
  COLOR_MANTENIMIENTO
};

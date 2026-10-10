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
 *      y devuelve, para cada mes, el detalle de visitas y el importe
 *      (`montoDelMes`). Según la forma de cobro del plan (`modo_precio`):
 *        · 'mensual': un mes con mantenimiento se cobra `plan.monto_mensual`
 *          —no depende de cuántas visitas caigan en él ni de que alguna se
 *          omita—;
 *        · 'por_ascensor': el mes cobra la suma del precio de los ascensores
 *          que se atienden en él según su frecuencia.
 *      Un mes sin ningún mantenimiento programado no se cobra (ver
 *      `totalesDelPlan`).
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

// Formas de cobro del plan (tbl_mantenimientos_planes.modo_precio).
const MODO_PRECIO_MENSUAL = 'mensual';
const MODO_PRECIO_POR_ASCENSOR = 'por_ascensor';
const MODOS_PRECIO = [MODO_PRECIO_MENSUAL, MODO_PRECIO_POR_ASCENSOR];

function esPlanPorAscensor(plan) {
  return plan?.modo_precio === MODO_PRECIO_POR_ASCENSOR;
}

/** Precio de cada ascensor del plan (modo 'por_ascensor'): id_ascensor → monto. */
function preciosDelPlan(filasJunction) {
  return new Map((filasJunction || []).map(f => [Number(f.id_ascensor), round2(f.monto || 0)]));
}

/**
 * Importe de UN ascensor dentro de su mes:
 *   · 'por_ascensor': su precio;
 *   · 'mensual': su parte del monto mensual (monto ÷ ascensores del mes).
 * Informativo (foto de la cuota y desglose); el importe del mes lo decide
 * `montoDelMes`.
 */
function importeDeAscensorEnMes({ modo, montoMensual, precios, idAscensor, cantidadDelMes }) {
  if (modo === MODO_PRECIO_POR_ASCENSOR) return round2(precios?.get(Number(idAscensor)) || 0);
  return cantidadDelMes > 0 ? round2(Number(montoMensual || 0) / cantidadDelMes) : round2(montoMensual || 0);
}

/**
 * IMPORTE DE UN MES — SSoT de cuánto se cobra un mes con mantenimiento según
 * los ascensores que se facturan.
 *
 *   · 'mensual': el monto mensual del plan. Si al aprobar el mes se excluyen
 *     ascensores, se cobra la parte proporcional de los que quedan:
 *     3 ascensores y S/ 900, se excluye uno → 900 × 2/3 = S/ 600.
 *   · 'por_ascensor': la suma del precio de los ascensores facturados.
 *     Ascensor 1 a S/ 200 y ascensor 2 a S/ 300 en el mes → S/ 500; sin el 2,
 *     S/ 200.
 *
 * No aplica meses gratuitos ni meses sin mantenimiento: eso lo decide quien
 * llama (valen 0). Espejo en cliente: frontend/src/utils/planMantenimiento.js.
 *
 * @param {object} args
 * @param {string} args.modo                  modo_precio del plan
 * @param {number} args.montoMensual          monto_mensual del plan
 * @param {Map<number,number>} [args.precios] id_ascensor → precio ('por_ascensor')
 * @param {number[]} args.idsDelMes           ascensores que se atienden en el mes
 * @param {number[]|null} [args.idsFacturados] los que se facturan; null = todos
 */
function montoDelMes({ modo, montoMensual, precios, idsDelMes, idsFacturados = null }) {
  const delMes = [...new Set((idsDelMes || []).map(Number))];
  const marcados = idsFacturados == null ? null : new Set(idsFacturados.map(Number));
  const facturados = marcados ? delMes.filter(id => marcados.has(id)) : delMes;
  if (modo === MODO_PRECIO_POR_ASCENSOR) {
    return round2(facturados.reduce((acc, id) => acc + Number(precios?.get(id) || 0), 0));
  }
  const mensual = round2(montoMensual || 0);
  // Sin detalle de ascensores (plan sin cronograma) o sin exclusiones: el
  // monto mensual completo, como siempre.
  if (delMes.length === 0 || facturados.length === delMes.length) return mensual;
  return round2(mensual * facturados.length / delMes.length);
}

/**
 * Foto de los ascensores de un mes para guardar en la cuota al aprobarlo
 * (tbl_cobros_cuotas.ascensores_mes): cuáles se facturan y el importe de cada
 * uno.
 *
 * @param {Array<{id_ascensor:number, codigo?:string}>} ascensores  los del mes
 * @returns {Array<{id_ascensor:number, codigo:string|null, facturado:boolean, monto:number}>}
 */
function fotoAscensoresMes({ modo, montoMensual, precios, ascensores, idsFacturados = null }) {
  const lista = ascensores || [];
  const marcados = idsFacturados == null ? null : new Set(idsFacturados.map(Number));
  return lista.map(a => ({
    id_ascensor: Number(a.id_ascensor),
    codigo: a.codigo || null,
    facturado: marcados ? marcados.has(Number(a.id_ascensor)) : true,
    monto: importeDeAscensorEnMes({
      modo, montoMensual, precios, idAscensor: a.id_ascensor, cantidadDelMes: lista.length
    })
  }));
}

/**
 * Importe de cada mes del plan (1-based) según su forma de cobro, antes de
 * aplicar meses gratuitos. Los ascensores de cada mes salen del cronograma
 * (visitas activas u omitidas: omitir no cambia el cobro); sin cronograma
 * (planes antiguos), de la serie teórica de sus ascensores.
 *
 * @param {object} plan           Con modo_precio, monto_mensual, fecha_inicio,
 *                                duracion_meses, tipo_plan y frecuencia.
 * @param {Array<{numero_mes:number, id_ascensor:number}>} visitas  cronograma
 * @param {Array} filasJunction   Ascensores del plan (id_ascensor, monto, frecuencia)
 * @returns {Map<number, number>}  numero_mes → importe
 */
function montosPorMesDelPlan(plan, visitas, filasJunction) {
  let filas = (visitas || []).map(v => ({ numero_mes: Number(v.numero_mes), id_ascensor: Number(v.id_ascensor) }));
  if (filas.length === 0) {
    if (plan?.tipo_plan === 'eventual') {
      filas = (filasJunction || []).map(f => ({ numero_mes: 1, id_ascensor: Number(f.id_ascensor) }));
    } else {
      try {
        filas = programacionDelPlan({
          fechaInicioYMD: ymdDeFecha(plan.fecha_inicio),
          duracionMeses: Number(plan.duracion_meses || 0),
          ascensores: (filasJunction || [])
            .map(f => ({ id_ascensor: f.id_ascensor, ...frecuenciaDeAscensor(f, plan) }))
            .filter(a => a.frecuencia)
        }).map(v => ({ numero_mes: v.numero_mes, id_ascensor: Number(v.id_ascensor) }));
      } catch {
        filas = [];
      }
    }
  }
  const porMes = new Map();
  for (const f of filas) {
    if (!porMes.has(f.numero_mes)) porMes.set(f.numero_mes, new Set());
    porMes.get(f.numero_mes).add(f.id_ascensor);
  }
  const precios = preciosDelPlan(filasJunction);
  const salida = new Map();
  for (const [mes, ids] of porMes) {
    salida.set(mes, montoDelMes({
      modo: plan?.modo_precio, montoMensual: plan?.monto_mensual, precios, idsDelMes: [...ids]
    }));
  }
  return salida;
}

/**
 * ECONOMÍA DEL PLAN — SSoT del importe total.
 *
 * El `monto_mensual` es el precio de UN MES CON MANTENIMIENTO, tomando la
 * frecuencia mensual como referencia. Solo se cobran los meses del plan en que
 * cae al menos un mantenimiento:
 *
 *     mensual       × 12 meses → 12 meses con mantenimiento → 12 × monto
 *     trimestral    × 12 meses → meses 1, 4, 7 y 10          →  4 × monto
 *     cuatrimestral × 12 meses → meses 1, 5 y 9              →  3 × monto
 *
 * Un mes con varias visitas (quincenal, o varios ascensores) se cobra una sola
 * vez: el cobro sigue siendo único por mes.
 *
 * Los MESES GRATUITOS son los primeros N meses del plan: sus visitas se
 * ejecutan igual y su servicio se cierra, pero no generan cuota con importe ni
 * entran a Gestión de cobros. Así:
 *
 *     total = monto_mensual × (meses con mantenimiento fuera del cupo gratuito)
 *
 * Ej.: 24 meses mensual a S/ 3.000 con 2 gratuitos → 22 × 3.000 = S/ 66.000.
 *      12 meses trimestral a S/ 200                 →  4 ×   200 = S/    800.
 *
 * En un plan 'por_ascensor' cada mes vale lo suyo (la suma de los ascensores
 * que se atienden en él), así que el total suma el importe de cada mes
 * facturable (`montosPorMes`, ver `montosPorMesDelPlan`):
 *
 *     total = Σ importe del mes (meses con mantenimiento fuera del cupo gratuito)
 *
 * Toda la aplicación (formulario, detalle del plan, reportes y export) debe
 * calcular el total por aquí; el espejo en cliente vive en
 * frontend/src/utils/planMantenimiento.js.
 *
 * @param {object} plan  Con monto_mensual, duracion_meses,
 *                       cantidad_mantenimientos_gratuitos, tipo_plan y modo_precio.
 * @param {Iterable<number>} mesesConMant  Números de mes (1-based) en que cae al
 *        menos una visita; ver `mesesConMantenimiento`.
 * @param {Map<number,number>} [montosPorMes]  Importe de cada mes; solo lo usan
 *        los planes 'por_ascensor'.
 */
function totalesDelPlan(plan, mesesConMant, montosPorMes = null) {
  const meses = plan?.tipo_plan === 'eventual' ? 1 : Number(plan?.duracion_meses || 0);
  // El cupo nunca puede exceder la duración (el formulario ya lo acota, pero un
  // plan acortado después podría dejarlo por encima).
  const gratuitos = Math.min(Math.max(0, Number(plan?.cantidad_mantenimientos_gratuitos || 0)), meses);
  const conMantenimiento = new Set([...(mesesConMant || [])].map(Number));
  const porAscensor = esPlanPorAscensor(plan);
  let conteoConMant = 0;
  let facturables = 0;
  let sumaMeses = 0;
  for (let m = 1; m <= meses; m++) {
    if (!conMantenimiento.has(m)) continue;
    conteoConMant += 1;
    if (m > gratuitos) {
      facturables += 1;
      if (porAscensor) sumaMeses += Number(montosPorMes?.get(m) || 0);
    }
  }
  const mensual = round2(plan?.monto_mensual || 0);
  return {
    meses,
    meses_con_mantenimiento: conteoConMant,
    meses_gratuitos: gratuitos,
    meses_facturables: facturables,
    monto_mensual: mensual,
    total: porAscensor ? round2(sumaMeses) : round2(mensual * facturables),
    moneda: plan?.moneda || null,
    modo_precio: porAscensor ? MODO_PRECIO_POR_ASCENSOR : MODO_PRECIO_MENSUAL
  };
}

/**
 * Meses del plan (1-based) en que cae al menos un mantenimiento: los que se
 * cobran. Salen del cronograma real; si el plan todavía no lo tiene (planes
 * antiguos sin backfill), de la serie teórica de sus ascensores, para que su
 * total no quede en cero.
 *
 * @param {object} plan  Con fecha_inicio, duracion_meses, tipo_plan, frecuencia
 *                       y frecuencia_dias_custom (la del plan, por defecto).
 * @param {Array<{numero_mes:number}>} visitas  Filas de su cronograma.
 * @param {Array} filasJunction  Ascensores del plan con su frecuencia; solo se
 *                               usan si no hay cronograma.
 * @returns {Set<number>}
 */
function mesesConMantenimiento(plan, visitas, filasJunction) {
  if (visitas && visitas.length > 0) {
    return new Set(visitas.map(v => Number(v.numero_mes)).filter(Number.isInteger));
  }
  if (plan?.tipo_plan === 'eventual') return new Set([1]);
  const ascensores = (filasJunction || [])
    .map(f => ({ id_ascensor: f.id_ascensor, ...frecuenciaDeAscensor(f, plan) }))
    .filter(a => a.frecuencia);
  try {
    const serie = programacionDelPlan({
      fechaInicioYMD: ymdDeFecha(plan.fecha_inicio),
      duracionMeses: Number(plan.duracion_meses || 0),
      ascensores
    });
    return new Set(serie.map(v => v.numero_mes));
  } catch {
    // Frecuencia inválida en datos antiguos: sin serie no hay meses que cobrar.
    return new Set();
  }
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
 * qué fechas), los ascensores que se atienden en él (`ascensores_mes`, los que
 * se eligen al aprobarlo), el avance de ejecución, la cuota asociada del cobro
 * único del plan y el estado del periodo. El importe de un mes con
 * mantenimiento sale de `montoDelMes` (monto mensual o suma de precios por
 * ascensor): omitir visitas o ejecutar de menos NO lo cambia. Un mes sin
 * mantenimiento programado (p. ej. los intermedios de un plan trimestral) va en
 * 0 y no se aprueba.
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
      frecuencia: true, frecuencia_dias_custom: true, modo_precio: true,
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
        select: { id: true, numero_cuota: true, numero_mes: true, fecha_vencimiento: true, monto: true, monto_pagado: true, estado_cuota: true, ascensores_mes: true }
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

  // Meses que se cobran: los que tienen algún mantenimiento programado. Sin
  // cronograma (plan antiguo), los de la serie teórica de sus ascensores.
  const filasJunction = await client.tbl_mantenimientos_planes_ascensores.findMany({
    where: { id_plan: Number(idPlan), estado: 1 },
    select: { id_ascensor: true, frecuencia: true, frecuencia_dias_custom: true, monto: true }
  });
  const mesesCobrables = mesesConMantenimiento(plan, visitas, filasJunction);
  // Importe de cada mes según la forma de cobro del plan.
  const cobraPorAscensor = esPlanPorAscensor(plan);
  const precios = preciosDelPlan(filasJunction);
  const montosPorMes = montosPorMesDelPlan(plan, visitas, filasJunction);

  // Meses con visitas + los declarados por la duración: un mes sin visitas
  // sigue siendo un mes del contrato y se lista, pero solo se cobra si tiene
  // algún mantenimiento programado (una visita omitida no le quita el cobro).
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

    // Ascensores que se atienden este mes según su frecuencia (visitas activas
    // u omitidas): son los que se facturan y los que se eligen al aprobar el mes.
    const ascensoresDelMes = new Map();
    for (const v of delMes) {
      if (!ascensoresDelMes.has(v.id_ascensor)) {
        ascensoresDelMes.set(v.id_ascensor, {
          id_ascensor: v.id_ascensor,
          codigo: v.ascensor?.codigo || null,
          ubicacion: v.ascensor?.ubicacion || null,
          edificio: v.ascensor?.edificio?.nombre || null,
          visitas: 0,
          omitidas: 0,
          precio: cobraPorAscensor ? (precios.get(v.id_ascensor) || 0) : null
        });
      }
      const a = ascensoresDelMes.get(v.id_ascensor);
      if (v.activo === 1) a.visitas += 1; else a.omitidas += 1;
    }
    const ascensores_mes = [...ascensoresDelMes.values()].sort((a, b) =>
      String(a.codigo || '').localeCompare(String(b.codigo || ''))
    );

    const total_visitas = activas.length;
    const realizadas = detalle.reduce((a, d) => a + d.realizadas, 0);
    const completo = total_visitas > 0 && realizadas === total_visitas;
    const es_gratuito = numeroMes <= cupoGratuito;
    const con_mantenimiento = mesesCobrables.has(numeroMes);

    const cuota = cuotas.find(c => c.numero_mes === numeroMes) || null;
    // Ascensores excluidos al aprobar (foto de la cuota). Sin foto → ninguno.
    const fotoCuota = cuota && Array.isArray(cuota.ascensores_mes) ? cuota.ascensores_mes : null;
    const excluidos = fotoCuota ? fotoCuota.filter(a => !a.facturado).map(a => Number(a.id_ascensor)) : [];
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
      ascensores_mes,
      omitidas: omitidas.length,
      total_visitas,
      realizadas,
      completo,
      es_gratuito,
      con_mantenimiento,
      monto: es_gratuito || !con_mantenimiento ? 0 : (montosPorMes.get(numeroMes) ?? montoMensual),
      moneda: plan.moneda,
      cuota: cuota
        ? {
            id: cuota.id,
            numero_cuota: cuota.numero_cuota,
            numero_mes: cuota.numero_mes,
            monto: Number(cuota.monto),
            monto_pagado: Number(cuota.monto_pagado || 0),
            estado_cuota: cuota.estado_cuota,
            // Aparte de estado_periodo: un mes 'pagado' puede seguir sin factura
            // si el abono se registró antes que el comprobante.
            facturada: cuotaFacturada.has(cuota.id),
            // Con qué ascensores se aprobó (null = todos, cuota anterior a la opción).
            ascensores_mes: fotoCuota,
            ascensores_excluidos: excluidos
          }
        : null,
      estado_periodo
    };
  });

  return {
    id_cobro: plan.cobro?.id || null,
    modo_precio: cobraPorAscensor ? MODO_PRECIO_POR_ASCENSOR : MODO_PRECIO_MENSUAL,
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
      modo_precio: plan.modo_precio,
      moneda: plan.moneda
    }, mesesCobrables, montosPorMes),
    meses
  };
}

/**
 * Desglose de un mes tal como se facturó: deja fuera los ascensores excluidos
 * al aprobarlo (cuota.ascensores_excluidos) y recuenta las visitas.
 */
function desgloseFacturado(mes) {
  const excluidos = new Set(mes.cuota?.ascensores_excluidos || []);
  if (excluidos.size === 0) {
    return { detalle: mes.detalle, total_visitas: mes.total_visitas, realizadas: mes.realizadas };
  }
  const detalle = mes.detalle.filter(d => !excluidos.has(Number(d.id_ascensor)));
  return {
    detalle,
    total_visitas: detalle.reduce((a, d) => a + d.visitas, 0),
    realizadas: detalle.reduce((a, d) => a + d.realizadas, 0)
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
    ...desgloseFacturado(mes)
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
      ...desgloseFacturado(mes)
    });
  }
  return salida;
}

module.exports = {
  round2,
  etiquetaMes,
  MODO_PRECIO_MENSUAL,
  MODO_PRECIO_POR_ASCENSOR,
  MODOS_PRECIO,
  esPlanPorAscensor,
  preciosDelPlan,
  montoDelMes,
  fotoAscensoresMes,
  montosPorMesDelPlan,
  totalesDelPlan,
  mesesConMantenimiento,
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

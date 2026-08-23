/**
 * PROGRAMACIÓN DE UN PLAN DE MANTENIMIENTO — SSoT del cálculo de fechas.
 * =====================================================================
 * Un plan se dimensiona en MESES y cubre N ascensores, cada uno con SU PROPIA
 * frecuencia. La programación es, por lo tanto, una serie por ascensor:
 *
 *   plan a 12 meses    ascensor A mensual     → 12 visitas
 *                      ascensor B trimestral  →  4 visitas
 *                      ascensor C quincenal   → 24 visitas
 *
 * Toda fecha generada pertenece a un MES DEL PLAN (`numero_mes`, 1..duración),
 * que es la unidad de facturación: un solo cobro por mes, con el detalle de
 * todas las visitas de ese mes (de todos los ascensores).
 *
 * EL MES DEL PLAN NO ES EL MES CALENDARIO. Es la ventana de un mes que arranca
 * en el aniversario de `fecha_inicio`: un plan que empieza el 25/01 tiene su
 * mes 1 del 25/01 al 24/02. Anclar así es lo que hace que los totales sean
 * exactos (quincenal → 2 por ventana, siempre) y que la facturación mensual no
 * dependa de si el plan arrancó a principio o a fin de mes.
 *
 * Todo el cálculo opera sobre strings 'YYYY-MM-DD' en aritmética UTC pura: son
 * días de calendario, no instantes, así que no hay huso que pueda correrlos.
 */

const { obtenerFrecuencia } = require('./frecuenciaMantenimiento');

/** 'YYYY-MM-DD' → Date a medianoche UTC. */
function _d(ymd) {
  return new Date(`${String(ymd).substring(0, 10)}T00:00:00.000Z`);
}

/** Date → 'YYYY-MM-DD' (UTC puro). */
function _s(date) {
  return date.toISOString().slice(0, 10);
}

/** Suma `n` días a un 'YYYY-MM-DD'. */
function addDias(ymd, n) {
  const d = _d(ymd);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return _s(d);
}

/**
 * Suma `n` meses a un 'YYYY-MM-DD' conservando el día del mes; si el mes
 * destino es más corto, cae al último día (31/01 + 1 mes → 28/02).
 */
function addMeses(ymd, n) {
  const d = _d(ymd);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(n || 0));
  const ultimoDia = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimoDia));
  return _s(d);
}

/**
 * Ancla del mes `m` (1-based) de un plan: el día en que arranca esa ventana.
 * ancla(1) === fechaInicio.
 */
function anclaMes(fechaInicioYMD, m) {
  return addMeses(fechaInicioYMD, m - 1);
}

/**
 * Ventana [desde, hasta] (ambos inclusive) del mes `m` del plan.
 */
function ventanaMes(fechaInicioYMD, m) {
  const desde = anclaMes(fechaInicioYMD, m);
  const hasta = addDias(anclaMes(fechaInicioYMD, m + 1), -1);
  return { numero_mes: m, desde, hasta };
}

/**
 * Ventanas de los `duracionMeses` meses del plan, en orden.
 */
function ventanasDelPlan(fechaInicioYMD, duracionMeses) {
  const n = Number(duracionMeses);
  if (!Number.isInteger(n) || n < 1) return [];
  return Array.from({ length: n }, (_, i) => ventanaMes(fechaInicioYMD, i + 1));
}

/**
 * Mes del plan (1-based) al que pertenece una fecha, o null si cae fuera del
 * horizonte. Búsqueda por ventanas: la fecha pertenece al mes `m` si
 * ancla(m) <= fecha < ancla(m+1).
 */
function mesDeFecha(fechaInicioYMD, duracionMeses, ymd) {
  const f = String(ymd).substring(0, 10);
  if (f < fechaInicioYMD) return null;
  const n = Number(duracionMeses);
  for (let m = 1; m <= n; m++) {
    if (f < anclaMes(fechaInicioYMD, m + 1)) return m;
  }
  return null;
}

/**
 * Genera la programación de UN ascensor dentro del plan.
 *
 * @param {object} args
 * @param {string} args.fechaInicioYMD  Inicio del plan ('YYYY-MM-DD').
 * @param {string} args.frecuencia      Código de frecuencia del ascensor.
 * @param {number} [args.frecuenciaDiasCustom] Requerido si frecuencia === 'custom'.
 * @param {number} args.duracionMeses   Meses que dura el plan.
 * @returns {Array<{ordinal:number, numero_mes:number, fecha:string}>}
 */
function programacionDeAscensor({ fechaInicioYMD, frecuencia, frecuenciaDiasCustom, duracionMeses }) {
  const f = obtenerFrecuencia(frecuencia);
  if (!f) throw new Error(`Frecuencia desconocida: ${frecuencia}`);
  const meses = Number(duracionMeses);
  if (!Number.isInteger(meses) || meses < 1) {
    throw new Error('La duración del plan debe ser un entero de meses >= 1');
  }
  const inicio = String(fechaInicioYMD).substring(0, 10);
  const fin = anclaMes(inicio, meses + 1); // exclusivo: primer día fuera del plan
  const fechas = [];

  if (f.cada_meses) {
    // Una visita cada N meses del plan: meses 1, 1+N, 1+2N…
    for (let m = 1; m <= meses; m += f.cada_meses) {
      fechas.push({ numero_mes: m, fecha: anclaMes(inicio, m) });
    }
  } else if (f.por_mes && Array.isArray(f.offsets_dia)) {
    // N visitas dentro de cada mes del plan, a partir del ancla del mes. El
    // filtro contra el ancla del mes siguiente garantiza que una visita nunca
    // se desborde a la ventana de al lado (lo que descuadraría el conteo).
    for (let m = 1; m <= meses; m++) {
      const ancla = anclaMes(inicio, m);
      const limite = anclaMes(inicio, m + 1);
      for (const off of f.offsets_dia) {
        const fecha = addDias(ancla, off);
        if (fecha < limite) fechas.push({ numero_mes: m, fecha });
      }
    }
  } else {
    // Paso ciego de días (diaria / custom): se recorre el horizonte completo y
    // cada fecha se asigna a la ventana que la contiene.
    const pasoDias = f.codigo === 'custom' ? Number(frecuenciaDiasCustom) : f.paso;
    if (!Number.isInteger(pasoDias) || pasoDias <= 0) {
      throw new Error('frecuencia_dias_custom debe ser un entero positivo para frecuencia "custom"');
    }
    let cursor = inicio;
    while (cursor < fin) {
      fechas.push({ numero_mes: mesDeFecha(inicio, meses, cursor), fecha: cursor });
      cursor = addDias(cursor, pasoDias);
    }
  }

  fechas.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  return fechas.map((x, i) => ({ ordinal: i + 1, numero_mes: x.numero_mes, fecha: x.fecha }));
}

/**
 * Genera la programación COMPLETA del plan: la serie de cada ascensor, con su
 * propia frecuencia, dentro del mismo horizonte de meses.
 *
 * @param {object} args
 * @param {string} args.fechaInicioYMD
 * @param {number} args.duracionMeses
 * @param {Array<{id_ascensor:number, frecuencia:string, frecuencia_dias_custom?:number}>} args.ascensores
 * @returns {Array<{id_ascensor:number, ordinal:number, numero_mes:number, fecha:string}>}
 *          Ordenado por fecha y, dentro de una fecha, por ascensor.
 */
function programacionDelPlan({ fechaInicioYMD, duracionMeses, ascensores }) {
  const filas = [];
  for (const a of ascensores || []) {
    const serie = programacionDeAscensor({
      fechaInicioYMD,
      frecuencia: a.frecuencia,
      frecuenciaDiasCustom: a.frecuencia_dias_custom,
      duracionMeses
    });
    for (const s of serie) {
      filas.push({ id_ascensor: Number(a.id_ascensor), ordinal: s.ordinal, numero_mes: s.numero_mes, fecha: s.fecha });
    }
  }
  filas.sort((x, y) =>
    x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.id_ascensor - y.id_ascensor
  );
  return filas;
}

module.exports = {
  addDias,
  addMeses,
  anclaMes,
  ventanaMes,
  ventanasDelPlan,
  mesDeFecha,
  programacionDeAscensor,
  programacionDelPlan
};

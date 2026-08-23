/**
 * Programación de los días de trabajo de un servicio.
 *
 * Un trabajo no siempre ocupa días corridos: puede ser un RANGO (10–14 de
 * agosto), FECHAS SUELTAS (10, 15 y 20 de agosto) o cualquier combinación de
 * ambos (un rango + fechas sueltas, o varios rangos). Este módulo es el ÚNICO
 * lugar que interpreta esa entrada: la normaliza a la lista ordenada de días
 * únicos ('YYYY-MM-DD') que se materializa en `tbl_servicios_dias` y, desde ahí,
 * en el calendario del técnico (un evento por día programado).
 *
 * La operación inversa (`agruparEnTramos`) reconstruye los tramos desde las
 * fechas guardadas, para que el formulario los muestre tal como se cargaron sin
 * tener que persistir la definición aparte: la SSoT son las fechas.
 */

const { ymdDeFecha, addDiasYMD } = require('./tiempo');

// Techo de seguridad: un rango mal tecleado (2026 en vez de 2016) no debe
// generar miles de días ni de eventos de calendario.
const MAX_DIAS_PROGRAMADOS = 366;

const RE_YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Error de validación de la programación; el caller lo traduce a un 400. */
class ProgramacionInvalidaError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.code = 'PROGRAMACION_INVALIDA';
  }
}

/**
 * 'YYYY-MM-DD' de una entrada suelta (string ISO o Date), o null si no es una
 * fecha reconocible. No lanza: quien valida decide qué hacer con el null.
 */
function ymdDeEntrada(valor) {
  if (valor == null || valor === '') return null;
  if (valor instanceof Date) return ymdDeFecha(valor);
  const s = String(valor).substring(0, 10);
  if (!RE_YMD.test(s)) return null;
  // Descarta fechas imposibles ('2026-02-31'): el round-trip por Date cambia el
  // día si el calendario no admite la combinación.
  const d = new Date(`${s}T00:00:00.000Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

/** Todas las fechas de un rango inclusivo [desde, hasta]. */
function expandirRango(desde, hasta) {
  const fechas = [];
  let actual = desde;
  while (actual <= hasta) {
    fechas.push(actual);
    if (fechas.length > MAX_DIAS_PROGRAMADOS) break;
    actual = addDiasYMD(actual, 1);
  }
  return fechas;
}

/** Extrae [desde, hasta] de un item de tramo, tolerando los alias de nombres. */
function limitesDeTramo(item) {
  const desde = ymdDeEntrada(item.desde ?? item.inicio ?? item.fecha_inicio ?? item.fecha ?? item.from);
  const hasta = ymdDeEntrada(item.hasta ?? item.fin ?? item.fecha_fin ?? item.to ?? item.desde ?? item.inicio ?? item.fecha_inicio ?? item.fecha);
  return { desde, hasta };
}

/**
 * Normaliza la programación recibida del cliente a fechas ordenadas y únicas.
 *
 * Acepta, en cualquier combinación:
 *   - array de items: 'YYYY-MM-DD' | Date | { desde, hasta } | { fecha }
 *   - objeto { fechas: [...], rangos: [...] } (alias: { dias, tramos })
 *
 * @returns {string[]|null} fechas 'YYYY-MM-DD' ascendentes y sin repetir, o
 *   null si no se envió programación (el caller conserva la que ya había).
 * @throws {ProgramacionInvalidaError} si algún tramo es inválido o el total
 *   excede MAX_DIAS_PROGRAMADOS.
 */
function normalizarProgramacion(entrada) {
  if (entrada == null) return null;

  let items;
  if (Array.isArray(entrada)) {
    items = entrada;
  } else if (typeof entrada === 'object') {
    const sueltas = entrada.fechas ?? entrada.dias ?? [];
    const rangos = entrada.rangos ?? entrada.tramos ?? [];
    if (!Array.isArray(sueltas) || !Array.isArray(rangos)) {
      throw new ProgramacionInvalidaError('Programación inválida: `fechas` y `rangos` deben ser listas');
    }
    items = [...sueltas, ...rangos];
  } else {
    throw new ProgramacionInvalidaError('Programación inválida: se esperaba una lista de fechas o tramos');
  }

  // Lista vacía = "no programar nada": se distingue de `null` (no se envió) y se
  // rechaza aquí para que ningún flujo deje un servicio programado sin días.
  if (items.length === 0) {
    throw new ProgramacionInvalidaError('Debe indicar al menos un día de trabajo');
  }

  const set = new Set();
  for (const item of items) {
    if (item == null || item === '') continue;

    if (typeof item === 'string' || item instanceof Date) {
      const ymd = ymdDeEntrada(item);
      if (!ymd) throw new ProgramacionInvalidaError(`Fecha inválida: ${item}`);
      set.add(ymd);
      continue;
    }

    if (typeof item !== 'object') {
      throw new ProgramacionInvalidaError(`Tramo inválido: ${item}`);
    }

    const { desde, hasta } = limitesDeTramo(item);
    if (!desde || !hasta) {
      throw new ProgramacionInvalidaError('Cada tramo necesita una fecha de inicio (y de fin, si es un rango) válida');
    }
    if (hasta < desde) {
      throw new ProgramacionInvalidaError(`El tramo ${desde} → ${hasta} termina antes de empezar`);
    }
    for (const f of expandirRango(desde, hasta)) set.add(f);
    if (set.size > MAX_DIAS_PROGRAMADOS) {
      throw new ProgramacionInvalidaError(`La programación no puede superar ${MAX_DIAS_PROGRAMADOS} días`);
    }
  }

  if (set.size === 0) {
    throw new ProgramacionInvalidaError('Debe indicar al menos un día de trabajo');
  }
  return [...set].sort();
}

/**
 * Agrupa fechas ordenadas en tramos consecutivos. Inversa de la normalización:
 * ['2026-08-10','2026-08-11','2026-08-15'] → [{desde:'…-10',hasta:'…-11',dias:2},
 *                                             {desde:'…-15',hasta:'…-15',dias:1}]
 */
function agruparEnTramos(fechas) {
  const orden = [...new Set((fechas || []).map(ymdDeEntrada).filter(Boolean))].sort();
  const tramos = [];
  for (const f of orden) {
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && addDiasYMD(ultimo.hasta, 1) === f) {
      ultimo.hasta = f;
      ultimo.dias += 1;
    } else {
      tramos.push({ desde: f, hasta: f, dias: 1 });
    }
  }
  return tramos;
}

/** true si las fechas son un bloque de días corridos (programación "clásica"). */
function esProgramacionConsecutiva(fechas) {
  return agruparEnTramos(fechas).length <= 1;
}

/** Días de calendario entre dos 'YYYY-MM-DD' (b - a). */
function diasEntreYMD(a, b) {
  const ya = ymdDeEntrada(a);
  const yb = ymdDeEntrada(b);
  if (!ya || !yb) return 0;
  const da = new Date(`${ya}T00:00:00.000Z`).getTime();
  const db = new Date(`${yb}T00:00:00.000Z`).getTime();
  return Math.round((db - da) / 86400000);
}

/** Desplaza todas las fechas `delta` días, conservando la forma de la programación. */
function desplazarFechas(fechas, delta) {
  const n = Number(delta) || 0;
  return (fechas || []).map(f => addDiasYMD(ymdDeEntrada(f), n)).filter(Boolean);
}

module.exports = {
  MAX_DIAS_PROGRAMADOS,
  ProgramacionInvalidaError,
  ymdDeEntrada,
  normalizarProgramacion,
  agruparEnTramos,
  esProgramacionConsecutiva,
  diasEntreYMD,
  desplazarFechas
};

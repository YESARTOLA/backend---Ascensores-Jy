/**
 * Frecuencias soportadas por los planes de mantenimiento.
 *
 * Fuente única de verdad para:
 *   - opciones disponibles (expuestas al frontend vía endpoint)
 *   - cálculo de la siguiente fecha programada
 *   - RENDIMIENTO MENSUAL de cada frecuencia (cuántas visitas aporta por mes),
 *     que es lo que consume `utils/programacionPlanMantenimiento.js` para
 *     generar la programación de un plan a N meses.
 *
 * Las claves coinciden con el valor almacenado en
 * tbl_mantenimientos_planes_ascensores.frecuencia (autoridad por ascensor) y,
 * como valor por defecto del plan, en tbl_mantenimientos_planes.frecuencia.
 * Para "custom" se requiere además frecuencia_dias_custom > 0.
 *
 * MODELO DE PROGRAMACIÓN (por qué hay dos familias de metadatos)
 * -------------------------------------------------------------
 * El plan se dimensiona en MESES, no en número de visitas. Un plan a 12 meses
 * con un ascensor mensual da 12 visitas, uno trimestral da 4 y uno quincenal
 * da 24. Para que esos totales sean exactos las fechas se anclan al mes del
 * plan (la ventana de un mes que arranca en el aniversario de fecha_inicio),
 * no a un paso ciego de días:
 *
 *   - `por_mes`   : frecuencias que rinden N visitas DENTRO de cada mes del
 *                   plan. `offsets_dia` son los días a sumar al ancla del mes.
 *                   quincenal → [0, 15] (2 por mes); semanal → [0,7,14,21].
 *   - `cada_meses`: frecuencias de una visita cada N meses del plan
 *                   (mensual 1, bimestral 2, trimestral 3, semestral 6, anual 12).
 *   - ninguno de los dos (diaria, custom): se recorren por paso de días dentro
 *                   del horizonte, y el mes de cada fecha se deduce de la
 *                   ventana que la contiene.
 */

const FRECUENCIAS = [
  { codigo: 'diaria',     etiqueta: 'Diaria',     unidad: 'dia',   paso: 1,  por_mes: null, offsets_dia: null,        cada_meses: null },
  { codigo: 'semanal',    etiqueta: 'Semanal',    unidad: 'dia',   paso: 7,  por_mes: 4,    offsets_dia: [0, 7, 14, 21], cada_meses: null },
  { codigo: 'quincenal',  etiqueta: 'Quincenal',  unidad: 'dia',   paso: 15, por_mes: 2,    offsets_dia: [0, 15],     cada_meses: null },
  { codigo: 'mensual',    etiqueta: 'Mensual',    unidad: 'mes',   paso: 1,  por_mes: 1,    offsets_dia: [0],         cada_meses: 1 },
  { codigo: 'bimestral',  etiqueta: 'Bimestral',  unidad: 'mes',   paso: 2,  por_mes: null, offsets_dia: null,        cada_meses: 2 },
  { codigo: 'trimestral', etiqueta: 'Trimestral', unidad: 'mes',   paso: 3,  por_mes: null, offsets_dia: null,        cada_meses: 3 },
  { codigo: 'semestral',  etiqueta: 'Semestral',  unidad: 'mes',   paso: 6,  por_mes: null, offsets_dia: null,        cada_meses: 6 },
  { codigo: 'anual',      etiqueta: 'Anual',      unidad: 'mes',   paso: 12, por_mes: null, offsets_dia: null,        cada_meses: 12 },
  { codigo: 'custom',     etiqueta: 'Personalizada (días)', unidad: 'custom', paso: null, por_mes: null, offsets_dia: null, cada_meses: null }
];

const POR_CODIGO = Object.fromEntries(FRECUENCIAS.map(f => [f.codigo, f]));

function obtenerFrecuencia(codigo) {
  return POR_CODIGO[codigo] || null;
}

function _sumarDias(fecha, n) {
  const d = new Date(fecha);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function _sumarMeses(fecha, n) {
  const d = new Date(fecha);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const ultimoDiaDestino = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimoDiaDestino));
  return d;
}

function siguienteFecha(fechaActual, frecuencia, frecuenciaDiasCustom) {
  const f = obtenerFrecuencia(frecuencia);
  if (!f) throw new Error(`Frecuencia desconocida: ${frecuencia}`);
  if (f.unidad === 'dia') return _sumarDias(fechaActual, f.paso);
  if (f.unidad === 'mes') return _sumarMeses(fechaActual, f.paso);
  if (f.unidad === 'custom') {
    const n = Number(frecuenciaDiasCustom);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('frecuencia_dias_custom debe ser un entero positivo para frecuencia "custom"');
    }
    return _sumarDias(fechaActual, n);
  }
  throw new Error(`Unidad de frecuencia no soportada: ${f.unidad}`);
}

/**
 * Devuelve un arreglo de Date con las fechas programadas a partir de
 * fechaInicio (inclusive), aplicando la frecuencia hasta completar
 * `cantidad` fechas.
 *
 * Se conserva para los consumidores que razonan en "N ocurrencias" (proyección
 * de reportes). La programación real de un plan se genera con
 * `utils/programacionPlanMantenimiento.js`, que razona en meses.
 */
function calcularFechasProgramacion(fechaInicio, frecuencia, frecuenciaDiasCustom, cantidad) {
  const n = Number(cantidad);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('cantidad debe ser entero >= 1');
  }
  const fechas = [new Date(fechaInicio)];
  for (let i = 1; i < n; i++) {
    fechas.push(siguienteFecha(fechas[i - 1], frecuencia, frecuenciaDiasCustom));
  }
  return fechas;
}

/**
 * Cuántas visitas aporta una frecuencia a lo largo de `meses` meses de plan.
 * Es el dato que la UI muestra al armar el plan ("mensual × 12 = 12 visitas")
 * y el que usa la migración para derivar el monto mensual equivalente.
 *
 * Para frecuencias por paso de días (diaria / custom) el total es aproximado
 * al calendario real y se obtiene generando la serie, así que se delega en el
 * generador para no duplicar la regla.
 *
 * @returns {number} visitas totales (0 si la frecuencia no es válida)
 */
function visitasEnMeses(frecuencia, frecuenciaDiasCustom, meses) {
  const f = obtenerFrecuencia(frecuencia);
  const m = Number(meses);
  if (!f || !Number.isInteger(m) || m < 1) return 0;
  if (f.por_mes && f.cada_meses === null) return f.por_mes * m;
  if (f.cada_meses) return Math.ceil(m / f.cada_meses);
  // diaria / custom: paso en días; se aproxima con 30.4375 días por mes.
  const pasoDias = f.codigo === 'custom' ? Number(frecuenciaDiasCustom) : f.paso;
  if (!Number.isInteger(pasoDias) || pasoDias <= 0) return 0;
  return Math.ceil((m * 30.4375) / pasoDias);
}

/**
 * Inversa de `visitasEnMeses`: cuántos MESES de plan hacen falta para que una
 * frecuencia rinda `visitas` mantenimientos.
 *
 * La usan los flujos que aún razonan en "N mantenimientos" (la conversión de
 * una cotización en plan, y la migración de los planes antiguos) para pasar al
 * modelo mensual conservando el horizonte del contrato:
 *   mensual × 12 → 12 meses    ·    trimestral × 4 → 12 meses
 *   bimestral × 6 → 12 meses   ·    quincenal × 24 → 12 meses
 *
 * @returns {number} meses (mínimo 1)
 */
function mesesParaVisitas(frecuencia, frecuenciaDiasCustom, visitas) {
  const f = obtenerFrecuencia(frecuencia);
  const n = Number(visitas);
  if (!f || !Number.isFinite(n) || n < 1) return 1;
  if (f.por_mes && !f.cada_meses) return Math.max(1, Math.ceil(n / f.por_mes));
  if (f.cada_meses) return Math.max(1, n * f.cada_meses);
  const pasoDias = f.codigo === 'custom' ? Number(frecuenciaDiasCustom) : f.paso;
  if (!Number.isInteger(pasoDias) || pasoDias <= 0) return 1;
  return Math.max(1, Math.ceil((n * pasoDias) / 30.4375));
}

module.exports = {
  FRECUENCIAS,
  obtenerFrecuencia,
  siguienteFecha,
  calcularFechasProgramacion,
  visitasEnMeses,
  mesesParaVisitas
};

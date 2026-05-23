/**
 * Frecuencias soportadas por los planes de mantenimiento.
 *
 * Fuente única de verdad para:
 *   - opciones disponibles (expuestas al frontend vía endpoint)
 *   - cálculo de la siguiente fecha programada
 *
 * Las claves coinciden con el valor almacenado en
 * tbl_mantenimientos_planes.frecuencia. Para "custom" el plan debe
 * llevar además frecuencia_dias_custom > 0.
 */

const FRECUENCIAS = [
  { codigo: 'diaria',     etiqueta: 'Diaria',     unidad: 'dia',   paso: 1  },
  { codigo: 'semanal',    etiqueta: 'Semanal',    unidad: 'dia',   paso: 7  },
  { codigo: 'quincenal',  etiqueta: 'Quincenal',  unidad: 'dia',   paso: 15 },
  { codigo: 'mensual',    etiqueta: 'Mensual',    unidad: 'mes',   paso: 1  },
  { codigo: 'bimestral',  etiqueta: 'Bimestral',  unidad: 'mes',   paso: 2  },
  { codigo: 'trimestral', etiqueta: 'Trimestral', unidad: 'mes',   paso: 3  },
  { codigo: 'semestral',  etiqueta: 'Semestral',  unidad: 'mes',   paso: 6  },
  { codigo: 'anual',      etiqueta: 'Anual',      unidad: 'mes',   paso: 12 },
  { codigo: 'custom',     etiqueta: 'Personalizada (días)', unidad: 'custom', paso: null }
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

module.exports = {
  FRECUENCIAS,
  obtenerFrecuencia,
  siguienteFecha,
  calcularFechasProgramacion
};

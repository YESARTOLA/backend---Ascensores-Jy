/**
 * N° de operación de los pagos de una factura (tbl_facturas.numeros_operacion):
 * el código de la transferencia, del depósito, del Yape… Una factura puede
 * cobrarse en varios pagos, así que guarda una LISTA.
 *
 * Espejo de la limpieza en frontend/src/components/facturas/NumerosOperacion.jsx.
 */

/** Largo máximo de cada número (los bancos usan 6–20 caracteres). */
const MAX_LARGO_NUMERO_OPERACION = 60;
/** Tope de números por factura: solo una barrera contra payloads absurdos. */
const MAX_NUMEROS_OPERACION = 200;

function errorHttp(mensaje, codigoHttp = 400) {
  const err = new Error(mensaje);
  err.codigoHttp = codigoHttp;
  return err;
}

/**
 * Lista limpia de N° de operación: recortados, sin vacíos y sin repetidos (el
 * mismo número escrito dos veces es una sola operación). Conserva el orden en
 * que se escribieron. Lanza 400 si algún número excede el largo o la lista el tope.
 *
 * @param {unknown} crudo  arreglo de textos (lo demás se trata como lista vacía)
 * @returns {string[]}
 */
function normalizarNumerosOperacion(crudo) {
  if (crudo === undefined || crudo === null) return [];
  if (!Array.isArray(crudo)) throw errorHttp('Los N° de operación deben enviarse como una lista.');
  const vistos = new Set();
  const lista = [];
  for (const v of crudo) {
    if (v === null || v === undefined) continue;
    const numero = String(v).trim();
    if (!numero) continue;
    if (numero.length > MAX_LARGO_NUMERO_OPERACION) {
      throw errorHttp(`El N° de operación «${numero.slice(0, 20)}…» excede ${MAX_LARGO_NUMERO_OPERACION} caracteres.`);
    }
    const clave = numero.toUpperCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    lista.push(numero);
  }
  if (lista.length > MAX_NUMEROS_OPERACION) {
    throw errorHttp(`Máximo ${MAX_NUMEROS_OPERACION} N° de operación por factura.`);
  }
  return lista;
}

/** ¿Dos listas de N° de operación son la misma (mismo contenido y orden)? */
function mismosNumerosOperacion(a, b) {
  const x = a || [];
  const y = b || [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

module.exports = {
  MAX_LARGO_NUMERO_OPERACION,
  MAX_NUMEROS_OPERACION,
  normalizarNumerosOperacion,
  mismosNumerosOperacion
};

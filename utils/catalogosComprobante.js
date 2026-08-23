/**
 * Catálogo único de TIPOS DE COMPROBANTE de venta.
 * Espejo de frontend/src/utils/catalogosComprobante.js — mantener en sincronía.
 *
 * En Perú el comprobante que corresponde depende de quién recibe:
 *   · Factura → contribuyentes con RUC (empresas, juntas de propietarios…).
 *   · Boleta  → consumidor final, identificado con DNI.
 *
 * Esa correspondencia se usa solo para SUGERIR el tipo al emitir (ver
 * `tipoComprobanteSugerido`): quien emite puede cambiarlo, porque hay casos
 * legítimos en ambos sentidos. No se valida contra el documento del cliente.
 *
 * `serie_prefijo` es la letra con la que arranca la serie del comprobante
 * (F001-000123 / B001-000123); alimenta el placeholder del formulario.
 */
const TIPO_COMPROBANTE_FACTURA = 'Factura';
const TIPO_COMPROBANTE_BOLETA = 'Boleta';

const TIPOS_COMPROBANTE = [
  { codigo: TIPO_COMPROBANTE_FACTURA, etiqueta: 'Factura', serie_prefijo: 'F', documento: 'RUC' },
  { codigo: TIPO_COMPROBANTE_BOLETA,  etiqueta: 'Boleta',  serie_prefijo: 'B', documento: 'DNI' }
];

const TIPOS_COMPROBANTE_CODIGOS = TIPOS_COMPROBANTE.map(t => t.codigo);

// El histórico anterior a esta funcionalidad son todas facturas: es el default
// de la columna y el valor con el que se rellenaron las filas existentes.
const TIPO_COMPROBANTE_POR_DEFECTO = TIPO_COMPROBANTE_FACTURA;

function esTipoComprobanteValido(tipo) {
  return TIPOS_COMPROBANTE_CODIGOS.includes(tipo);
}

/** Normaliza lo que llega del cliente HTTP; sin valor válido → Factura. */
function normalizarTipoComprobante(tipo) {
  return esTipoComprobanteValido(tipo) ? tipo : TIPO_COMPROBANTE_POR_DEFECTO;
}

/**
 * Tipo que corresponde por el documento del receptor. Solo es una sugerencia
 * para el formulario de emisión.
 * @param {string} tipoDocumento 'RUC' | 'DNI' | otro
 */
function tipoComprobanteSugerido(tipoDocumento) {
  return String(tipoDocumento || '').toUpperCase() === 'DNI'
    ? TIPO_COMPROBANTE_BOLETA
    : TIPO_COMPROBANTE_FACTURA;
}

module.exports = {
  TIPO_COMPROBANTE_FACTURA,
  TIPO_COMPROBANTE_BOLETA,
  TIPOS_COMPROBANTE,
  TIPOS_COMPROBANTE_CODIGOS,
  TIPO_COMPROBANTE_POR_DEFECTO,
  esTipoComprobanteValido,
  normalizarTipoComprobante,
  tipoComprobanteSugerido
};

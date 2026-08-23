// Catálogo único de estados de facturación.
// Espejo de frontend/src/utils/estadoFactura.js — mantener ambos en sincronía.

// Estados de una factura individual (tbl_facturas.estado_factura).
const ESTADO_FACTURA_SIN = 'Sin factura';
const ESTADO_FACTURA_PENDIENTE = 'Pendiente de emitir';
const ESTADO_FACTURA_EMITIDA = 'Emitida';
const ESTADO_FACTURA_ENVIADA = 'Enviada';
const ESTADO_FACTURA_ADJUNTA = 'Adjunta';
const ESTADO_FACTURA_OBSERVADA = 'Observada';
const ESTADO_FACTURA_ANULADA = 'Anulada';

const ESTADOS_FACTURA = [
  ESTADO_FACTURA_SIN,
  ESTADO_FACTURA_PENDIENTE,
  ESTADO_FACTURA_EMITIDA,
  ESTADO_FACTURA_ENVIADA,
  ESTADO_FACTURA_ADJUNTA,
  ESTADO_FACTURA_OBSERVADA,
  ESTADO_FACTURA_ANULADA
];

// Estado agregado de facturación a nivel servicio (tbl_servicios_realizados.estado_facturacion).
const ESTADO_FACTURACION_SIN = 'Sin factura';
const ESTADO_FACTURACION_PENDIENTE = 'Pendiente de emitir';
const ESTADO_FACTURACION_PARCIAL = 'Parcialmente facturado';
const ESTADO_FACTURACION_FACTURADO = 'Facturado';
const ESTADO_FACTURACION_ENVIADA = 'Enviada';

// Conjunto de estados que se consideran "facturado completo" para conteos y
// filtros agregados (dashboard, reportes, transiciones de servicio).
const ESTADOS_FACTURACION_COMPLETA = [
  ESTADO_FACTURACION_FACTURADO,
  ESTADO_FACTURACION_ENVIADA
];

// Estados en los que la emisión del comprobante TODAVÍA no está completa.
// 'Parcialmente facturado' entra aquí: quedan cuotas por emitir.
const ESTADOS_FACTURACION_PENDIENTE_EMISION = [
  ESTADO_FACTURACION_SIN,
  ESTADO_FACTURACION_PENDIENTE,
  ESTADO_FACTURACION_PARCIAL
];

/**
 * ¿Este servicio realizado está PENDIENTE DE FACTURAR?
 *
 * No basta con que su estado sea 'Sin factura': la mayoría de los servicios en
 * ese estado están marcados "no requiere factura" (requiere_factura = 0) o son
 * gratuitos, y no se van a facturar nunca. "Por facturar" es la emisión que
 * realmente queda pendiente.
 *
 * @param {object} realizado Fila de tbl_servicios_realizados con su `servicio`.
 */
function esPorFacturar(realizado) {
  const srv = realizado?.servicio;
  if (!srv) return false;
  if (srv.requiere_factura === 0) return false;
  if (srv.sin_cobro === 1) return false;
  return ESTADOS_FACTURACION_PENDIENTE_EMISION.includes(realizado.estado_facturacion);
}

function esEstadoFacturaValido(estado) {
  return ESTADOS_FACTURA.includes(estado);
}

function esFacturaActiva(factura) {
  if (!factura) return false;
  if (factura.estado !== undefined && factura.estado !== 1) return false;
  return factura.estado_factura !== ESTADO_FACTURA_ANULADA;
}

function esFacturado(estadoFacturacion) {
  return ESTADOS_FACTURACION_COMPLETA.includes(estadoFacturacion);
}

/**
 * Calcula el estado_facturacion agregado a partir de las facturas + cuotas
 * activas de un cobro. Punto único de la verdad para sincronizar
 * tbl_servicios_realizados.estado_facturacion cada vez que cambia una factura.
 *
 * Reglas:
 *  - Sin facturas activas → 'Sin factura'.
 *  - Si hay factura general (id_cuota = null):
 *      - todas (la única) en 'Enviada' → 'Enviada'
 *      - caso contrario                → 'Facturado'
 *  - Si la facturación es por cuota:
 *      - alguna cuota activa sin factura → 'Parcialmente facturado'
 *      - todas las cuotas facturadas y todas las facturas en 'Enviada' → 'Enviada'
 *      - todas facturadas con al menos una no enviada → 'Facturado'
 */
function calcularEstadoFacturacion({ facturas, cuotas }) {
  const activas = (facturas || []).filter(esFacturaActiva);
  if (activas.length === 0) return ESTADO_FACTURACION_SIN;

  const general = activas.find(f => f.id_cuota === null || f.id_cuota === undefined);
  if (general) {
    return general.estado_factura === ESTADO_FACTURA_ENVIADA
      ? ESTADO_FACTURACION_ENVIADA
      : ESTADO_FACTURACION_FACTURADO;
  }

  const cuotasActivas = (cuotas || []).filter(c => (c.estado ?? 1) === 1);
  const cuotasFacturadas = new Set(activas.map(f => f.id_cuota));
  const todasFacturadas =
    cuotasActivas.length > 0 && cuotasActivas.every(c => cuotasFacturadas.has(c.id));
  if (!todasFacturadas) return ESTADO_FACTURACION_PARCIAL;

  const todasEnviadas = activas.every(f => f.estado_factura === ESTADO_FACTURA_ENVIADA);
  return todasEnviadas ? ESTADO_FACTURACION_ENVIADA : ESTADO_FACTURACION_FACTURADO;
}

module.exports = {
  ESTADO_FACTURA_SIN,
  ESTADO_FACTURA_PENDIENTE,
  ESTADO_FACTURA_EMITIDA,
  ESTADO_FACTURA_ENVIADA,
  ESTADO_FACTURA_ADJUNTA,
  ESTADO_FACTURA_OBSERVADA,
  ESTADO_FACTURA_ANULADA,
  ESTADOS_FACTURA,
  ESTADO_FACTURACION_SIN,
  ESTADO_FACTURACION_PENDIENTE,
  ESTADO_FACTURACION_PARCIAL,
  ESTADO_FACTURACION_FACTURADO,
  ESTADO_FACTURACION_ENVIADA,
  ESTADOS_FACTURACION_COMPLETA,
  ESTADOS_FACTURACION_PENDIENTE_EMISION,
  esPorFacturar,
  esEstadoFacturaValido,
  esFacturaActiva,
  esFacturado,
  calcularEstadoFacturacion
};

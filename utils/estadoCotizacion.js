// Catálogo único de estados de una COTIZACIÓN.
//
// Espejo de frontend/src/utils/estadoCotizacion.js — mantener ambos en
// sincronía. Antes estos valores vivían dentro de cotizacionesController y el
// frontend los repetía a mano en un array literal, así que el filtro del
// listado podía quedar desalineado con lo que el backend realmente escribe.
//
// Hay DOS ejes independientes:
//
//  - `estado_version` (tbl_cotizaciones_versiones): dónde está cada versión del
//    documento comercial. Lo mueve una acción explícita del usuario
//    (aprobar / rechazar).
//
//  - `estado_global` (tbl_cotizaciones): dónde está la cotización dentro del
//    ciclo operativo. Es DERIVADO del servicio asociado y su cobro — se
//    recalcula con `sincronizarEstadoGlobal`, nunca se setea a mano. La única
//    excepción es 'Anulado', que es terminal y lo fija la eliminación.

const ESTADOS_VERSION = {
  COTIZADO: 'Cotizado',
  APROBADO: 'Aprobado',
  RECHAZADO: 'Rechazado'
};

const ESTADO_GLOBAL = {
  COTIZADO: 'Cotizado',
  ACEPTADO: 'Aceptado',
  EJECUCION: 'Ejecución',
  PENDIENTE: 'Pendiente',
  TERMINADO: 'Terminado',
  // Terminal: la cotización fue eliminada (baja lógica) pero se conserva visible
  // en el listado como historial; sus servicios generados quedan anulados.
  ANULADO: 'Anulado'
};

// Orden de presentación en filtros y selects: sigue el ciclo de vida real, no
// el alfabético. Es lo que consume el listado vía el endpoint de catálogos.
const ESTADOS_GLOBALES = [
  ESTADO_GLOBAL.COTIZADO,
  ESTADO_GLOBAL.ACEPTADO,
  ESTADO_GLOBAL.EJECUCION,
  ESTADO_GLOBAL.PENDIENTE,
  ESTADO_GLOBAL.TERMINADO,
  ESTADO_GLOBAL.ANULADO
];

const ESTADOS_VERSION_LISTA = [
  ESTADOS_VERSION.COTIZADO,
  ESTADOS_VERSION.APROBADO,
  ESTADOS_VERSION.RECHAZADO
];

function esEstadoGlobalValido(estado) {
  return ESTADOS_GLOBALES.includes(estado);
}

function esEstadoVersionValido(estado) {
  return ESTADOS_VERSION_LISTA.includes(estado);
}

module.exports = {
  ESTADOS_VERSION,
  ESTADO_GLOBAL,
  ESTADOS_GLOBALES,
  ESTADOS_VERSION_LISTA,
  esEstadoGlobalValido,
  esEstadoVersionValido
};

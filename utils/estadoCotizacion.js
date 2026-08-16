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

// ----------------------------------------------------------------------------
// Filtros VIRTUALES del listado / exportación.
//
// No son estados que se escriban en la BD: son opciones del selector que
// agrupan varios estado_global reales bajo un solo `IN (...)`. Existen porque
// `estado_global` avanza (Aceptado → Ejecución → Pendiente → Terminado) y, al
// pasar el servicio a ejecución, una cotización que el cliente SÍ aceptó deja
// de aparecer bajo el filtro exacto 'Aceptado'. Este agregado permite ver de un
// vistazo todas las que se aceptaron alguna vez, sin perder los filtros exactos.
//
// El `valor` ('Aprobadas') es el que viaja en la query; `despues_de` le dice al
// frontend tras qué opción real insertarlo en el selector.
const FILTRO_GLOBAL_APROBADAS = 'Aprobadas';

const FILTROS_GLOBALES = [
  {
    valor: FILTRO_GLOBAL_APROBADAS,
    etiqueta: 'Aceptadas (incluye ejecución)',
    despues_de: ESTADO_GLOBAL.ACEPTADO,
    estados: [
      ESTADO_GLOBAL.ACEPTADO,
      ESTADO_GLOBAL.EJECUCION,
      ESTADO_GLOBAL.PENDIENTE,
      ESTADO_GLOBAL.TERMINADO
    ]
  }
];

// Traduce un valor de filtro (real o virtual) al conjunto de estado_global
// reales que representa. Devuelve un array cuando es virtual, o null cuando el
// valor no es un filtro virtual (el caller debe tratarlo como estado exacto).
function resolverFiltroGlobal(valor) {
  const f = FILTROS_GLOBALES.find(x => x.valor === valor);
  return f ? f.estados : null;
}

// ----------------------------------------------------------------------------
// Semántica del rango de fechas del listado.
//
// Por defecto el rango filtra por FECHA DE CREACIÓN de la cotización. Pero
// cuando se está mirando el embudo ya aceptado, lo que interesa es CUÁNDO SE
// ACEPTÓ, no cuándo se registró: "aceptadas de agosto" son las que el cliente
// aprobó en agosto, sin importar que hoy estén en ejecución, pendientes o ya
// terminadas (ni en qué mes se cotizaron). Para esos filtros el rango se aplica
// sobre `fecha_aprobacion` de la versión aprobada.
const ESTADOS_GLOBALES_POST_ACEPTACION = [
  ESTADO_GLOBAL.ACEPTADO,
  ESTADO_GLOBAL.EJECUCION,
  ESTADO_GLOBAL.PENDIENTE,
  ESTADO_GLOBAL.TERMINADO
];

function rangoEsPorFechaAceptacion(valorFiltroGlobal) {
  if (!valorFiltroGlobal) return false;
  return valorFiltroGlobal === FILTRO_GLOBAL_APROBADAS
    || ESTADOS_GLOBALES_POST_ACEPTACION.includes(valorFiltroGlobal);
}

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
  FILTRO_GLOBAL_APROBADAS,
  FILTROS_GLOBALES,
  ESTADOS_GLOBALES_POST_ACEPTACION,
  resolverFiltroGlobal,
  rangoEsPorFechaAceptacion,
  esEstadoGlobalValido,
  esEstadoVersionValido
};

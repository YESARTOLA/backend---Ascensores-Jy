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

// Estados en los que el trabajo en campo YA TERMINÓ: el técnico cerró el
// servicio y todo lo que queda es circuito administrativo/contable (revisión,
// cobro, facturación) hasta el cierre. 'Pendiente' no es una etapa anterior a
// 'Terminado' en el trabajo: es la misma obra terminada, esperando plata.
const ESTADOS_GLOBALES_TRABAJO_TERMINADO = [
  ESTADO_GLOBAL.PENDIENTE,
  ESTADO_GLOBAL.TERMINADO
];

// ----------------------------------------------------------------------------
// Filtros INCLUSIVOS del listado / exportación.
//
// Un valor del selector no siempre significa `estado_global = <ese valor>`:
// algunos agrupan varias etapas del ciclo bajo un solo `IN (...)`. Existen
// porque `estado_global` AVANZA (Aceptado → Ejecución → Pendiente → Terminado)
// y con la igualdad estricta una cotización se cae del filtro apenas su
// servicio da el siguiente paso, aunque el hecho que el filtro busca siga
// siendo cierto.
//
// Hay dos clases, y `EXPANSION_FILTRO_GLOBAL` las resuelve a las dos igual:
//
//  - VIRTUALES: opciones que no existen como estado en la BD y se añaden al
//    selector (hoy solo 'Aprobadas'). Se declaran en `FILTROS_GLOBALES`, cuyo
//    `valor` es el que viaja en la query y cuyo `despues_de` le dice al
//    frontend tras qué opción real insertarlas.
//
//  - ESTADOS REALES CON ARRASTRE: opciones que sí son un estado_global, pero
//    cuya lectura natural abarca también las fases posteriores. 'Terminado' es
//    el caso: al pedir los servicios/proyectos terminados se esperan también
//    los que ya pasaron a una fase posterior — facturados, en cobro, en
//    revisión — que hoy figuran como 'Pendiente'. Para esos se sobrescribe la
//    etiqueta del selector (`ETIQUETAS_FILTRO_GLOBAL`) y así queda claro por
//    qué la lista trae badges distintos del filtro elegido.
const FILTRO_GLOBAL_APROBADAS = 'Aprobadas';

const FILTROS_GLOBALES = [
  {
    valor: FILTRO_GLOBAL_APROBADAS,
    etiqueta: 'Aceptadas (incluye ejecución)',
    despues_de: ESTADO_GLOBAL.ACEPTADO,
    estados: ESTADOS_GLOBALES_POST_ACEPTACION
  }
];

// Valor del selector → estados reales que representa.
const EXPANSION_FILTRO_GLOBAL = {
  [FILTRO_GLOBAL_APROBADAS]: ESTADOS_GLOBALES_POST_ACEPTACION,
  [ESTADO_GLOBAL.TERMINADO]: ESTADOS_GLOBALES_TRABAJO_TERMINADO
};

// Etiqueta con la que el selector pinta un estado REAL cuyo filtro arrastra
// fases posteriores. Los estados que no aparecen aquí se pintan con su nombre.
const ETIQUETAS_FILTRO_GLOBAL = {
  [ESTADO_GLOBAL.TERMINADO]: 'Terminado (incluye cobro/facturación)'
};

// Traduce un valor de filtro al conjunto de estado_global reales que
// representa. Devuelve un array cuando el filtro abarca más de un estado, o
// null cuando no hay expansión (el caller debe tratarlo como estado exacto).
function resolverFiltroGlobal(valor) {
  return EXPANSION_FILTRO_GLOBAL[valor] || null;
}

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
  ETIQUETAS_FILTRO_GLOBAL,
  ESTADOS_GLOBALES_POST_ACEPTACION,
  ESTADOS_GLOBALES_TRABAJO_TERMINADO,
  resolverFiltroGlobal,
  rangoEsPorFechaAceptacion,
  esEstadoGlobalValido,
  esEstadoVersionValido
};

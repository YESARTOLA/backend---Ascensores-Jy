// Catálogo único del filtro por estado de baja lógica (`estado` 1/0) que usan
// los listados restringidos al Super Admin.
//
// Espejo de frontend/src/utils/filtroEstadoRegistro.js — mantener ambos en
// sincronía. Traduce el código del filtro al fragmento `where` de Prisma para
// que ningún controlador vuelva a hardcodear `{ estado: 1 }`.

const FILTRO_ESTADO_ACTIVOS = 'activos';
const FILTRO_ESTADO_INACTIVOS = 'inactivos';
const FILTRO_ESTADO_TODOS = 'todos';

const FILTROS_ESTADO_REGISTRO = [
  { codigo: FILTRO_ESTADO_ACTIVOS, etiqueta: 'Estado: activos' },
  { codigo: FILTRO_ESTADO_INACTIVOS, etiqueta: 'Estado: inactivos' },
  { codigo: FILTRO_ESTADO_TODOS, etiqueta: 'Estado: todos' }
];

/**
 * Fragmento `where` para el filtro pedido. Devuelve `{}` (sin restricción) solo
 * para 'todos'. Cualquier valor desconocido —o la ausencia de filtro— cae en
 * 'activos', que es el comportamiento seguro por defecto.
 */
function whereEstadoDesdeFiltro(filtro) {
  if (filtro === FILTRO_ESTADO_TODOS) return {};
  if (filtro === FILTRO_ESTADO_INACTIVOS) return { estado: 0 };
  return { estado: 1 };
}

module.exports = {
  FILTROS_ESTADO_REGISTRO,
  FILTRO_ESTADO_ACTIVOS,
  FILTRO_ESTADO_INACTIVOS,
  FILTRO_ESTADO_TODOS,
  whereEstadoDesdeFiltro
};

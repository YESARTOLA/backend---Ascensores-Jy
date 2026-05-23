/**
 * Catálogos cerrados para clientes.
 *
 * CLASIFICACIONES: clasificación informativa del cliente. No afecta el flujo
 * operativo; sirve para filtrar y agrupar en reportes. Single source of truth
 * para backend (validación) y frontend (select + badge).
 */

const CLASIFICACIONES = [
  { codigo: 'grande',   etiqueta: 'Grande',   color: 'bg-violet-100 text-violet-800 ring-violet-200' },
  { codigo: 'pequeno',  etiqueta: 'Pequeño',  color: 'bg-sky-100 text-sky-800 ring-sky-200' },
  { codigo: 'marca_jy', etiqueta: 'Marca JY', color: 'bg-ember-100 text-ember-800 ring-ember-200' }
];

const CLASIFICACIONES_CODIGOS = CLASIFICACIONES.map(c => c.codigo);

module.exports = { CLASIFICACIONES, CLASIFICACIONES_CODIGOS };

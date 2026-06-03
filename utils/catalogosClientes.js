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

/**
 * TIPOS_CLIENTE: indica si el cliente es un Edificio o una Obra. Es informativo
 * y define la terminología que la UI muestra para el nombre y la dirección
 * (`nombre_label` / `direccion_label`), de modo que esas etiquetas no queden
 * hardcodeadas en el frontend. Single source of truth para backend (validación
 * + default) y frontend (select + badge + etiquetas dinámicas).
 */
const TIPOS_CLIENTE = [
  { codigo: 'Edificio', etiqueta: 'Edificio', color: 'bg-slate-100 text-slate-800 ring-slate-200', nombre_label: 'Nombre del edificio', direccion_label: 'Dirección del edificio' },
  { codigo: 'Obra',     etiqueta: 'Obra',     color: 'bg-amber-100 text-amber-800 ring-amber-200', nombre_label: 'Nombre de la obra',   direccion_label: 'Dirección de la obra' }
];

const TIPOS_CLIENTE_CODIGOS = TIPOS_CLIENTE.map(t => t.codigo);

// Default al registrar un cliente o ante un valor inválido. Coincide con el
// DEFAULT de la columna `tipo` en la base de datos.
const TIPO_CLIENTE_DEFAULT = TIPOS_CLIENTE[0].codigo;

module.exports = {
  CLASIFICACIONES,
  CLASIFICACIONES_CODIGOS,
  TIPOS_CLIENTE,
  TIPOS_CLIENTE_CODIGOS,
  TIPO_CLIENTE_DEFAULT
};

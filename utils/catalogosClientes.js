/**
 * Catálogos cerrados para clientes.
 *
 * CLASIFICACIONES: clasificación informativa del cliente. No afecta el flujo
 * operativo; sirve para filtrar y agrupar en reportes. Single source of truth
 * para backend (validación) y frontend (select + badge).
 */

// Los `color` son clases Tailwind; al ser strings servidos por la API no las ve
// el escáner de contenido. Mantener en sync con el safelist del frontend.
const CLASIFICACIONES = [
  { codigo: 'grande',    etiqueta: 'Grande',    color: 'bg-violet-100 text-violet-800 ring-violet-200' },
  { codigo: 'pequeno',   etiqueta: 'Pequeño',   color: 'bg-sky-100 text-sky-800 ring-sky-200' },
  { codigo: 'marca_jy',  etiqueta: 'Marca JY',  color: 'bg-ember-100 text-ember-800 ring-ember-200' },
  { codigo: 'glarie',    etiqueta: 'Glarie',    color: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  { codigo: 'proyectos', etiqueta: 'Proyectos', color: 'bg-amber-100 text-amber-800 ring-amber-200' }
];

const CLASIFICACIONES_CODIGOS = CLASIFICACIONES.map(c => c.codigo);

// El tipo Edificio/Obra ahora vive en el edificio, no en el cliente. Ver
// utils/catalogosEdificios.js (TIPOS_EDIFICIO).

module.exports = {
  CLASIFICACIONES,
  CLASIFICACIONES_CODIGOS
};

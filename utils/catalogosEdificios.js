/**
 * Catálogo cerrado de tipos de edificio.
 *
 * TIPOS_EDIFICIO: indica si la ubicación física es un Edificio o una Obra. Es
 * informativo y define la terminología que la UI muestra para el nombre y la
 * dirección (`nombre_label` / `direccion_label`), de modo que esas etiquetas no
 * queden hardcodeadas en el frontend. Single source of truth para backend
 * (validación + default) y frontend (select + badge + etiquetas dinámicas).
 */
// `flag` mapea cada tipo al campo de ámbito del usuario (tbl_usuarios) que habilita
// verlo. Es la SSoT del control "solo Edificios / solo Obras / ambos" del
// Administrador (ver utils/alcanceUsuario.js); evita hardcodear el mapeo.
const TIPOS_EDIFICIO = [
  { codigo: 'Edificio', etiqueta: 'Edificio', flag: 'acceso_edificios', color: 'bg-slate-100 text-slate-800 ring-slate-200', nombre_label: 'Nombre del edificio', direccion_label: 'Dirección del edificio' },
  { codigo: 'Obra',     etiqueta: 'Obra',     flag: 'acceso_obras',     color: 'bg-amber-100 text-amber-800 ring-amber-200', nombre_label: 'Nombre de la obra',   direccion_label: 'Dirección de la obra' }
];

const TIPOS_EDIFICIO_CODIGOS = TIPOS_EDIFICIO.map(t => t.codigo);

// Default al registrar un edificio o ante un valor inválido. Coincide con el
// DEFAULT de la columna `tipo` en la tabla tbl_edificios.
const TIPO_EDIFICIO_DEFAULT = TIPOS_EDIFICIO[0].codigo;

function normalizarTipoEdificio(tipo) {
  return TIPOS_EDIFICIO_CODIGOS.includes(tipo) ? tipo : TIPO_EDIFICIO_DEFAULT;
}

module.exports = {
  TIPOS_EDIFICIO,
  TIPOS_EDIFICIO_CODIGOS,
  TIPO_EDIFICIO_DEFAULT,
  normalizarTipoEdificio
};

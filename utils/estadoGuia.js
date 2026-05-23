// Catálogo único de estados que puede tomar `tbl_servicios_guias.estado_guia`.
// Espejo de frontend/src/utils/estadoGuia.js — mantener ambos en sincronía.

const ESTADO_GUIA_PENDIENTE = 'Pendiente';
const ESTADO_GUIA_ADJUNTA = 'Adjunta';
const ESTADO_GUIA_OBSERVADA = 'Observada';

const ESTADOS_GUIA = [
  ESTADO_GUIA_PENDIENTE,
  ESTADO_GUIA_ADJUNTA,
  ESTADO_GUIA_OBSERVADA
];

// Estado por defecto cuando hay archivo adjunto vs cuando no.
function estadoGuiaSegunArchivo(idArchivo) {
  return idArchivo ? ESTADO_GUIA_ADJUNTA : ESTADO_GUIA_OBSERVADA;
}

function esEstadoGuiaValido(estado) {
  return ESTADOS_GUIA.includes(estado);
}

module.exports = {
  ESTADOS_GUIA,
  ESTADO_GUIA_PENDIENTE,
  ESTADO_GUIA_ADJUNTA,
  ESTADO_GUIA_OBSERVADA,
  estadoGuiaSegunArchivo,
  esEstadoGuiaValido
};

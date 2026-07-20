// Catálogo único de estados que puede tomar `tbl_calendario_eventos.estado_evento`.
//
// Antes estos textos estaban repetidos como literales en cada controlador y
// utilidad que cancelaba o cerraba eventos; cualquier flujo que los cambie debe
// pasar por aquí para que el calendario no se desincronice.

const ESTADO_EVENTO_PROGRAMADO = 'programado';
const ESTADO_EVENTO_FINALIZADO = 'finalizado';
const ESTADO_EVENTO_CANCELADO = 'cancelado';

const ESTADOS_EVENTO = [
  ESTADO_EVENTO_PROGRAMADO,
  ESTADO_EVENTO_FINALIZADO,
  ESTADO_EVENTO_CANCELADO
];

function esEstadoEventoValido(estado) {
  return ESTADOS_EVENTO.includes(estado);
}

module.exports = {
  ESTADOS_EVENTO,
  ESTADO_EVENTO_PROGRAMADO,
  ESTADO_EVENTO_FINALIZADO,
  ESTADO_EVENTO_CANCELADO,
  esEstadoEventoValido
};

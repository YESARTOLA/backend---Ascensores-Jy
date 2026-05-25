// Catálogo único de estados del lead. Espejo de frontend/src/utils/estadoLead.js.
//
// Flujo:
//   Consulta  → estado inicial al registrar el lead.
//   Pendiente → estado intermedio asignado manualmente.
//   Cotizado  → automático cuando se crea una cotización para el lead.
//   Ingresado → automático cuando el lead se convierte/aprueba en un servicio.

const ESTADO_LEAD_CONSULTA = 'Consulta';
const ESTADO_LEAD_PENDIENTE = 'Pendiente';
const ESTADO_LEAD_COTIZADO = 'Cotizado';
const ESTADO_LEAD_INGRESADO = 'Ingresado';

const ESTADOS_LEAD = [
  ESTADO_LEAD_CONSULTA,
  ESTADO_LEAD_PENDIENTE,
  ESTADO_LEAD_COTIZADO,
  ESTADO_LEAD_INGRESADO
];

function esEstadoLeadValido(estado) {
  return ESTADOS_LEAD.includes(estado);
}

module.exports = {
  ESTADO_LEAD_CONSULTA,
  ESTADO_LEAD_PENDIENTE,
  ESTADO_LEAD_COTIZADO,
  ESTADO_LEAD_INGRESADO,
  ESTADOS_LEAD,
  esEstadoLeadValido
};

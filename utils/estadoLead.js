// Catálogo único de estados del lead. Espejo de frontend/src/utils/estadoLead.js.
//
// Flujo:
//   Consulta   → estado inicial al registrar el lead.
//   Pendiente  → estado intermedio asignado manualmente.
//   Cotizado   → automático cuando se crea una cotización para el lead.
//   Ingresado  → automático cuando el lead se convierte/aprueba en un servicio.
//   Descartado → manual, requiere motivo_descarte; reactivable (al salir de
//                Descartado el motivo se limpia). Bloquea cotizar/convertir.

const ESTADO_LEAD_CONSULTA = 'Consulta';
const ESTADO_LEAD_PENDIENTE = 'Pendiente';
const ESTADO_LEAD_COTIZADO = 'Cotizado';
const ESTADO_LEAD_INGRESADO = 'Ingresado';
const ESTADO_LEAD_DESCARTADO = 'Descartado';

const ESTADOS_LEAD = [
  ESTADO_LEAD_CONSULTA,
  ESTADO_LEAD_PENDIENTE,
  ESTADO_LEAD_COTIZADO,
  ESTADO_LEAD_INGRESADO,
  ESTADO_LEAD_DESCARTADO
];

function esEstadoLeadValido(estado) {
  return ESTADOS_LEAD.includes(estado);
}

module.exports = {
  ESTADO_LEAD_CONSULTA,
  ESTADO_LEAD_PENDIENTE,
  ESTADO_LEAD_COTIZADO,
  ESTADO_LEAD_INGRESADO,
  ESTADO_LEAD_DESCARTADO,
  ESTADOS_LEAD,
  esEstadoLeadValido
};

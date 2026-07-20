// Catálogo único de estados que puede tomar `tbl_mantenimientos_planes.estado_plan`.
//
// Antes estos textos vivían como literales repartidos por controladores y
// utilidades (creación, listados, materialización, cascadas de baja, dashboard,
// recordatorios). Cualquier flujo que cambie estos valores debe pasar por aquí.
//
//  activo    : plan vigente; genera eventos y servicios.
//  inactivo  : plan pausado; no genera nuevas instancias.
//  cancelado : plan dado de baja (estado = 0); terminal.

const ESTADO_PLAN_ACTIVO = 'activo';
const ESTADO_PLAN_INACTIVO = 'inactivo';
const ESTADO_PLAN_CANCELADO = 'cancelado';

const ESTADOS_PLAN = [
  ESTADO_PLAN_ACTIVO,
  ESTADO_PLAN_INACTIVO,
  ESTADO_PLAN_CANCELADO
];

// Estados terminales: el plan ya no debe generar recordatorios ni instancias.
const ESTADOS_PLAN_TERMINALES = [ESTADO_PLAN_INACTIVO, ESTADO_PLAN_CANCELADO];

function esEstadoPlanValido(estado) {
  return ESTADOS_PLAN.includes(estado);
}

function esPlanTerminal(estado) {
  return ESTADOS_PLAN_TERMINALES.includes(estado);
}

module.exports = {
  ESTADOS_PLAN,
  ESTADOS_PLAN_TERMINALES,
  ESTADO_PLAN_ACTIVO,
  ESTADO_PLAN_INACTIVO,
  ESTADO_PLAN_CANCELADO,
  esEstadoPlanValido,
  esPlanTerminal
};

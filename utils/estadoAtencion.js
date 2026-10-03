/**
 * Estados de ATENCIÓN de emergencias y correctivos. Solo tres:
 *
 *   En atención — el caso está abierto (antes se distinguía "Reportada" sin
 *                 técnico de "En atención" con técnico: ahora es uno solo).
 *   Atendida    — el técnico terminó el trabajo (antes también "Cerrada",
 *                 "Resuelto" o "Cerrado"); lo que siga es revisión y cobro.
 *   Cancelada   — el servicio se canceló.
 *
 * El correctivo usa las mismas tres etapas en masculino (Atendido, Cancelado).
 *
 * El estado NO se teclea: se DERIVA del servicio que atiende el caso (ver
 * `etapaAtencion`), y utils/estadoServicio.js lo resincroniza en cada cambio de
 * estado del servicio. Así nunca queda congelado aunque el técnico ya terminó.
 *
 * Sin dependencias de otros módulos con estado (solo ejecucionFechas), para que
 * lo puedan requerir tanto estadoServicio.js como recordatoriosAuto.js sin ciclos.
 */
const { ESTADOS_FIN, ESTADO_CANCELADO } = require('./ejecucionFechas');

const ETAPA = { EN_ATENCION: 'en_atencion', ATENDIDA: 'atendida', CANCELADA: 'cancelada' };

const ETIQUETAS_EMERGENCIA = {
  [ETAPA.EN_ATENCION]: 'En atención',
  [ETAPA.ATENDIDA]: 'Atendida',
  [ETAPA.CANCELADA]: 'Cancelada'
};
const ETIQUETAS_CORRECTIVO = {
  [ETAPA.EN_ATENCION]: 'En atención',
  [ETAPA.ATENDIDA]: 'Atendido',
  [ETAPA.CANCELADA]: 'Cancelado'
};

const ESTADOS_EMERGENCIA = Object.values(ETIQUETAS_EMERGENCIA);
const ESTADOS_CORRECTIVO = Object.values(ETIQUETAS_CORRECTIVO);
const ESTADO_EMERGENCIA_INICIAL = ETIQUETAS_EMERGENCIA[ETAPA.EN_ATENCION];
const ESTADO_CORRECTIVO_INICIAL = ETIQUETAS_CORRECTIVO[ETAPA.EN_ATENCION];

/** Etapa de atención según el estado del servicio (sin servicio: en atención). */
function etapaAtencion(estadoServicio) {
  if (estadoServicio === ESTADO_CANCELADO) return ETAPA.CANCELADA;
  // Todo lo que va de "finalizado por el técnico" en adelante (revisión, cobro,
  // facturación, cerrado) es trabajo ya atendido en campo.
  if (ESTADOS_FIN.includes(estadoServicio)) return ETAPA.ATENDIDA;
  return ETAPA.EN_ATENCION;
}

function estadoEmergenciaDesdeServicio(servicio) {
  return ETIQUETAS_EMERGENCIA[etapaAtencion(servicio?.estado_servicio)];
}

function estadoCorrectivoDesdeServicio(servicio) {
  return ETIQUETAS_CORRECTIVO[etapaAtencion(servicio?.estado_servicio)];
}

// Cerrado = ya no está en atención (atendido o cancelado): no se edita.
function esEmergenciaCerrada(estado) {
  return !!estado && estado !== ESTADO_EMERGENCIA_INICIAL;
}

function esCorrectivoCerrado(estado) {
  return !!estado && estado !== ESTADO_CORRECTIVO_INICIAL;
}

module.exports = {
  ESTADOS_EMERGENCIA,
  ESTADOS_CORRECTIVO,
  ESTADO_EMERGENCIA_INICIAL,
  ESTADO_CORRECTIVO_INICIAL,
  etapaAtencion,
  estadoEmergenciaDesdeServicio,
  estadoCorrectivoDesdeServicio,
  esEmergenciaCerrada,
  esCorrectivoCerrado
};

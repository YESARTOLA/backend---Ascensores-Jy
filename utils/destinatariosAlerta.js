/**
 * Destinatarios de la ALERTA de una observación técnica.
 * Espejo de frontend/src/utils/destinatariosAlerta.js — mantener en sincronía.
 *
 * El técnico elige a quién avisar cuando el hallazgo requiere atención. Antes
 * la alerta salía siempre a los cuatro destinos; ahora se dirige.
 *
 * `detalle` decide QUÉ recibe cada uno:
 *   · true  → alerta con el texto de la observación (tipo 'observacion_alerta').
 *   · false → solo el aviso de que el servicio tiene una observación, sin el
 *             comentario ni la imagen (tipo 'observacion_facturar'). Es el caso
 *             de contabilidad: la regla de que no ve el detalle técnico ya
 *             existía (observacionesServicioController.listar le responde 403) y
 *             se mantiene — seleccionarla como destinataria no la levanta.
 *
 * `roles` son los códigos de rol que reciben ese aviso. Se genera UN
 * recordatorio por rol, cada uno con su `rol_destinatario`, para que la alerta
 * llegue exactamente a quien se eligió y no a todo el que comparta el tipo.
 */
const DESTINATARIOS_ALERTA = [
  { codigo: 'administracion', etiqueta: 'Administración',   roles: ['super_admin', 'admin'], detalle: true },
  { codigo: 'coordinacion',   etiqueta: 'Oficina técnica',  roles: ['coordinador'],          detalle: true },
  { codigo: 'cotizacion',     etiqueta: 'Cotización',       roles: ['vendedora'],            detalle: true },
  { codigo: 'contabilidad',   etiqueta: 'Contabilidad',     roles: ['contabilidad'],         detalle: false }
];

const DESTINATARIOS_CODIGOS = DESTINATARIOS_ALERTA.map(d => d.codigo);

// Reparto histórico: hasta que el técnico pudo elegir, la alerta salía a todos.
// Se usa como respaldo si llega `genera_alerta` sin lista de destinatarios (un
// cliente viejo), para no degradar en silencio a "no avisar a nadie".
const DESTINATARIOS_POR_DEFECTO = [...DESTINATARIOS_CODIGOS];

/**
 * Depura la lista recibida del cliente: deja solo códigos del catálogo, sin
 * duplicados y en el orden del catálogo (para que el CSV guardado sea estable).
 */
function normalizarDestinatarios(lista) {
  if (!Array.isArray(lista)) return [];
  const pedidos = new Set(lista.map(String));
  return DESTINATARIOS_CODIGOS.filter(c => pedidos.has(c));
}

/** Definición de un destinatario por su código. */
function destinatario(codigo) {
  return DESTINATARIOS_ALERTA.find(d => d.codigo === codigo) || null;
}

/** Etiquetas legibles de una lista de códigos, para mensajes y auditoría. */
function etiquetasDestinatarios(codigos) {
  return (codigos || []).map(c => destinatario(c)?.etiqueta).filter(Boolean);
}

module.exports = {
  DESTINATARIOS_ALERTA,
  DESTINATARIOS_CODIGOS,
  DESTINATARIOS_POR_DEFECTO,
  normalizarDestinatarios,
  destinatario,
  etiquetasDestinatarios
};

/**
 * Fuente única de verdad para identificar la categoría de un tipo de servicio
 * que corresponde a "mantenimiento preventivo".
 *
 * Solo los planes cuyo tipo de servicio cae en esta categoría pueden ofrecer
 * mantenimientos gratuitos (cupo de cortesía a los primeros N servicios).
 */

const CATEGORIA_PREVENTIVO = 'Mantenimiento preventivo';

function esCategoriaPreventiva(categoria) {
  if (!categoria) return false;
  return String(categoria).trim().toLowerCase() === CATEGORIA_PREVENTIVO.toLowerCase();
}

module.exports = { CATEGORIA_PREVENTIVO, esCategoriaPreventiva };

/**
 * Adjuntos de contexto de una emergencia: fotos y videos de la falla que carga
 * quien la reporta para que el TÉCNICO asignado los revise antes de salir a
 * campo. La lógica es común a los registros operativos y vive en
 * utils/adjuntosRegistro.js; aquí solo se fija la tabla puente y su FK.
 */
const { crearAdjuntosRegistro } = require('./adjuntosRegistro');

module.exports = crearAdjuntosRegistro({
  modelo: 'tbl_emergencias_archivos',
  fk: 'id_emergencia',
  tipoArchivo: 'emergencias',
  max: Number(process.env.EMERGENCIA_MAX_ADJUNTOS) || 20,
  porRegistro: 'por emergencia',
  noEncontrado: 'Emergencia no encontrada',
  log: 'emergencias'
});

/**
 * Adjuntos de contexto de un correctivo: fotos, videos y PDFs de la falla para
 * que el TÉCNICO asignado los revise antes de salir a campo. Misma lógica que
 * los de la emergencia (utils/adjuntosRegistro.js) sobre su propia tabla puente.
 */
const { crearAdjuntosRegistro } = require('./adjuntosRegistro');

module.exports = crearAdjuntosRegistro({
  modelo: 'tbl_correctivos_archivos',
  fk: 'id_correctivo',
  tipoArchivo: 'correctivos',
  max: Number(process.env.CORRECTIVO_MAX_ADJUNTOS) || 20,
  porRegistro: 'por correctivo',
  noEncontrado: 'Correctivo no encontrado',
  log: 'correctivos'
});

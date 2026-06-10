/**
 * SSoT de clasificación de tipos de servicio (jerarquía padre → subtipo).
 *
 * Única fuente de verdad para determinar, a partir de un subtipo:
 *   - si un registro es Proyecto o Servicio (`tipo_registro`)
 *   - a qué módulo operativo pertenece (`modulo_asociado`)
 *
 * Reglas:
 *   - PADRE  : define `categoria_funcional` ('SERVICIOS' | 'PROYECTOS').
 *   - SUBTIPO: hereda la categoría funcional del padre.
 *       · padre 'SERVICIOS'  → `modulo_asociado` obligatorio (uno de MODULOS_VALIDOS),
 *                              `tipo_registro` = 'servicio'.
 *       · padre 'PROYECTOS'  → `modulo_asociado` = null, `tipo_registro` = 'proyecto'.
 *
 * Toda la app deriva la clasificación de aquí; no debe haber lógica por
 * `categoria` (texto libre, eliminado) ni por `origen` para decidir el módulo.
 */

const CATEGORIAS_FUNCIONALES = ['SERVICIOS', 'PROYECTOS'];
const MODULOS_VALIDOS = ['emergencia', 'correctivo', 'mantenimiento', 'atencion_rapida'];

const TIPO_REGISTRO = { SERVICIO: 'servicio', PROYECTO: 'proyecto' };

// Catálogos para alimentar dinámicamente al frontend (única definición de labels).
const CATEGORIAS_FUNCIONALES_META = [
  { value: 'SERVICIOS', label: 'Servicios' },
  { value: 'PROYECTOS', label: 'Proyectos' },
];
const MODULOS_META = [
  { value: 'emergencia', label: 'Emergencias' },
  { value: 'correctivo', label: 'Correctivos' },
  { value: 'mantenimiento', label: 'Mantenimientos' },
  { value: 'atencion_rapida', label: 'Atención rápida' },
];

function normalizarCategoriaFuncional(valor) {
  if (valor == null || valor === '') return null;
  const v = String(valor).trim().toUpperCase();
  if (!CATEGORIAS_FUNCIONALES.includes(v)) {
    throw new Error(`Categoría funcional inválida. Permitidos: ${CATEGORIAS_FUNCIONALES.join(', ')}`);
  }
  return v;
}

function normalizarModulo(valor) {
  if (valor == null || valor === '') return null;
  const v = String(valor).trim().toLowerCase();
  if (!MODULOS_VALIDOS.includes(v)) {
    throw new Error(`Módulo asociado inválido. Permitidos: ${MODULOS_VALIDOS.join(', ')} o vacío`);
  }
  return v;
}

/**
 * Valida y normaliza el módulo de un subtipo según la categoría funcional de su padre.
 * @returns {string|null} módulo normalizado (null si el padre es PROYECTOS).
 */
function validarModuloParaCategoria(categoriaFuncional, modulo) {
  const cf = normalizarCategoriaFuncional(categoriaFuncional);
  if (cf === 'PROYECTOS') {
    if (modulo) throw new Error('Un subtipo de Proyectos no debe tener módulo operativo.');
    return null;
  }
  if (cf === 'SERVICIOS') {
    const m = normalizarModulo(modulo);
    if (!m) throw new Error('Un subtipo de Servicios requiere un módulo operativo.');
    return m;
  }
  throw new Error('La categoría funcional del padre es inválida.');
}

/**
 * Clasifica un subtipo. Requiere que la fila incluya su relación `padre`
 * (o, si se le pasa un padre directamente, usa su propia categoria_funcional).
 * @param {object} subtipo fila tbl_tipos_servicio con { modulo_asociado, padre, categoria_funcional }
 */
function clasificarTipoServicio(subtipo) {
  if (!subtipo) throw new Error('clasificarTipoServicio: subtipo requerido');
  const padre = subtipo.padre || null;
  // Si la propia fila tiene categoria_funcional es un PADRE; si no, la toma del padre.
  const categoria_funcional = subtipo.categoria_funcional || (padre ? padre.categoria_funcional : null) || null;
  if (!categoria_funcional) {
    throw new Error('clasificarTipoServicio: no se pudo determinar la categoría funcional (¿se incluyó el padre?).');
  }
  const es_proyecto = categoria_funcional === 'PROYECTOS';
  const modulo_asociado = es_proyecto ? null : (subtipo.modulo_asociado || null);
  return {
    categoria_funcional,
    tipo_registro: es_proyecto ? TIPO_REGISTRO.PROYECTO : TIPO_REGISTRO.SERVICIO,
    modulo_asociado,
    es_proyecto,
    es_mantenimiento: modulo_asociado === 'mantenimiento',
  };
}

/**
 * Carga un subtipo con su padre y lo clasifica.
 * @returns {Promise<{subtipo, categoria_funcional, tipo_registro, modulo_asociado, es_proyecto, es_mantenimiento}|null>}
 */
async function cargarClasificacionSubtipo(db, idSubtipo) {
  const subtipo = await db.tbl_tipos_servicio.findUnique({
    where: { id: Number(idSubtipo) },
    include: { padre: true },
  });
  if (!subtipo) return null;
  return { subtipo, ...clasificarTipoServicio(subtipo) };
}

/**
 * Subtipo por defecto (más antiguo activo) vinculado a un módulo operativo.
 * Lo usan los flujos de creación directa de módulos (emergencias, correctivos,
 * atención rápida) que no piden subtipo explícito. Incluye el padre.
 */
async function subtipoPorDefectoDeModulo(db, modulo) {
  const m = normalizarModulo(modulo);
  if (!m) return null;
  return db.tbl_tipos_servicio.findFirst({
    where: { modulo_asociado: m, estado: 1, id_padre: { not: null } },
    orderBy: { id: 'asc' },
    include: { padre: true },
  });
}

module.exports = {
  CATEGORIAS_FUNCIONALES,
  MODULOS_VALIDOS,
  TIPO_REGISTRO,
  CATEGORIAS_FUNCIONALES_META,
  MODULOS_META,
  normalizarCategoriaFuncional,
  normalizarModulo,
  validarModuloParaCategoria,
  clasificarTipoServicio,
  cargarClasificacionSubtipo,
  subtipoPorDefectoDeModulo,
};

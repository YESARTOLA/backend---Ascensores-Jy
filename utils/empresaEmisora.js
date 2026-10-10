/**
 * Empresas emisoras: razones sociales (RUC, dirección, contacto) con las que se
 * puede emitir una cotización. Se gestionan en Configuración › Empresas emisoras
 * (controllers/empresasEmisorasController.js).
 *
 * Punto único para resolver "con qué datos de empresa se imprime":
 *   - el PDF de cotización usa la empresa elegida en la versión
 *     (tbl_cotizaciones_versiones.id_empresa_emisora);
 *   - el resto de documentos (informe de servicio, exportaciones) y las
 *     versiones sin empresa usan la PREDETERMINADA.
 * Las claves EMPRESA_* de tbl_configuracion quedan solo como respaldo si la
 * tabla no existiera o estuviera vacía (la migración siembra la primera
 * empresa con ellas).
 */

const prisma = require('../config/prisma');
const configuracion = require('./configuracion');

const CLAVES_CONFIG = [
  'EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC', 'EMPRESA_DIRECCION',
  'EMPRESA_TELEFONO', 'EMPRESA_CORREO'
];

/** Empresa predeterminada activa (o la primera activa si ninguna está marcada). */
async function obtenerPredeterminada(tx = prisma) {
  return tx.tbl_empresas_emisoras.findFirst({
    where: { estado: 1 },
    orderBy: [{ es_predeterminada: 'desc' }, { id: 'asc' }]
  });
}

/**
 * Datos de empresa para imprimir, con la forma de las claves EMPRESA_* que ya
 * consumen los generadores de PDF / Excel.
 *
 * @param {number|null} idEmpresa  Empresa elegida (p. ej. la de la versión). Se
 *   respeta aunque después se haya eliminado: el documento se emitió con ella.
 *   Sin id → la predeterminada.
 */
async function obtenerDatosEmpresa(idEmpresa = null) {
  let empresa = null;
  try {
    if (idEmpresa) {
      empresa = await prisma.tbl_empresas_emisoras.findUnique({ where: { id: Number(idEmpresa) } });
    }
    if (!empresa) empresa = await obtenerPredeterminada();
  } catch (_err) {
    // Tabla aún inexistente (antes de migrar): se sigue con la configuración.
  }
  if (!empresa) return configuracion.obtenerVarios(CLAVES_CONFIG);
  return {
    EMPRESA_RAZON_SOCIAL: empresa.razon_social,
    EMPRESA_RUC: empresa.ruc,
    EMPRESA_DIRECCION: empresa.direccion || '',
    EMPRESA_TELEFONO: empresa.telefono || '',
    EMPRESA_CORREO: empresa.correo || ''
  };
}

/**
 * Valida la empresa emisora que llega al crear / editar una versión de
 * cotización. Sin valor → la predeterminada, guardada EXPLÍCITA para que
 * cambiar la predeterminada después no altere cotizaciones ya emitidas.
 *
 * @returns {Promise<{ id: number|null } | { error: string }>}
 */
async function resolverIdEmpresaEmisora(valor) {
  if (valor === undefined || valor === null || valor === '') {
    const pred = await obtenerPredeterminada();
    return { id: pred ? pred.id : null };
  }
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) return { error: 'Empresa emisora inválida' };
  const empresa = await prisma.tbl_empresas_emisoras.findFirst({
    where: { id, estado: 1 }, select: { id: true }
  });
  if (!empresa) return { error: 'La empresa emisora no existe o fue eliminada' };
  return { id };
}

module.exports = { obtenerPredeterminada, obtenerDatosEmpresa, resolverIdEmpresaEmisora };

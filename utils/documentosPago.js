/**
 * Documentos de soporte de un abono (tbl_pagos_archivos).
 *
 * El abono tiene su COMPROBANTE en tbl_pagos.id_archivo_comprobante (voucher,
 * captura de la transferencia). Aparte, contabilidad guarda junto al cobro los
 * mismos documentos que acompañan a una factura: constancia de detracción, de
 * retención, de pago… Comparten el catálogo de tipos y la normalización con
 * los de factura (utils/documentosFactura.js), para clasificarse igual en los
 * dos lugares.
 *
 * Este módulo concentra su comportamiento: vincular al registrar el abono,
 * sincronizar al corregirlo y dar de baja en cascada.
 */

const { vincularDocumentosDeEnTx } = require('./documentosFactura');

/** Tope de documentos adicionales por abono. Configurable por entorno. */
const MAX_DOCUMENTOS_PAGO = Number(process.env.PAGO_MAX_DOCUMENTOS) || 20;

/**
 * Vincula archivos ya subidos (POST /archivos) a un abono como documentos
 * adicionales: `crudo` = [{ id_archivo, tipo_documento, descripcion }].
 *
 * @returns {Promise<Array>} filas de tbl_pagos_archivos creadas
 */
async function vincularDocumentosPagoEnTx(tx, idPago, crudo, idUsuario) {
  return vincularDocumentosDeEnTx(tx, {
    modelo: 'tbl_pagos_archivos',
    campo: 'id_pago',
    id: idPago,
    max: MAX_DOCUMENTOS_PAGO,
    nombre: 'abono'
  }, crudo, idUsuario);
}

/**
 * Deja al abono con exactamente los documentos de `crudo` (corrección completa
 * del abono): los que traen `id` se conservan tal cual, los que traen solo
 * `id_archivo` se vinculan y los activos que no vienen se dan de baja.
 *
 * Solo marca los vínculos: el llamador da de baja los archivos de `quitados`
 * (`bajaArchivoEnTx`) y los purga del bucket tras el commit.
 *
 * @returns {Promise<{ creados: Array, quitados: Array }>}
 */
async function sincronizarDocumentosPagoEnTx(tx, idPago, crudo, idUsuario) {
  const lista = Array.isArray(crudo) ? crudo.filter(Boolean) : [];
  const conservar = new Set(lista.filter(d => d.id).map(d => Number(d.id)));

  const actuales = await tx.tbl_pagos_archivos.findMany({ where: { id_pago: idPago, estado: 1 } });
  const quitados = actuales.filter(d => !conservar.has(d.id));
  if (quitados.length > 0) {
    await tx.tbl_pagos_archivos.updateMany({
      where: { id: { in: quitados.map(d => d.id) } },
      data: { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() }
    });
  }
  // Después de las bajas, para que el tope cuente solo los que quedan.
  const creados = await vincularDocumentosPagoEnTx(tx, idPago, lista.filter(d => !d.id), idUsuario);
  return { creados, quitados };
}

/**
 * Da de baja los documentos adicionales de los abonos de un conjunto de cobros
 * (cascada de eliminar cobro / servicio / plan / edificio).
 *
 * Solo marca los vínculos: devuelve los ids de tbl_archivos para que el
 * llamador los sume a los que ya da de baja con `bajaArchivoEnTx` (y purgue del
 * bucket tras el commit, si su flujo purga).
 *
 * @returns {Promise<number[]>} ids de tbl_archivos a dar de baja
 */
async function bajaDocumentosDeAbonosEnTx(tx, idsCobro, idUsuario) {
  const ids = (idsCobro || []).filter(Boolean);
  if (ids.length === 0) return [];
  const vinculos = await tx.tbl_pagos_archivos.findMany({
    where: { estado: 1, pago: { id_cobro: { in: ids } } },
    select: { id: true, id_archivo: true }
  });
  if (vinculos.length === 0) return [];
  await tx.tbl_pagos_archivos.updateMany({
    where: { id: { in: vinculos.map(v => v.id) } },
    data: { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() }
  });
  return vinculos.map(v => v.id_archivo);
}

module.exports = {
  MAX_DOCUMENTOS_PAGO,
  vincularDocumentosPagoEnTx,
  sincronizarDocumentosPagoEnTx,
  bajaDocumentosDeAbonosEnTx
};

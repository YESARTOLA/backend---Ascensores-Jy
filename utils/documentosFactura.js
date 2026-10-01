/**
 * Documentos de soporte de una factura (tbl_facturas_archivos).
 *
 * La factura tiene su COMPROBANTE en tbl_facturas.id_archivo (el PDF de la
 * factura o boleta). Aparte, contabilidad guarda los documentos que la
 * acompañan y que suelen llegar después o por separado: constancia de
 * detracción, de retención, de pago, el XML/CDR de SUNAT, etc. Cada uno lleva su
 * tipo, para encontrarlo sin abrir archivo por archivo.
 *
 * Este módulo concentra el catálogo de tipos y el comportamiento de los
 * documentos (vincular, dar de baja en cascada). Catálogo espejo en
 * frontend/src/utils/catalogosDocumentoFactura.js — mantener en sincronía.
 */

const TIPO_DOCUMENTO_FACTURA_OTRO = 'Otro';

const TIPOS_DOCUMENTO_FACTURA = [
  { codigo: 'Constancia de detracción', etiqueta: 'Constancia de detracción' },
  { codigo: 'Constancia de retención',  etiqueta: 'Constancia de retención' },
  { codigo: 'Constancia de pago',       etiqueta: 'Constancia de pago' },
  { codigo: 'XML / CDR',                etiqueta: 'XML / CDR (SUNAT)' },
  { codigo: 'Guía de remisión',         etiqueta: 'Guía de remisión' },
  { codigo: 'Orden de compra',          etiqueta: 'Orden de compra' },
  { codigo: TIPO_DOCUMENTO_FACTURA_OTRO, etiqueta: 'Otro' }
];

const TIPOS_DOCUMENTO_FACTURA_CODIGOS = TIPOS_DOCUMENTO_FACTURA.map(t => t.codigo);

/** Tope de documentos adicionales por factura. Configurable por entorno. */
const MAX_DOCUMENTOS_FACTURA = Number(process.env.FACTURA_MAX_DOCUMENTOS) || 20;

/** Campos del archivo que se exponen al frontend (nunca la fila completa). */
const SELECT_ARCHIVO = {
  id: true,
  nombre_original: true,
  ruta_almacenamiento: true,
  mime_type: true,
  tamano_bytes: true,
  fecha_subida: true
};

/** Include para traer los documentos activos de una factura, ordenados. */
const INCLUDE_DOCUMENTOS = {
  where: { estado: 1 },
  orderBy: [{ orden: 'asc' }, { id: 'asc' }],
  include: { archivo: { select: SELECT_ARCHIVO } }
};

function esTipoDocumentoFacturaValido(tipo) {
  return TIPOS_DOCUMENTO_FACTURA_CODIGOS.includes(tipo);
}

function errorHttp(mensaje, codigoHttp = 400) {
  const err = new Error(mensaje);
  err.codigoHttp = codigoHttp;
  return err;
}

/**
 * Normaliza el payload de documentos que llega del cliente. Un tipo fuera del
 * catálogo se rechaza en vez de guardarse como "Otro" en silencio: el tipo es
 * justamente lo que permite encontrar la constancia después.
 */
function normalizarDocumentos(crudo) {
  if (!Array.isArray(crudo)) return [];
  return crudo
    .filter(d => d && d.id_archivo)
    .map(d => {
      const tipo = d.tipo_documento || TIPO_DOCUMENTO_FACTURA_OTRO;
      if (!esTipoDocumentoFacturaValido(tipo)) {
        throw errorHttp(`Tipo de documento inválido: "${tipo}". Valores permitidos: ${TIPOS_DOCUMENTO_FACTURA_CODIGOS.join(', ')}`);
      }
      return {
        id_archivo: Number(d.id_archivo),
        tipo_documento: tipo,
        descripcion: typeof d.descripcion === 'string' && d.descripcion.trim()
          ? d.descripcion.trim().slice(0, 200)
          : null
      };
    })
    .filter(d => Number.isInteger(d.id_archivo) && d.id_archivo > 0);
}

/**
 * Vincula archivos ya subidos (POST /archivos) a una factura como documentos
 * adicionales. Se usa al emitir la factura —donde todavía no existía al subir—
 * y desde el endpoint de agregar documentos.
 *
 * @returns {Promise<Array>} filas de tbl_facturas_archivos creadas
 */
async function vincularDocumentosEnTx(tx, idFactura, crudo, idUsuario) {
  const documentos = normalizarDocumentos(crudo);
  if (documentos.length === 0) return [];

  const yaVinculados = await tx.tbl_facturas_archivos.count({
    where: { id_factura: idFactura, estado: 1 }
  });
  if (yaVinculados + documentos.length > MAX_DOCUMENTOS_FACTURA) {
    throw errorHttp(`Máximo ${MAX_DOCUMENTOS_FACTURA} documentos por factura (hay ${yaVinculados}).`);
  }

  // Solo archivos que existan y estén activos: evita FK colgadas si el cliente
  // manda ids inventados o de archivos ya dados de baja.
  const ids = [...new Set(documentos.map(d => d.id_archivo))];
  const existentes = await tx.tbl_archivos.findMany({
    where: { id: { in: ids }, estado: 1 },
    select: { id: true }
  });
  const validos = new Set(existentes.map(a => a.id));

  const creados = [];
  for (const d of documentos) {
    if (!validos.has(d.id_archivo)) continue;
    creados.push(await tx.tbl_facturas_archivos.create({
      data: {
        id_factura: idFactura,
        id_archivo: d.id_archivo,
        tipo_documento: d.tipo_documento,
        descripcion: d.descripcion,
        orden: yaVinculados + creados.length + 1,
        user_id_registration: idUsuario
      }
    }));
  }
  return creados;
}

/**
 * Da de baja los documentos adicionales de un conjunto de facturas (cascada de
 * eliminar factura / cobro / servicio / plan / edificio).
 *
 * Solo marca los vínculos: devuelve los ids de tbl_archivos para que el
 * llamador los sume a los que ya da de baja con `bajaArchivoEnTx` (y purgue del
 * bucket tras el commit, si su flujo purga).
 *
 * @returns {Promise<number[]>} ids de tbl_archivos a dar de baja
 */
async function bajaDocumentosDeFacturasEnTx(tx, idsFactura, idUsuario) {
  const ids = (idsFactura || []).filter(Boolean);
  if (ids.length === 0) return [];
  const vinculos = await tx.tbl_facturas_archivos.findMany({
    where: { id_factura: { in: ids }, estado: 1 },
    select: { id_archivo: true }
  });
  if (vinculos.length === 0) return [];
  await tx.tbl_facturas_archivos.updateMany({
    where: { id_factura: { in: ids }, estado: 1 },
    data: { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() }
  });
  return vinculos.map(v => v.id_archivo);
}

module.exports = {
  TIPO_DOCUMENTO_FACTURA_OTRO,
  TIPOS_DOCUMENTO_FACTURA,
  TIPOS_DOCUMENTO_FACTURA_CODIGOS,
  MAX_DOCUMENTOS_FACTURA,
  SELECT_ARCHIVO,
  INCLUDE_DOCUMENTOS,
  esTipoDocumentoFacturaValido,
  normalizarDocumentos,
  vincularDocumentosEnTx,
  bajaDocumentosDeFacturasEnTx
};

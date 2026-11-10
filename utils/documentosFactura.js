/**
 * Documentos de soporte de una factura (tbl_facturas_archivos).
 *
 * La factura tiene su COMPROBANTE en tbl_facturas.id_archivo (el PDF de la
 * factura o boleta). Aparte, contabilidad guarda los documentos que la
 * acompañan y que suelen llegar después o por separado: constancia de
 * detracción, de retención, de pago, el XML/CDR de SUNAT, etc. Cada uno lleva su
 * tipo, para encontrarlo sin abrir archivo por archivo.
 *
 * Si el comprobante mismo viene en más de un archivo (la factura en PDF más su
 * representación impresa, varias páginas escaneadas…), el primero queda en
 * tbl_facturas.id_archivo y los demás aquí con tipo 'Comprobante'
 * (`vincularComprobantesEnTx`). La UI los muestra juntos como «Archivos de la
 * factura» y deja ese tipo fuera del selector de documentos adicionales.
 *
 * Este módulo concentra el catálogo de tipos y el comportamiento de los
 * documentos (vincular, dar de baja en cascada). Catálogo espejo en
 * frontend/src/utils/catalogosDocumentoFactura.js — mantener en sincronía.
 * Los documentos adicionales de un abono usan el mismo catálogo
 * (utils/documentosPago.js).
 */

const TIPO_DOCUMENTO_FACTURA_OTRO = 'Otro';
/** Archivo adicional del propio comprobante (ver cabecera). */
const TIPO_DOCUMENTO_COMPROBANTE = 'Comprobante';

const TIPOS_DOCUMENTO_FACTURA = [
  { codigo: 'Constancia de detracción', etiqueta: 'Constancia de detracción' },
  { codigo: 'Constancia de retención',  etiqueta: 'Constancia de retención' },
  { codigo: 'Constancia de pago',       etiqueta: 'Constancia de pago' },
  { codigo: 'XML / CDR',                etiqueta: 'XML / CDR (SUNAT)' },
  { codigo: 'Guía de remisión',         etiqueta: 'Guía de remisión' },
  { codigo: 'Orden de compra',          etiqueta: 'Orden de compra' },
  { codigo: TIPO_DOCUMENTO_FACTURA_OTRO, etiqueta: 'Otro' },
  { codigo: TIPO_DOCUMENTO_COMPROBANTE, etiqueta: 'Comprobante (archivo de la factura)' }
];

const TIPOS_DOCUMENTO_FACTURA_CODIGOS = TIPOS_DOCUMENTO_FACTURA.map(t => t.codigo);

/**
 * Tope de documentos por factura (archivos del comprobante + adicionales). Es
 * solo una barrera contra cargas desbocadas: en la práctica, ilimitado.
 * Configurable por entorno.
 */
const MAX_DOCUMENTOS_FACTURA = Number(process.env.FACTURA_MAX_DOCUMENTOS) || 500;

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

/** Tipo de documento validado contra el catálogo (lanza 400 si no está). */
function tipoDocumentoValido(tipo) {
  if (!esTipoDocumentoFacturaValido(tipo)) {
    throw errorHttp(`Tipo de documento inválido: "${tipo}". Valores permitidos: ${TIPOS_DOCUMENTO_FACTURA_CODIGOS.join(', ')}`);
  }
  return tipo;
}

/** Descripción normalizada: recortada a 200 caracteres, o null si viene vacía. */
function descripcionDocumento(descripcion) {
  return typeof descripcion === 'string' && descripcion.trim()
    ? descripcion.trim().slice(0, 200)
    : null;
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
    .map(d => ({
      id_archivo: Number(d.id_archivo),
      tipo_documento: tipoDocumentoValido(d.tipo_documento || TIPO_DOCUMENTO_FACTURA_OTRO),
      descripcion: descripcionDocumento(d.descripcion)
    }))
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
  return vincularDocumentosDeEnTx(tx, {
    modelo: 'tbl_facturas_archivos',
    campo: 'id_factura',
    id: idFactura,
    max: MAX_DOCUMENTOS_FACTURA,
    nombre: 'factura'
  }, crudo, idUsuario);
}

/**
 * Vincula documentos adicionales a un registro dueño: la factura
 * (tbl_facturas_archivos) o el abono (tbl_pagos_archivos, utils/documentosPago.js).
 * Ambas tablas comparten forma y catálogo de tipos.
 *
 * @param destino { modelo, campo, id, max, nombre } — tabla de vínculos, columna
 *   del dueño, id del dueño, tope de documentos y nombre para el mensaje de error
 * @returns {Promise<Array>} filas creadas
 */
async function vincularDocumentosDeEnTx(tx, { modelo, campo, id, max, nombre }, crudo, idUsuario) {
  const documentos = normalizarDocumentos(crudo);
  if (documentos.length === 0) return [];

  const yaVinculados = await tx[modelo].count({
    where: { [campo]: id, estado: 1 }
  });
  if (yaVinculados + documentos.length > max) {
    throw errorHttp(`Máximo ${max} documentos por ${nombre} (hay ${yaVinculados}).`);
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
    creados.push(await tx[modelo].create({
      data: {
        [campo]: id,
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

/** Ids de archivo: enteros positivos, sin repetir, en el orden recibido. */
function idsArchivoUnicos(lista) {
  const vistos = new Set();
  const ids = [];
  for (const v of Array.isArray(lista) ? lista : []) {
    const id = Number(v && typeof v === 'object' ? v.id_archivo ?? v.id : v);
    if (!Number.isInteger(id) || id <= 0 || vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Agrega archivos al COMPROBANTE de una factura. Si la factura todavía no tiene
 * comprobante, el primero pasa a tbl_facturas.id_archivo; el resto se vincula
 * como documentos de tipo 'Comprobante'. Se ignoran los archivos inexistentes o
 * dados de baja y los que la factura ya tiene.
 *
 * @param factura  { id, id_archivo } — tal como está en la base dentro de `tx`
 * @param idsArchivo  ids de tbl_archivos ya subidos (POST /archivos)
 * @returns {Promise<{ principal: number|null, agregados: number[] }>}
 *          `principal` = id_archivo con que queda la factura;
 *          `agregados` = ids de archivo incorporados (principal incluido si cambió)
 */
async function vincularComprobantesEnTx(tx, factura, idsArchivo, idUsuario) {
  let ids = idsArchivoUnicos(idsArchivo);
  if (ids.length === 0) return { principal: factura.id_archivo || null, agregados: [] };

  const [existentes, yaVinculados] = await Promise.all([
    tx.tbl_archivos.findMany({ where: { id: { in: ids }, estado: 1 }, select: { id: true } }),
    tx.tbl_facturas_archivos.findMany({
      where: { id_factura: factura.id, estado: 1, id_archivo: { in: ids } },
      select: { id_archivo: true }
    })
  ]);
  const validos = new Set(existentes.map(a => a.id));
  const repetidos = new Set(yaVinculados.map(v => v.id_archivo));
  ids = ids.filter(id => validos.has(id) && !repetidos.has(id) && id !== factura.id_archivo);
  if (ids.length === 0) return { principal: factura.id_archivo || null, agregados: [] };

  let principal = factura.id_archivo || null;
  let resto = ids;
  if (!principal) {
    // El UPDATE exige que siga sin comprobante: dos cargas simultáneas no
    // pueden pisarse el archivo principal en silencio.
    const r = await tx.tbl_facturas.updateMany({
      where: { id: factura.id, estado: 1, id_archivo: null },
      data: { id_archivo: ids[0], user_id_modification: idUsuario, date_time_modification: new Date() }
    });
    if (r.count === 0) throw errorHttp('El comprobante de la factura cambió mientras tanto. Vuelve a abrirla.', 409);
    principal = ids[0];
    resto = ids.slice(1);
  }
  await vincularDocumentosEnTx(
    tx,
    factura.id,
    resto.map(id => ({ id_archivo: id, tipo_documento: TIPO_DOCUMENTO_COMPROBANTE })),
    idUsuario
  );
  return { principal, agregados: ids };
}

/**
 * La factura se quedó sin su archivo principal (se quitó): si el comprobante
 * tiene más archivos, el primero pasa a ser el principal, para que la factura
 * no figure «sin comprobante» teniendo uno. El vínculo se da de baja pero el
 * archivo NO (sigue en uso, ahora como principal).
 *
 * @returns {Promise<number|null>} id_archivo promovido, o null si no había otro
 */
async function promoverComprobanteEnTx(tx, idFactura, idUsuario) {
  const siguiente = await tx.tbl_facturas_archivos.findFirst({
    where: { id_factura: idFactura, estado: 1, tipo_documento: TIPO_DOCUMENTO_COMPROBANTE },
    orderBy: [{ orden: 'asc' }, { id: 'asc' }]
  });
  if (!siguiente) return null;
  const ahora = new Date();
  await tx.tbl_facturas_archivos.update({
    where: { id: siguiente.id },
    data: { estado: 0, user_id_modification: idUsuario, date_time_modification: ahora }
  });
  await tx.tbl_facturas.update({
    where: { id: idFactura },
    data: { id_archivo: siguiente.id_archivo, user_id_modification: idUsuario, date_time_modification: ahora }
  });
  return siguiente.id_archivo;
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
  TIPO_DOCUMENTO_COMPROBANTE,
  TIPOS_DOCUMENTO_FACTURA,
  TIPOS_DOCUMENTO_FACTURA_CODIGOS,
  MAX_DOCUMENTOS_FACTURA,
  SELECT_ARCHIVO,
  INCLUDE_DOCUMENTOS,
  errorHttp,
  esTipoDocumentoFacturaValido,
  tipoDocumentoValido,
  descripcionDocumento,
  normalizarDocumentos,
  vincularDocumentosEnTx,
  vincularDocumentosDeEnTx,
  idsArchivoUnicos,
  vincularComprobantesEnTx,
  promoverComprobanteEnTx,
  bajaDocumentosDeFacturasEnTx
};

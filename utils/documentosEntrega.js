/**
 * Documentos de una entrega (tbl_entregas_archivos).
 *
 * Una entrega puede llevar muchos documentos (actas, planos, manuales,
 * certificados…) y se cargan en lote: el frontend los sube uno tras otro a
 * POST /archivos y manda aquí sus ids. Las entregas registradas antes de este
 * cambio tienen su único archivo en tbl_entregas.id_archivo, que se conserva y
 * se muestra junto a estos.
 *
 * Este módulo concentra su comportamiento: vincular al registrar la entrega,
 * sincronizar al corregirla y dar de baja en cascada.
 */

/** Tope de documentos por entrega: alto a propósito, solo frena un abuso. */
const MAX_DOCUMENTOS_ENTREGA = Number(process.env.ENTREGA_MAX_DOCUMENTOS) || 500;

/** Campos del archivo que se exponen al frontend (nunca la fila completa). */
const SELECT_ARCHIVO = {
  id: true,
  nombre_original: true,
  ruta_almacenamiento: true,
  mime_type: true,
  tamano_bytes: true,
  fecha_subida: true
};

/** Include para traer los documentos activos de una entrega, ordenados. */
const INCLUDE_DOCUMENTOS_ENTREGA = {
  where: { estado: 1 },
  orderBy: [{ orden: 'asc' }, { id: 'asc' }],
  include: { archivo: { select: SELECT_ARCHIVO } }
};

function errorHttp(mensaje, codigoHttp = 400) {
  const err = new Error(mensaje);
  err.codigoHttp = codigoHttp;
  return err;
}

/** ids de tbl_archivos del payload `[{ id_archivo }]`, sin repetir. */
function idsArchivo(crudo) {
  if (!Array.isArray(crudo)) return [];
  const ids = crudo
    .map(d => Number(d?.id_archivo))
    .filter(id => Number.isInteger(id) && id > 0);
  return [...new Set(ids)];
}

/**
 * Vincula archivos ya subidos a una entrega: `crudo` = [{ id_archivo }]. Se
 * usa al registrarla —donde todavía no existía al subir— y al corregirla.
 *
 * @returns {Promise<number>} cantidad de documentos vinculados
 */
async function vincularDocumentosEntregaEnTx(tx, idEntrega, crudo, idUsuario) {
  const ids = idsArchivo(crudo);
  if (ids.length === 0) return 0;

  const yaVinculados = await tx.tbl_entregas_archivos.count({ where: { id_entrega: idEntrega, estado: 1 } });
  if (yaVinculados + ids.length > MAX_DOCUMENTOS_ENTREGA) {
    throw errorHttp(`Máximo ${MAX_DOCUMENTOS_ENTREGA} documentos por entrega (hay ${yaVinculados}).`);
  }

  // Solo archivos que existan y estén activos: evita FK colgadas si el cliente
  // manda ids inventados o de archivos ya dados de baja.
  const existentes = await tx.tbl_archivos.findMany({
    where: { id: { in: ids }, estado: 1 },
    select: { id: true }
  });
  const validos = new Set(existentes.map(a => a.id));
  const data = ids
    .filter(id => validos.has(id))
    .map((id_archivo, i) => ({
      id_entrega: idEntrega,
      id_archivo,
      orden: yaVinculados + i + 1,
      user_id_registration: idUsuario
    }));
  if (data.length === 0) return 0;
  // En una sola sentencia: una entrega puede traer cientos de documentos.
  const { count } = await tx.tbl_entregas_archivos.createMany({ data });
  return count;
}

/**
 * Deja a la entrega con exactamente los documentos de `crudo` (corrección de
 * la entrega): los que traen `id` (vínculo existente) se conservan, los que
 * traen solo `id_archivo` se vinculan y los activos que no vienen se dan de
 * baja. Solo marca los vínculos; el archivo queda en tbl_archivos.
 *
 * @returns {Promise<{ agregados: number, quitados: number }>}
 */
async function sincronizarDocumentosEntregaEnTx(tx, idEntrega, crudo, idUsuario) {
  const lista = Array.isArray(crudo) ? crudo.filter(Boolean) : [];
  const conservar = new Set(lista.filter(d => d.id).map(d => Number(d.id)));

  const actuales = await tx.tbl_entregas_archivos.findMany({
    where: { id_entrega: idEntrega, estado: 1 },
    select: { id: true }
  });
  const quitados = actuales.filter(d => !conservar.has(d.id)).map(d => d.id);
  if (quitados.length > 0) {
    await tx.tbl_entregas_archivos.updateMany({
      where: { id: { in: quitados } },
      data: { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() }
    });
  }
  // Después de las bajas, para que el tope cuente solo los que quedan.
  const agregados = await vincularDocumentosEntregaEnTx(tx, idEntrega, lista.filter(d => !d.id), idUsuario);
  return { agregados, quitados: quitados.length };
}

/**
 * Da de baja los documentos de las entregas de un servicio (cascada de
 * eliminar el servicio). Solo marca los vínculos: devuelve los ids de
 * tbl_archivos para que el llamador los dé de baja y purgue del bucket.
 *
 * @returns {Promise<number[]>} ids de tbl_archivos a dar de baja
 */
async function bajaDocumentosDeEntregasEnTx(tx, idServicio, idUsuario) {
  if (!idServicio) return [];
  const vinculos = await tx.tbl_entregas_archivos.findMany({
    where: { estado: 1, entrega: { id_servicio: idServicio } },
    select: { id: true, id_archivo: true }
  });
  if (vinculos.length === 0) return [];
  await tx.tbl_entregas_archivos.updateMany({
    where: { id: { in: vinculos.map(v => v.id) } },
    data: { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() }
  });
  return vinculos.map(v => v.id_archivo);
}

module.exports = {
  MAX_DOCUMENTOS_ENTREGA,
  INCLUDE_DOCUMENTOS_ENTREGA,
  vincularDocumentosEntregaEnTx,
  sincronizarDocumentosEntregaEnTx,
  bajaDocumentosDeEntregasEnTx
};

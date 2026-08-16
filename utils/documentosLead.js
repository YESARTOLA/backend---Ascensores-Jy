/**
 * DOCUMENTOS LIBRES DEL LEAD (tbl_leads_archivos).
 *
 * Expediente comercial del lead: la CENTRAL DE VENTAS carga aquí cualquier
 * documento del prospecto (PDF, imágenes, videos, Office, planos…) y la
 * VENDEDORA asignada los consulta y descarga desde su lead.
 *
 * Reglas del módulo:
 *   - Sube y elimina quien gestiona el ciclo comercial (ROLES_GESTION_LEAD:
 *     Central de ventas + administración). La Vendedora es SOLO LECTURA.
 *   - Lee cualquier rol con acceso al lead; el alcance por lead (la Vendedora
 *     solo los suyos) lo aplica `cargarLeadPermitido` en el controlador.
 *   - Al CONVERTIR el lead en cliente/servicio los documentos NO se copian ni se
 *     mueven: se quedan en el lead, que sigue consultable como "Ingresado".
 *
 * Es independiente de tbl_leads_cotizaciones (PDF versionado que respalda el
 * estado "Cotizado") y de tbl_clientes_archivos (expediente del cliente).
 */
const { keyDesdeRuta } = require('./storage');
const { ROLES_GESTION_LEAD } = require('./accesoLeads');

/** Tipo de carpeta en el storage. Debe existir en uploadMiddleware.TIPOS_VALIDOS. */
const TIPO_ARCHIVO = 'leads';

/** Tope de documentos por lead. Configurable por entorno. */
const MAX_DOCUMENTOS = Number(process.env.LEAD_MAX_DOCUMENTOS) || 30;

/** Campos del archivo que se exponen al frontend (nunca la fila completa). */
const SELECT_ARCHIVO = {
  id: true,
  nombre_original: true,
  ruta_almacenamiento: true,
  mime_type: true,
  tamano_bytes: true,
  fecha_subida: true
};

/** Consulta de los documentos activos de un lead, ordenados. */
const INCLUDE_DOCUMENTOS = {
  where: { estado: 1 },
  orderBy: [{ orden: 'asc' }, { id: 'asc' }],
  include: {
    archivo: { select: SELECT_ARCHIVO },
    usuario_registrador: { select: { id: true, nombres: true } }
  }
};

/**
 * Conteo de documentos activos para el LISTADO paginado: la tabla solo pinta un
 * contador; el detalle se pide al abrir el modal.
 */
const COUNT_DOCUMENTOS = { select: { documentos: { where: { estado: 1 } } } };

/** ¿El rol del usuario puede subir o eliminar documentos del lead? */
const puedeGestionarDocumentos = (user) => ROLES_GESTION_LEAD.includes(user?.rol_codigo);

/** Normaliza el payload de documentos que llega del cliente. */
function normalizarDocumentos(crudo) {
  if (!Array.isArray(crudo)) return [];
  return crudo
    .map((d, i) => ({
      id_archivo: d && d.id_archivo ? Number(d.id_archivo) : null,
      descripcion: typeof d?.descripcion === 'string' && d.descripcion.trim()
        ? d.descripcion.trim().slice(0, 200)
        : null,
      orden: Number.isFinite(Number(d?.orden)) ? Number(d.orden) : i + 1
    }))
    .filter(d => Number.isInteger(d.id_archivo) && d.id_archivo > 0);
}

/**
 * Vincula archivos ya subidos (POST /archivos) a un lead.
 *
 * @returns {Promise<number>} cantidad de vínculos creados
 */
async function vincularDocumentosEnTx(tx, idLead, crudo, idUsuario) {
  const documentos = normalizarDocumentos(crudo);
  if (documentos.length === 0) return 0;

  const yaVinculados = await tx.tbl_leads_archivos.count({
    where: { id_lead: idLead, estado: 1 }
  });
  if (yaVinculados + documentos.length > MAX_DOCUMENTOS) {
    const err = new Error(`Máximo ${MAX_DOCUMENTOS} documentos por lead (hay ${yaVinculados}).`);
    err.codigoHttp = 400;
    throw err;
  }

  // Solo archivos que existan y estén activos: evita FKs colgadas si el cliente
  // manda ids inventados o de archivos ya dados de baja.
  const ids = [...new Set(documentos.map(d => d.id_archivo))];
  const existentes = await tx.tbl_archivos.findMany({
    where: { id: { in: ids }, estado: 1 },
    select: { id: true }
  });
  const validos = new Set(existentes.map(a => a.id));

  let creados = 0;
  for (const d of documentos) {
    if (!validos.has(d.id_archivo)) continue;
    await tx.tbl_leads_archivos.create({
      data: {
        id_lead: idLead,
        id_archivo: d.id_archivo,
        descripcion: d.descripcion,
        orden: d.orden,
        user_id_registration: idUsuario
      }
    });
    creados++;
  }
  return creados;
}

module.exports = {
  TIPO_ARCHIVO,
  MAX_DOCUMENTOS,
  SELECT_ARCHIVO,
  INCLUDE_DOCUMENTOS,
  COUNT_DOCUMENTOS,
  puedeGestionarDocumentos,
  normalizarDocumentos,
  vincularDocumentosEnTx,
  keyDocumento: (archivo) => (archivo?.ruta_almacenamiento ? keyDesdeRuta(archivo.ruta_almacenamiento) : null)
};

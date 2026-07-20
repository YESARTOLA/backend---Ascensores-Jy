/**
 * Adjuntos de contexto de una emergencia: fotos y videos de la falla que carga
 * quien la reporta (coordinación / administración) para que el TÉCNICO asignado
 * los revise antes de salir a campo.
 *
 * Sentido contrario a tbl_servicios_evidencias, que es la evidencia probatoria
 * que sube el técnico DESPUÉS de intervenir (exige id_tecnico y captura GPS).
 *
 * Este módulo concentra TODO el comportamiento de los adjuntos. El único
 * acoplamiento con el dominio es la columna `id_emergencia`, de modo que
 * extenderlo al resto de módulos (correctivos, mantenimientos…) sea repuntar la
 * FK al servicio y no reescribir la lógica.
 */
const { keyDesdeRuta } = require('./storage');

/** Tipo de carpeta en el storage. Debe existir en uploadMiddleware.TIPOS_VALIDOS. */
const TIPO_ARCHIVO = 'emergencias';

/** Roles que pueden ADJUNTAR o ELIMINAR. Leer está abierto a quien vea la emergencia. */
const ROLES_GESTION = ['super_admin', 'admin', 'coordinador'];

/** Tope de adjuntos por emergencia. Configurable por entorno. */
const MAX_ADJUNTOS = Number(process.env.EMERGENCIA_MAX_ADJUNTOS) || 20;

/** Campos del archivo que se exponen al frontend (nunca la fila completa). */
const SELECT_ARCHIVO = {
  id: true,
  nombre_original: true,
  ruta_almacenamiento: true,
  mime_type: true,
  tamano_bytes: true,
  fecha_subida: true
};

/** Include para traer los adjuntos activos ordenados. */
const INCLUDE_ADJUNTOS = {
  where: { estado: 1 },
  orderBy: [{ orden: 'asc' }, { id: 'asc' }],
  include: { archivo: { select: SELECT_ARCHIVO } }
};

/**
 * Conteo de adjuntos activos para el LISTADO paginado. Se manda solo el número
 * —no las filas— porque la tabla únicamente pinta un contador; el detalle se
 * pide al abrir el modal.
 */
const COUNT_ADJUNTOS = { select: { archivos: { where: { estado: 1 } } } };

/** Normaliza el payload de adjuntos que llega del cliente. */
function normalizarAdjuntos(crudo) {
  if (!Array.isArray(crudo)) return [];
  return crudo
    .map((a, i) => ({
      id_archivo: a && a.id_archivo ? Number(a.id_archivo) : null,
      descripcion: typeof a?.descripcion === 'string' && a.descripcion.trim()
        ? a.descripcion.trim().slice(0, 200)
        : null,
      orden: Number.isFinite(Number(a?.orden)) ? Number(a.orden) : i + 1
    }))
    .filter(a => Number.isInteger(a.id_archivo) && a.id_archivo > 0);
}

/**
 * Vincula archivos ya subidos (POST /archivos) a una emergencia. Se usa tanto en
 * la creación —donde la emergencia todavía no existía al momento de subir— como
 * en el endpoint de agregar.
 *
 * @returns {number} cantidad de vínculos creados
 */
async function vincularAdjuntosEnTx(tx, idEmergencia, crudo, idUsuario) {
  const adjuntos = normalizarAdjuntos(crudo);
  if (adjuntos.length === 0) return 0;

  const yaVinculados = await tx.tbl_emergencias_archivos.count({
    where: { id_emergencia: idEmergencia, estado: 1 }
  });
  if (yaVinculados + adjuntos.length > MAX_ADJUNTOS) {
    const err = new Error(`Máximo ${MAX_ADJUNTOS} adjuntos por emergencia (hay ${yaVinculados}).`);
    err.codigoHttp = 400;
    throw err;
  }

  // Solo archivos que existan y estén activos: evita FK colgadas si el cliente
  // manda ids inventados o de archivos ya dados de baja.
  const ids = [...new Set(adjuntos.map(a => a.id_archivo))];
  const existentes = await tx.tbl_archivos.findMany({
    where: { id: { in: ids }, estado: 1 },
    select: { id: true }
  });
  const validos = new Set(existentes.map(a => a.id));

  let creados = 0;
  for (const a of adjuntos) {
    if (!validos.has(a.id_archivo)) continue;
    await tx.tbl_emergencias_archivos.create({
      data: {
        id_emergencia: idEmergencia,
        id_archivo: a.id_archivo,
        descripcion: a.descripcion,
        orden: a.orden,
        user_id_registration: idUsuario
      }
    });
    creados++;
  }
  return creados;
}

/**
 * Soft-delete de todos los adjuntos de una emergencia y recolección de sus keys
 * de storage para purgarlas TRAS el commit (igual que bajaServicioCascadaEnTx).
 *
 * @returns {Promise<string[]>} keys a purgar del bucket
 */
async function bajaAdjuntosEnTx(tx, idEmergencia, idUsuario) {
  const vinculos = await tx.tbl_emergencias_archivos.findMany({
    where: { id_emergencia: idEmergencia, estado: 1 },
    include: { archivo: { select: { id: true, ruta_almacenamiento: true } } }
  });
  if (vinculos.length === 0) return [];

  const marca = { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() };
  await tx.tbl_emergencias_archivos.updateMany({
    where: { id_emergencia: idEmergencia, estado: 1 },
    data: marca
  });
  await tx.tbl_archivos.updateMany({
    where: { id: { in: vinculos.map(v => v.id_archivo) }, estado: 1 },
    data: marca
  });

  return vinculos
    .map(v => (v.archivo?.ruta_almacenamiento ? keyDesdeRuta(v.archivo.ruta_almacenamiento) : null))
    .filter(Boolean);
}

/** ¿El rol del usuario puede adjuntar o eliminar? */
function puedeGestionar(user) {
  return ROLES_GESTION.includes(user?.rol_codigo);
}

module.exports = {
  TIPO_ARCHIVO,
  ROLES_GESTION,
  MAX_ADJUNTOS,
  SELECT_ARCHIVO,
  INCLUDE_ADJUNTOS,
  COUNT_ADJUNTOS,
  normalizarAdjuntos,
  vincularAdjuntosEnTx,
  bajaAdjuntosEnTx,
  puedeGestionar
};

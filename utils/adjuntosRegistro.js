/**
 * Adjuntos de contexto de un registro operativo (emergencia, correctivo): fotos,
 * videos y PDFs de la falla que carga quien lo reporta (coordinación /
 * administración) para que el TÉCNICO asignado los revise antes de salir a campo.
 *
 * Sentido contrario a tbl_servicios_evidencias, que es la evidencia probatoria
 * que sube el técnico DESPUÉS de intervenir (exige id_tecnico y captura GPS).
 *
 * Toda la lógica vive aquí; cada módulo solo aporta su tabla puente y su FK
 * (ver utils/adjuntosEmergencia.js y utils/adjuntosCorrectivo.js).
 */
const prisma = require('../config/prisma');
const { registrarAuditoria } = require('./auditoria');
const { keyDesdeRuta, eliminarObjeto } = require('./storage');

/** Roles que pueden ADJUNTAR o ELIMINAR. Leer está abierto a quien vea el registro. */
const ROLES_GESTION = ['super_admin', 'admin', 'coordinador'];

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

/** ¿El rol del usuario puede adjuntar o eliminar? */
function puedeGestionar(user) {
  return ROLES_GESTION.includes(user?.rol_codigo);
}

/**
 * @param {object} cfg
 * @param {string} cfg.modelo        delegado Prisma de la tabla puente (p. ej. 'tbl_emergencias_archivos')
 * @param {string} cfg.fk            columna que apunta al registro (p. ej. 'id_emergencia')
 * @param {string} cfg.tipoArchivo   carpeta del storage (debe existir en uploadMiddleware.TIPOS_VALIDOS)
 * @param {number} cfg.max           tope de adjuntos por registro
 * @param {string} cfg.porRegistro   texto para el tope ("por emergencia")
 * @param {string} cfg.noEncontrado  mensaje 404 del registro ("Emergencia no encontrada")
 * @param {string} cfg.log           prefijo de los logs ("emergencias")
 */
function crearAdjuntosRegistro({ modelo, fk, tipoArchivo, max, porRegistro, noEncontrado, log }) {
  /**
   * Vincula archivos ya subidos (POST /archivos) a un registro. Se usa tanto en
   * la creación —donde el registro todavía no existía al momento de subir—
   * como en el endpoint de agregar.
   *
   * @returns {number} cantidad de vínculos creados
   */
  async function vincularAdjuntosEnTx(tx, idRegistro, crudo, idUsuario) {
    const adjuntos = normalizarAdjuntos(crudo);
    if (adjuntos.length === 0) return 0;

    const yaVinculados = await tx[modelo].count({ where: { [fk]: idRegistro, estado: 1 } });
    if (yaVinculados + adjuntos.length > max) {
      const err = new Error(`Máximo ${max} adjuntos ${porRegistro} (hay ${yaVinculados}).`);
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
      await tx[modelo].create({
        data: {
          [fk]: idRegistro,
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
   * Soft-delete de todos los adjuntos de un registro y recolección de sus keys
   * de storage para purgarlas TRAS el commit (igual que bajaServicioCascadaEnTx).
   *
   * @returns {Promise<string[]>} keys a purgar del bucket
   */
  async function bajaAdjuntosEnTx(tx, idRegistro, idUsuario) {
    const vinculos = await tx[modelo].findMany({
      where: { [fk]: idRegistro, estado: 1 },
      include: { archivo: { select: { id: true, ruta_almacenamiento: true } } }
    });
    if (vinculos.length === 0) return [];

    const marca = { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() };
    await tx[modelo].updateMany({ where: { [fk]: idRegistro, estado: 1 }, data: marca });
    await tx.tbl_archivos.updateMany({
      where: { id: { in: vinculos.map(v => v.id_archivo) }, estado: 1 },
      data: marca
    });

    return vinculos
      .map(v => (v.archivo?.ruta_almacenamiento ? keyDesdeRuta(v.archivo.ruta_almacenamiento) : null))
      .filter(Boolean);
  }

  const listarDe = (idRegistro) => prisma[modelo].findMany({
    ...INCLUDE_ADJUNTOS,
    where: { ...INCLUDE_ADJUNTOS.where, [fk]: idRegistro }
  });

  /**
   * Endpoints REST de los adjuntos. `registroVisible(user, id)` debe aplicar la
   * MISMA visibilidad que el listado del módulo y devolver null si el usuario no
   * alcanza el registro (técnico no asignado, edificio fuera de su alcance…),
   * para responder 404 sin filtrar su existencia.
   */
  function handlers({ registroVisible }) {
    const listarArchivos = async (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!await registroVisible(req.user, id)) return res.status(404).json({ error: noEncontrado });
        const archivos = await listarDe(id);
        res.json({ data: archivos, meta: { max, puede_gestionar: puedeGestionar(req.user) } });
      } catch (err) {
        console.error(`[${log}.listarArchivos]`, err);
        res.status(500).json({ error: 'Error al listar los adjuntos' });
      }
    };

    const agregarArchivos = async (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!await registroVisible(req.user, id)) return res.status(404).json({ error: noEncontrado });
        const creados = await vincularAdjuntosEnTx(prisma, id, req.body?.archivos, req.user.id);
        if (creados === 0) return res.status(400).json({ error: 'No se recibió ningún archivo válido' });

        await registrarAuditoria({
          id_usuario: req.user.id, entidad: modelo, id_entidad: id,
          accion: 'CREATE', valor_nuevo: { [fk]: id, adjuntos: creados }, ip: req.ip
        });
        res.status(201).json({ data: await listarDe(id) });
      } catch (err) {
        if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
        console.error(`[${log}.agregarArchivos]`, err);
        res.status(500).json({ error: 'Error al adjuntar archivos' });
      }
    };

    const eliminarArchivo = async (req, res) => {
      try {
        const id = Number(req.params.id);
        const idVinculo = Number(req.params.idVinculo);
        if (!await registroVisible(req.user, id)) return res.status(404).json({ error: noEncontrado });
        const vinculo = await prisma[modelo].findFirst({
          where: { id: idVinculo, [fk]: id, estado: 1 },
          include: { archivo: { select: { id: true, ruta_almacenamiento: true } } }
        });
        if (!vinculo) return res.status(404).json({ error: 'Adjunto no encontrado' });

        const marca = { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() };
        await prisma.$transaction(async (tx) => {
          await tx[modelo].update({ where: { id: idVinculo }, data: marca });
          await tx.tbl_archivos.updateMany({ where: { id: vinculo.id_archivo, estado: 1 }, data: marca });
        });

        // Purga del bucket tras el commit: si falla, el registro ya quedó dado de
        // baja y el objeto se limpia después — nunca al revés.
        const key = vinculo.archivo?.ruta_almacenamiento ? keyDesdeRuta(vinculo.archivo.ruta_almacenamiento) : null;
        if (key) {
          try { await eliminarObjeto(key); }
          catch (e) { console.warn(`[${log}.eliminarArchivo] no se pudo borrar del bucket:`, e.message); }
        }

        await registrarAuditoria({
          id_usuario: req.user.id, entidad: modelo, id_entidad: idVinculo,
          accion: 'DELETE', valor_anterior: vinculo, ip: req.ip
        });
        res.json({ ok: true });
      } catch (err) {
        console.error(`[${log}.eliminarArchivo]`, err);
        res.status(500).json({ error: 'Error al eliminar el adjunto' });
      }
    };

    return { listarArchivos, agregarArchivos, eliminarArchivo };
  }

  return {
    TIPO_ARCHIVO: tipoArchivo,
    ROLES_GESTION,
    MAX_ADJUNTOS: max,
    SELECT_ARCHIVO,
    INCLUDE_ADJUNTOS,
    COUNT_ADJUNTOS,
    normalizarAdjuntos,
    vincularAdjuntosEnTx,
    bajaAdjuntosEnTx,
    puedeGestionar,
    handlers
  };
}

module.exports = { crearAdjuntosRegistro, ROLES_GESTION };

const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { puedeVerFinanzasReq, servicioSinPrecios } = require('../utils/visibilidadFinanzas');
const { paginar } = require('../utils/paginacion');
const { estaServicioFinalizado } = require('../utils/estadoServicio');
const { puedeEditarServicioCerrado } = require('../utils/registrosTecnico');

// Las entregas se congelan cuando el servicio termina, salvo para Administración,
// que las sigue registrando y corrigiendo con el servicio cerrado (no si está
// cancelado). Ver utils/registrosTecnico.js.
const entregasCongeladas = (user, estadoSrv) =>
  estaServicioFinalizado(estadoSrv) && !puedeEditarServicioCerrado(user, estadoSrv);
const { parseYMDLima } = require('../utils/tiempo');
const { porServicioRelacionWhere, porServicioAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');
const {
  INCLUDE_DOCUMENTOS_ENTREGA, vincularDocumentosEntregaEnTx, sincronizarDocumentosEntregaEnTx
} = require('../utils/documentosEntrega');

const _estadoServicio = async (idServicio) => {
  const srv = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio }, select: { estado_servicio: true }
  });
  return srv?.estado_servicio ?? null;
};

// Entrega con su archivo de antes y sus documentos (utils/documentosEntrega.js).
const conDocumentos = (id) => prisma.tbl_entregas.findUnique({
  where: { id },
  include: { archivo: true, documentos: INCLUDE_DOCUMENTOS_ENTREGA }
});

const listar = async (req, res) => {
  try {
    const { id_servicio, tipo_entrega, estado_entrega } = req.query;
    const where = { estado: 1 };
    if (id_servicio) where.id_servicio = Number(id_servicio);
    if (tipo_entrega) where.tipo_entrega = tipo_entrega;
    if (estado_entrega) where.estado_entrega = estado_entrega;
    // Ámbito del usuario: solo entregas de servicios/proyectos del ámbito.
    Object.assign(where, porServicioRelacionWhere(req.user));
    // Alcance por tipo de edificio (Administrador): solo entregas de servicios
    // cuyos ascensores estén en un tipo permitido.
    conAlcance(where, porServicioAscensorEdificioWhere(req.user));
    const result = await paginar(
      prisma.tbl_entregas,
      {
        where, orderBy: { id: 'desc' },
        include: { servicio: { include: { cliente: true } }, archivo: true, documentos: INCLUDE_DOCUMENTOS_ENTREGA }
      },
      req.query
    );
    // El servicio embebido trae su precio interno: se anula para los roles sin
    // visibilidad financiera (la entrega es un acto documental, no económico).
    if (!puedeVerFinanzasReq(req)) {
      result.data = result.data.map(e => ({ ...e, servicio: servicioSinPrecios(e.servicio) }));
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar entregas' });
  }
};

/**
 * Body: { id_servicio, tipo_entrega, fecha_entrega, descripcion?, estado_entrega?,
 *         documentos?: [{ id_archivo }] }
 * Los documentos se suben antes (POST /archivos), en lote, y aquí se vinculan.
 * `id_archivo` (un solo archivo) se sigue aceptando de clientes anteriores.
 */
const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_servicio || !d.tipo_entrega || !d.fecha_entrega) {
      return res.status(400).json({ error: 'Servicio, tipo y fecha obligatorios' });
    }
    const estadoSrv = await _estadoServicio(Number(d.id_servicio));
    if (entregasCongeladas(req.user, estadoSrv)) {
      return res.status(400).json({ error: `El servicio está ${estadoSrv}: no se puede registrar entregas` });
    }
    const { ent, documentos } = await prisma.$transaction(async (tx) => {
      const ent = await tx.tbl_entregas.create({
        data: {
          id_servicio: Number(d.id_servicio),
          tipo_entrega: d.tipo_entrega,
          fecha_entrega: parseYMDLima(d.fecha_entrega),
          id_responsable_usuario: req.user.id,
          descripcion: d.descripcion || null,
          id_archivo: d.id_archivo || null,
          estado_entrega: d.estado_entrega || 'Entregada',
          user_id_registration: req.user.id
        }
      });
      const documentos = await vincularDocumentosEntregaEnTx(tx, ent.id, d.documentos, req.user.id);
      return { ent, documentos };
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_entregas', id_entidad: ent.id, accion: 'CREATE',
      valor_nuevo: { ...ent, documentos }, ip: req.ip
    });
    res.status(201).json({ data: await conDocumentos(ent.id) });
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error al crear entrega' });
  }
};

/**
 * Corrige la entrega. `documentos`, si viene, es la lista completa que debe
 * quedar: [{ id }] los ya guardados, [{ id_archivo }] los nuevos. `id_archivo`
 * es el archivo único de una entrega antigua; si viene en null, se quita.
 */
const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_entregas.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'No encontrada' });
    const estadoSrv = await _estadoServicio(previo.id_servicio);
    if (entregasCongeladas(req.user, estadoSrv)) {
      return res.status(400).json({ error: `El servicio está ${estadoSrv}: no se puede modificar entregas` });
    }
    const { ent, documentos } = await prisma.$transaction(async (tx) => {
      const ent = await tx.tbl_entregas.update({
        where: { id },
        data: {
          tipo_entrega: d.tipo_entrega ?? previo.tipo_entrega,
          fecha_entrega: d.fecha_entrega ? parseYMDLima(d.fecha_entrega) : previo.fecha_entrega,
          descripcion: d.descripcion ?? previo.descripcion,
          id_archivo: d.id_archivo !== undefined ? (d.id_archivo ? Number(d.id_archivo) : null) : previo.id_archivo,
          estado_entrega: d.estado_entrega ?? previo.estado_entrega,
          user_id_modification: req.user.id, date_time_modification: new Date()
        }
      });
      const documentos = Array.isArray(d.documentos)
        ? await sincronizarDocumentosEntregaEnTx(tx, id, d.documentos, req.user.id)
        : null;
      return { ent, documentos };
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_entregas', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: { ...ent, ...(documentos && { documentos }) }, ip: req.ip
    });
    res.json({ data: await conDocumentos(id) });
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar entrega' });
  }
};

module.exports = { listar, crear, actualizar };

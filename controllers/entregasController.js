const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { paginar } = require('../utils/paginacion');
const { estaServicioFinalizado } = require('../utils/estadoServicio');
const { parseYMDLima } = require('../utils/tiempo');
const { porServicioRelacionWhere } = require('../utils/alcanceUsuario');

const _estadoServicio = async (idServicio) => {
  const srv = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio }, select: { estado_servicio: true }
  });
  return srv?.estado_servicio ?? null;
};

const listar = async (req, res) => {
  try {
    const { id_servicio, tipo_entrega, estado_entrega } = req.query;
    const where = { estado: 1 };
    if (id_servicio) where.id_servicio = Number(id_servicio);
    if (tipo_entrega) where.tipo_entrega = tipo_entrega;
    if (estado_entrega) where.estado_entrega = estado_entrega;
    // Ámbito del usuario: solo entregas de servicios/proyectos del ámbito.
    Object.assign(where, porServicioRelacionWhere(req.user));
    const result = await paginar(
      prisma.tbl_entregas,
      { where, orderBy: { id: 'desc' }, include: { servicio: { include: { cliente: true } }, archivo: true } },
      req.query
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar entregas' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_servicio || !d.tipo_entrega || !d.fecha_entrega) {
      return res.status(400).json({ error: 'Servicio, tipo y fecha obligatorios' });
    }
    const estadoSrv = await _estadoServicio(Number(d.id_servicio));
    if (estaServicioFinalizado(estadoSrv)) {
      return res.status(400).json({ error: `El servicio está ${estadoSrv}: no se puede registrar entregas` });
    }
    const ent = await prisma.tbl_entregas.create({
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
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_entregas', id_entidad: ent.id, accion: 'CREATE', valor_nuevo: ent, ip: req.ip
    });
    res.status(201).json({ data: ent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear entrega' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_entregas.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'No encontrada' });
    const estadoSrv = await _estadoServicio(previo.id_servicio);
    if (estaServicioFinalizado(estadoSrv)) {
      return res.status(400).json({ error: `El servicio está ${estadoSrv}: no se puede modificar entregas` });
    }
    const ent = await prisma.tbl_entregas.update({
      where: { id },
      data: {
        tipo_entrega: d.tipo_entrega ?? previo.tipo_entrega,
        fecha_entrega: d.fecha_entrega ? parseYMDLima(d.fecha_entrega) : previo.fecha_entrega,
        descripcion: d.descripcion ?? previo.descripcion,
        id_archivo: d.id_archivo ?? previo.id_archivo,
        estado_entrega: d.estado_entrega ?? previo.estado_entrega,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_entregas', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: ent, ip: req.ip
    });
    res.json({ data: ent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar entrega' });
  }
};

module.exports = { listar, crear, actualizar };

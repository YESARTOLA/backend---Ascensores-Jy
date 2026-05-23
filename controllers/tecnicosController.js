const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');

const listar = async (req, res) => {
  try {
    const { q, estado_operativo } = req.query;
    const where = { estado: 1 };
    if (q) where.OR = [
      { nombre: { contains: q, mode: 'insensitive' } },
      { documento: { contains: q, mode: 'insensitive' } }
    ];
    if (estado_operativo) where.estado_operativo = estado_operativo;

    const tecnicos = await prisma.tbl_tecnicos.findMany({
      where, orderBy: { id: 'asc' },
      include: { usuario: { select: { id: true, correo: true } } }
    });
    res.json({ data: tecnicos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar técnicos' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tecnico = await prisma.tbl_tecnicos.findUnique({
      where: { id },
      include: {
        usuario: { select: { id: true, correo: true, nombres: true } },
        asignaciones: {
          where: { estado: 1 },
          orderBy: { id: 'desc' },
          include: {
            servicio: { include: { cliente: true, ascensores: { where: { estado: 1 }, include: { ascensor: true } }, tipo_servicio: true } }
          }
        }
      }
    });
    if (!tecnico) return res.status(404).json({ error: 'Técnico no encontrado' });
    res.json({ data: tecnico });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener técnico' });
  }
};

const crear = async (req, res) => {
  try {
    const data = req.body;
    if (!data.nombre) return res.status(400).json({ error: 'Nombre obligatorio' });
    const tecnico = await prisma.tbl_tecnicos.create({
      data: {
        nombre: data.nombre,
        telefono: data.telefono || null,
        documento: data.documento || null,
        especialidades: data.especialidades || null,
        estado_operativo: data.estado_operativo || 'Disponible',
        observaciones: data.observaciones || null,
        user_id_registration: req.user.id
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tecnicos', id_entidad: tecnico.id,
      accion: 'CREATE', valor_nuevo: tecnico, ip: req.ip
    });
    res.status(201).json({ data: tecnico });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear técnico' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body;
    const previo = await prisma.tbl_tecnicos.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Técnico no encontrado' });
    const tecnico = await prisma.tbl_tecnicos.update({
      where: { id },
      data: {
        nombre: data.nombre ?? previo.nombre,
        telefono: data.telefono ?? previo.telefono,
        documento: data.documento ?? previo.documento,
        especialidades: data.especialidades ?? previo.especialidades,
        estado_operativo: data.estado_operativo ?? previo.estado_operativo,
        observaciones: data.observaciones ?? previo.observaciones,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tecnicos', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: tecnico, ip: req.ip
    });
    res.json({ data: tecnico });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar técnico' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    const previo = await prisma.tbl_tecnicos.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Técnico no encontrado' });
    const tecnico = await prisma.tbl_tecnicos.update({
      where: { id },
      data: { estado: Number(estado), user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tecnicos', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado: Number(estado) }, ip: req.ip
    });
    res.json({ data: tecnico });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

module.exports = { listar, obtener, crear, actualizar, cambiarEstado };

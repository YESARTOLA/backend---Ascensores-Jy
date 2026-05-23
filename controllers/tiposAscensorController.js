const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');

const listar = async (req, res) => {
  try {
    const incluirInactivos = req.query.incluir_inactivos === '1';
    const where = incluirInactivos ? {} : { estado: 1 };
    const tipos = await prisma.tbl_tipos_ascensor.findMany({
      where,
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }]
    });
    res.json({ data: tipos });
  } catch (err) {
    console.error('[tiposAscensor.listar]', err);
    res.status(500).json({ error: 'Error al listar tipos de ascensor' });
  }
};

const crear = async (req, res) => {
  try {
    const { nombre, descripcion, orden } = req.body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: 'Nombre obligatorio' });
    }
    const nombreLimpio = String(nombre).trim();
    const dup = await prisma.tbl_tipos_ascensor.findFirst({ where: { nombre: nombreLimpio } });
    if (dup) return res.status(400).json({ error: 'Ya existe un tipo con ese nombre' });

    const tipo = await prisma.tbl_tipos_ascensor.create({
      data: {
        nombre: nombreLimpio,
        descripcion: descripcion || null,
        orden: Number.isFinite(Number(orden)) ? Number(orden) : 0,
        user_id_registration: req.user.id
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_ascensor', id_entidad: tipo.id,
      accion: 'CREATE', valor_nuevo: tipo, ip: req.ip
    });
    res.status(201).json({ data: tipo });
  } catch (err) {
    console.error('[tiposAscensor.crear]', err);
    res.status(500).json({ error: 'Error al crear tipo de ascensor' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nombre, descripcion, orden } = req.body;
    const previo = await prisma.tbl_tipos_ascensor.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Tipo no encontrado' });

    if (nombre && String(nombre).trim() !== previo.nombre) {
      const dup = await prisma.tbl_tipos_ascensor.findFirst({
        where: { nombre: String(nombre).trim(), NOT: { id } }
      });
      if (dup) return res.status(400).json({ error: 'Ya existe un tipo con ese nombre' });
    }

    const tipo = await prisma.tbl_tipos_ascensor.update({
      where: { id },
      data: {
        nombre: nombre !== undefined ? String(nombre).trim() : previo.nombre,
        descripcion: descripcion !== undefined ? (descripcion || null) : previo.descripcion,
        orden: orden !== undefined && Number.isFinite(Number(orden)) ? Number(orden) : previo.orden,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_ascensor', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: tipo, ip: req.ip
    });
    res.json({ data: tipo });
  } catch (err) {
    console.error('[tiposAscensor.actualizar]', err);
    res.status(500).json({ error: 'Error al actualizar tipo de ascensor' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    const previo = await prisma.tbl_tipos_ascensor.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Tipo no encontrado' });
    const tipo = await prisma.tbl_tipos_ascensor.update({
      where: { id },
      data: { estado: Number(estado), user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_ascensor', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado: Number(estado) }, ip: req.ip
    });
    res.json({ data: tipo });
  } catch (err) {
    console.error('[tiposAscensor.cambiarEstado]', err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

module.exports = { listar, crear, actualizar, cambiarEstado };

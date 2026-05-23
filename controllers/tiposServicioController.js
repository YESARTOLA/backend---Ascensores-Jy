const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { esCategoriaPreventiva } = require('../utils/categoriasMantenimiento');
const { MODULOS_VALIDOS } = require('../utils/replicarEnModulo');

// Acepta null/'' (sin módulo) o uno de los valores válidos.
function normalizarModuloAsociado(valor) {
  if (valor == null || valor === '') return null;
  const v = String(valor).trim().toLowerCase();
  if (!MODULOS_VALIDOS.includes(v)) {
    throw new Error(`Módulo asociado inválido. Permitidos: ${MODULOS_VALIDOS.join(', ')} o vacío`);
  }
  return v;
}

const listar = async (_req, res) => {
  try {
    const tipos = await prisma.tbl_tipos_servicio.findMany({
      where: { estado: 1 }, orderBy: { id: 'asc' },
      include: {
        tecnicos: { where: { estado: 1 }, include: { tecnico: { select: { id: true, nombre: true } } } }
      }
    });
    const data = tipos.map(t => ({ ...t, es_preventivo: esCategoriaPreventiva(t.categoria) }));
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar tipos de servicio' });
  }
};

const listarTecnicos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rel = await prisma.tbl_tipos_servicio_tecnicos.findMany({
      where: { id_tipo_servicio: id, estado: 1 },
      include: { tecnico: true }
    });
    res.json({ data: rel.map(r => r.tecnico) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar técnicos del tipo' });
  }
};

const vincularTecnico = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { id_tecnico } = req.body;
    if (!id_tecnico) return res.status(400).json({ error: 'Técnico obligatorio' });
    const r = await prisma.tbl_tipos_servicio_tecnicos.upsert({
      where: { id_tipo_servicio_id_tecnico: { id_tipo_servicio: id, id_tecnico: Number(id_tecnico) } },
      update: { estado: 1, user_id_modification: req.user.id, date_time_modification: new Date() },
      create: { id_tipo_servicio: id, id_tecnico: Number(id_tecnico), user_id_registration: req.user.id }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio_tecnicos', id_entidad: r.id,
      accion: 'LINK', valor_nuevo: { id_tipo_servicio: id, id_tecnico: Number(id_tecnico) }, ip: req.ip
    });
    res.status(201).json({ data: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al vincular' });
  }
};

const desvincularTecnico = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const id_tecnico = Number(req.params.id_tecnico);
    await prisma.tbl_tipos_servicio_tecnicos.updateMany({
      where: { id_tipo_servicio: id, id_tecnico },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio_tecnicos', id_entidad: id,
      accion: 'UNLINK', valor_anterior: { id_tipo_servicio: id, id_tecnico }, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al desvincular' });
  }
};

const crear = async (req, res) => {
  try {
    const data = req.body;
    if (!data.nombre || !data.categoria) return res.status(400).json({ error: 'Nombre y categoría obligatorios' });
    let moduloAsociado;
    try { moduloAsociado = normalizarModuloAsociado(data.modulo_asociado); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const tipo = await prisma.tbl_tipos_servicio.create({
      data: {
        nombre: data.nombre,
        categoria: data.categoria,
        modulo_asociado: moduloAsociado,
        descripcion: data.descripcion || null,
        user_id_registration: req.user.id
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio', id_entidad: tipo.id,
      accion: 'CREATE', valor_nuevo: tipo, ip: req.ip
    });
    res.status(201).json({ data: tipo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear tipo' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body;
    const previo = await prisma.tbl_tipos_servicio.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Tipo no encontrado' });
    let moduloAsociado = previo.modulo_asociado;
    if (Object.prototype.hasOwnProperty.call(data, 'modulo_asociado')) {
      try { moduloAsociado = normalizarModuloAsociado(data.modulo_asociado); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }
    const tipo = await prisma.tbl_tipos_servicio.update({
      where: { id },
      data: {
        nombre: data.nombre ?? previo.nombre,
        categoria: data.categoria ?? previo.categoria,
        modulo_asociado: moduloAsociado,
        descripcion: data.descripcion ?? previo.descripcion,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: tipo, ip: req.ip
    });
    res.json({ data: tipo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar tipo' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    const previo = await prisma.tbl_tipos_servicio.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Tipo no encontrado' });
    const tipo = await prisma.tbl_tipos_servicio.update({
      where: { id }, data: { estado: Number(estado), user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado: Number(estado) }, ip: req.ip
    });
    res.json({ data: tipo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

module.exports = { listar, crear, actualizar, cambiarEstado, listarTecnicos, vincularTecnico, desvincularTecnico };

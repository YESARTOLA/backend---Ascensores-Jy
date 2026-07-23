const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { estaServicioFinalizado } = require('../utils/estadoServicio');

const subirEvidencia = async (req, res) => {
  try {
    const id_servicio = Number(req.params.id);
    const { id_archivo, tipo_evidencia, descripcion, id_dia, momento } = req.body;
    // Momento del trabajo al que pertenece la evidencia. Opcional; si viene debe
    // ser uno de los valores canónicos. NULL = sin clasificar.
    let momentoNorm = null;
    if (momento !== undefined && momento !== null && momento !== '') {
      if (!['Antes', 'Despues'].includes(momento)) {
        return res.status(400).json({ error: 'Momento inválido (use Antes o Despues)' });
      }
      momentoNorm = momento;
    }
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: id_servicio }, include: { asignaciones: { where: { estado: 1 } } }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (estaServicioFinalizado(servicio.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${servicio.estado_servicio}: no se puede subir evidencias` });
    }
    const id_tecnico = req.user.id_tecnico || servicio.asignaciones[0]?.id_tecnico;
    if (!id_tecnico) return res.status(400).json({ error: 'No hay técnico asignado' });

    // Día del servicio al que pertenece la evidencia (servicios multidía). Opcional;
    // si viene, debe ser un día activo de ESTE servicio.
    let idDia = null;
    if (id_dia !== undefined && id_dia !== null && id_dia !== '') {
      const dia = await prisma.tbl_servicios_dias.findFirst({
        where: { id: Number(id_dia), id_servicio, estado: 1 }
      });
      if (!dia) return res.status(400).json({ error: 'El día indicado no pertenece al servicio' });
      idDia = dia.id;
    }

    const evidencia = await prisma.tbl_servicios_evidencias.create({
      data: {
        id_servicio, id_tecnico,
        id_dia: idDia,
        id_archivo: id_archivo || null,
        tipo_evidencia: tipo_evidencia || 'Foto',
        descripcion: descripcion || null,
        momento: momentoNorm,
        user_id_registration: req.user.id
      }
    });
    res.status(201).json({ data: evidencia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir evidencia' });
  }
};

const listarEvidencias = async (req, res) => {
  try {
    const id_servicio = Number(req.params.id);
    const list = await prisma.tbl_servicios_evidencias.findMany({
      where: { id_servicio, estado: 1 },
      include: { archivo: true, tecnico: true },
      orderBy: { id: 'desc' }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar evidencias' });
  }
};

// Registra/edita el comentario (descripción) de una evidencia ya subida. Pensado
// para el flujo "adjuntar la foto primero, escribir el comentario después".
const actualizarEvidencia = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { descripcion } = req.body;
    const previa = await prisma.tbl_servicios_evidencias.findUnique({
      where: { id },
      include: { servicio: { select: { estado_servicio: true } } }
    });
    if (!previa) return res.status(404).json({ error: 'Evidencia no encontrada' });
    if (previa.estado === 0) return res.status(400).json({ error: 'Evidencia eliminada' });
    if (estaServicioFinalizado(previa.servicio?.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${previa.servicio.estado_servicio}: no se puede editar evidencias` });
    }
    const evidencia = await prisma.tbl_servicios_evidencias.update({
      where: { id },
      data: {
        descripcion: (descripcion ?? '').trim() || null,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    res.json({ data: evidencia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar evidencia' });
  }
};

const eliminarEvidencia = async (req, res) => {
  try {
    if (!['super_admin', 'admin', 'tecnico'].includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'No tiene permiso para eliminar evidencias' });
    }
    const id = Number(req.params.id);
    const previa = await prisma.tbl_servicios_evidencias.findUnique({
      where: { id },
      include: { archivo: true, servicio: { select: { estado_servicio: true } } }
    });
    if (!previa) return res.status(404).json({ error: 'Evidencia no encontrada' });
    if (previa.estado === 0) return res.status(400).json({ error: 'Evidencia ya eliminada' });
    if (estaServicioFinalizado(previa.servicio?.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${previa.servicio.estado_servicio}: no se puede eliminar evidencias` });
    }

    await prisma.tbl_servicios_evidencias.update({
      where: { id },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_evidencias', id_entidad: id,
      accion: 'DELETE', valor_anterior: previa, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar evidencia' });
  }
};

module.exports = { subirEvidencia, listarEvidencias, actualizarEvidencia, eliminarEvidencia };

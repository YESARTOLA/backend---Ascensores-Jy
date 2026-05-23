const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { estaServicioFinalizado, cambiarEstadoServicio } = require('../utils/estadoServicio');

// Estados terminales del servicio: bloquean incluso la aprobación/observación
// administrativa del checklist (cambiarEstadoChecklist). Las acciones operativas
// sobre ítems usan estaServicioFinalizado() — más amplio.
const ESTADOS_SERVICIO_TERMINALES = ['Cerrado', 'Cancelado'];

// Retorna el estado_servicio asociado al checklist (por id_checklist) o null si no existe.
const _estadoServicioPorChecklist = async (idChecklist) => {
  const chk = await prisma.tbl_checklists_salida.findUnique({
    where: { id: idChecklist }, select: { servicio: { select: { estado_servicio: true } } }
  });
  return chk?.servicio?.estado_servicio ?? null;
};

// Recalcula el estado del checklist a partir del estado de sus ítems activos.
// - 0 ítems → "Pendiente"
// - todos en "Completo" → "Completo" (+ transición de servicio a "Listo para salida" la 1ª vez)
// - hay algún "Pendiente" → "En llenado"
// No toca los estados administrativos "Aprobado" / "Observado".
const _recalcEstadoChecklist = async (idChecklist, userId) => {
  const checklist = await prisma.tbl_checklists_salida.findUnique({
    where: { id: idChecklist },
    include: { items: { where: { estado: 1 } } }
  });
  if (!checklist) return null;
  if (['Aprobado', 'Observado'].includes(checklist.estado_checklist)) return checklist;

  const items = checklist.items || [];
  let nuevoEstado;
  if (items.length === 0) {
    nuevoEstado = 'Pendiente';
  } else if (items.every(it => it.estado_item === 'Completo')) {
    nuevoEstado = 'Completo';
  } else {
    nuevoEstado = 'En llenado';
  }

  if (nuevoEstado === checklist.estado_checklist) return checklist;

  const data = {
    estado_checklist: nuevoEstado,
    user_id_modification: userId,
    date_time_modification: new Date()
  };
  if (nuevoEstado === 'Completo') data.fecha_completado = new Date();
  if (checklist.estado_checklist === 'Completo' && nuevoEstado !== 'Completo') data.fecha_completado = null;

  const actualizado = await prisma.tbl_checklists_salida.update({ where: { id: idChecklist }, data });

  // Cuando el checklist pasa a "Completo" por 1ª vez, avanzamos el servicio si está en
  // "Checklist de salida pendiente" → "Listo para salida". No revertimos automáticamente.
  // cambiarEstadoServicio sincroniza recordatorio + estado_global de la cotización.
  if (nuevoEstado === 'Completo') {
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({ where: { id: checklist.id_servicio } });
    if (servicio && servicio.estado_servicio === 'Checklist de salida pendiente') {
      await cambiarEstadoServicio(checklist.id_servicio, 'Listo para salida', userId);
    }
  }

  return actualizado;
};

const obtenerPorServicio = async (req, res) => {
  try {
    const id_servicio = Number(req.params.id);
    const checklist = await prisma.tbl_checklists_salida.findUnique({
      where: { id_servicio },
      include: {
        items: { where: { estado: 1 } },
        tecnico_responsable: true
      }
    });
    res.json({ data: checklist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener checklist' });
  }
};

const agregarItem = async (req, res) => {
  try {
    const id_checklist = Number(req.params.id);
    const d = req.body;
    if (!d.nombre) return res.status(400).json({ error: 'Nombre del ítem obligatorio' });
    if (!d.cantidad || Number(d.cantidad) <= 0) return res.status(400).json({ error: 'Cantidad debe ser > 0' });
    const estadoSrv = await _estadoServicioPorChecklist(id_checklist);
    if (estaServicioFinalizado(estadoSrv)) {
      return res.status(400).json({ error: `El servicio está ${estadoSrv}: no se puede modificar el checklist` });
    }
    const item = await prisma.tbl_checklists_salida_items.create({
      data: {
        id_checklist,
        tipo_item: d.tipo_item || 'Herramienta',
        nombre: d.nombre,
        cantidad: d.cantidad,
        unidad: d.unidad || 'Unidad',
        observaciones: d.observaciones || null,
        user_id_registration: req.user.id
      }
    });
    await _recalcEstadoChecklist(id_checklist, req.user.id);
    res.status(201).json({ data: item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al agregar ítem' });
  }
};

const actualizarItem = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_checklists_salida_items.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Ítem no encontrado' });
    const estadoSrv = await _estadoServicioPorChecklist(previo.id_checklist);
    if (estaServicioFinalizado(estadoSrv)) {
      return res.status(400).json({ error: `El servicio está ${estadoSrv}: no se puede modificar el checklist` });
    }
    const item = await prisma.tbl_checklists_salida_items.update({
      where: { id },
      data: {
        tipo_item: d.tipo_item ?? previo.tipo_item,
        nombre: d.nombre ?? previo.nombre,
        cantidad: d.cantidad ?? previo.cantidad,
        unidad: d.unidad ?? previo.unidad,
        estado_item: d.estado_item ?? previo.estado_item,
        observaciones: d.observaciones ?? previo.observaciones,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    await _recalcEstadoChecklist(previo.id_checklist, req.user.id);
    res.json({ data: item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar ítem' });
  }
};

const eliminarItem = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await prisma.tbl_checklists_salida_items.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Ítem no encontrado' });
    const estadoSrv = await _estadoServicioPorChecklist(previo.id_checklist);
    if (estaServicioFinalizado(estadoSrv)) {
      return res.status(400).json({ error: `El servicio está ${estadoSrv}: no se puede modificar el checklist` });
    }
    await prisma.tbl_checklists_salida_items.update({
      where: { id }, data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await _recalcEstadoChecklist(previo.id_checklist, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar ítem' });
  }
};

const completar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const checklist = await prisma.tbl_checklists_salida.findUnique({
      where: { id }, include: { items: { where: { estado: 1 } }, servicio: { select: { estado_servicio: true } } }
    });
    if (!checklist) return res.status(404).json({ error: 'Checklist no encontrado' });
    if (estaServicioFinalizado(checklist.servicio?.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${checklist.servicio.estado_servicio}: no se puede modificar el checklist` });
    }
    if (checklist.items.length === 0) return res.status(400).json({ error: 'El checklist no puede estar vacío' });

    await prisma.tbl_checklists_salida.update({
      where: { id },
      data: {
        estado_checklist: 'Completo',
        fecha_completado: new Date(),
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    // cambiarEstadoServicio registra historial + sincroniza recordatorio y
    // estado_global de la cotización origen.
    await cambiarEstadoServicio(checklist.id_servicio, 'Listo para salida', req.user.id);
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_checklists_salida', id_entidad: id, accion: 'COMPLETE', ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al completar checklist' });
  }
};

const cambiarEstadoChecklist = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado_checklist, observaciones } = req.body;
    const estadosValidos = ['Pendiente', 'En llenado', 'Completo', 'Observado', 'Aprobado'];
    if (!estadosValidos.includes(estado_checklist)) return res.status(400).json({ error: 'Estado inválido' });

    const estadoSrv = await _estadoServicioPorChecklist(id);
    if (ESTADOS_SERVICIO_TERMINALES.includes(estadoSrv)) {
      return res.status(400).json({ error: `El servicio está ${estadoSrv}: no se puede modificar el checklist` });
    }

    // Aprobar u Observar son acciones administrativas: solo Admin/Super Admin/Coordinador
    const rolesValidador = ['super_admin', 'admin', 'coordinador'];
    if (['Aprobado', 'Observado'].includes(estado_checklist) && !rolesValidador.includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'Solo Admin, Super Admin o Coordinador pueden aprobar/observar el checklist' });
    }

    const data = {
      estado_checklist,
      user_id_modification: req.user.id,
      date_time_modification: new Date()
    };
    if (observaciones !== undefined) data.observaciones = observaciones;
    if (estado_checklist === 'Aprobado' || estado_checklist === 'Completo') {
      data.validado_por = req.user.id;
      data.fecha_completado = new Date();
    }
    const chk = await prisma.tbl_checklists_salida.update({ where: { id }, data });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_checklists_salida', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_nuevo: { estado_checklist, validado_por: data.validado_por || null }, ip: req.ip
    });

    res.json({ data: chk });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado del checklist' });
  }
};

module.exports = { obtenerPorServicio, agregarItem, actualizarItem, eliminarItem, completar, cambiarEstadoChecklist, _recalcEstadoChecklist };

/**
 * Observaciones técnicas detectadas durante la ejecución de un servicio
 * (mantenimiento / emergencia / correctivo).
 *
 * Reglas:
 *  - Solo los técnicos asignados al servicio (vía tbl_servicios_asignaciones)
 *    o roles super_admin/admin pueden REGISTRAR observaciones.
 *  - El rol coordinador, junto con super_admin/admin, puede marcar una
 *    observación como "atendida".
 *  - Cualquier rol con acceso al servicio puede LISTAR observaciones (la
 *    visibilidad del servicio ya está gobernada por sus propios endpoints).
 *  - Al crear/atender se sincroniza un recordatorio agregado para que el
 *    coordinador lo vea en su dashboard y módulo Recordatorios.
 */
const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { esServicioPostRevision } = require('../utils/estadoServicio');
const { sincronizarRecordatorioObservaciones, crearAlertaObservacion, descartarAlertaObservacion, sincronizarRecordatorioCotizacionUrgente } = require('../utils/recordatoriosAuto');

const ROLES_ATIENDEN = ['super_admin', 'admin', 'coordinador'];
const ROLES_ADMIN = ['super_admin', 'admin'];

async function tecnicoEstaAsignado(idServicio, idTecnico) {
  if (!idTecnico) return false;
  const asignacion = await prisma.tbl_servicios_asignaciones.findFirst({
    where: { id_servicio: idServicio, id_tecnico: idTecnico, estado: 1 }
  });
  return Boolean(asignacion);
}

const listar = async (req, res) => {
  try {
    // Contabilidad no ve las observaciones técnicas (ni comentario ni imagen):
    // recibe únicamente el aviso de facturación por recordatorios.
    if (req.user.rol_codigo === 'contabilidad') {
      return res.status(403).json({ error: 'No autorizado para ver observaciones técnicas' });
    }
    const idServicio = Number(req.params.idServicio);
    const observaciones = await prisma.tbl_servicios_observaciones.findMany({
      where: { id_servicio: idServicio, estado: 1 },
      orderBy: { id: 'desc' },
      include: {
        archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } },
        // Si la observación ya se jaló a una cotización, exponer su código para
        // que el frontend la muestre como "ya cotizada" y no permita re-jalarla.
        cotizacion: { select: { id: true, codigo: true } }
      }
    });
    // Adjuntar info del autor y del atendedor
    const ids = [...new Set([
      ...observaciones.map(o => o.registrada_por).filter(Boolean),
      ...observaciones.map(o => o.atendida_por).filter(Boolean)
    ])];
    let usuariosMap = new Map();
    if (ids.length > 0) {
      const usuarios = await prisma.tbl_usuarios.findMany({
        where: { id: { in: ids } },
        select: { id: true, nombres: true, rol: { select: { codigo: true, nombre: true } } }
      });
      usuariosMap = new Map(usuarios.map(u => [u.id, u]));
    }
    const data = observaciones.map(o => ({
      ...o,
      registrada_por_usuario: o.registrada_por ? (usuariosMap.get(o.registrada_por) || null) : null,
      atendida_por_usuario: o.atendida_por ? (usuariosMap.get(o.atendida_por) || null) : null
    }));
    res.json({ data });
  } catch (err) {
    console.error('[observacionesServicio.listar]', err);
    res.status(500).json({ error: 'Error al listar observaciones' });
  }
};

const crear = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const texto = (req.body?.texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'El texto de la observación es obligatorio' });
    if (texto.length > 5000) return res.status(400).json({ error: 'La observación excede 5000 caracteres' });

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({ where: { id: idServicio } });
    if (!servicio || servicio.estado !== 1) return res.status(404).json({ error: 'Servicio no encontrado' });

    // Mismo gate que guías de salida: a partir de "En revisión administrativa"
    // (y todo el flujo posterior) no se aceptan nuevas observaciones técnicas.
    // El predicado deja pasar "Finalizado por técnico" / "Finalizado observado"
    // para regularización.
    if (esServicioPostRevision(servicio.estado_servicio)) {
      return res.status(400).json({
        error: `El servicio está ${servicio.estado_servicio}: no se pueden registrar observaciones técnicas`
      });
    }

    // Solo técnicos asignados o roles administrativos pueden registrar
    const esAdmin = ROLES_ADMIN.includes(req.user.rol_codigo);
    if (!esAdmin) {
      if (req.user.rol_codigo !== 'tecnico') {
        return res.status(403).json({ error: 'Solo los técnicos asignados pueden registrar observaciones' });
      }
      const asignado = await tecnicoEstaAsignado(idServicio, req.user.id_tecnico);
      if (!asignado) {
        return res.status(403).json({ error: 'No estás asignado a este servicio' });
      }
    }

    const idArchivo = req.body?.id_archivo ? Number(req.body.id_archivo) : null;
    const generaAlerta = req.body?.genera_alerta ? 1 : 0;

    const obs = await prisma.tbl_servicios_observaciones.create({
      data: {
        id_servicio: idServicio,
        texto,
        id_archivo: idArchivo,
        genera_alerta: generaAlerta,
        registrada_por: req.user.id,
        user_id_registration: req.user.id
      },
      include: { archivo: true }
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_observaciones', id_entidad: obs.id,
      accion: 'CREATE', valor_nuevo: { id_servicio: idServicio, texto: texto.slice(0, 200), genera_alerta: generaAlerta }, ip: req.ip
    });

    sincronizarRecordatorioObservaciones(idServicio).catch(err =>
      console.error('Sync rec observacion:', err));
    sincronizarRecordatorioCotizacionUrgente(idServicio).catch(err =>
      console.error('Sync cotizacion urgente:', err));
    if (generaAlerta === 1) {
      crearAlertaObservacion(obs.id).catch(err =>
        console.error('Crear alerta observacion:', err));
    }

    res.status(201).json({ data: obs });
  } catch (err) {
    console.error('[observacionesServicio.crear]', err);
    res.status(500).json({ error: 'Error al crear observación' });
  }
};

const atender = async (req, res) => {
  try {
    if (!ROLES_ATIENDEN.includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'No autorizado para atender observaciones' });
    }
    const id = Number(req.params.id);
    const previa = await prisma.tbl_servicios_observaciones.findUnique({ where: { id } });
    if (!previa || previa.estado !== 1) return res.status(404).json({ error: 'Observación no encontrada' });
    if (previa.atendida === 1) return res.json({ data: previa });

    const obs = await prisma.tbl_servicios_observaciones.update({
      where: { id },
      data: {
        atendida: 1,
        atendida_por: req.user.id,
        fecha_atendida: new Date(),
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_observaciones', id_entidad: id,
      accion: 'ATENDER', valor_anterior: previa, valor_nuevo: obs, ip: req.ip
    });
    sincronizarRecordatorioObservaciones(previa.id_servicio).catch(err =>
      console.error('Sync rec observacion:', err));
    descartarAlertaObservacion(previa.id).catch(err =>
      console.error('Descartar alerta observacion:', err));
    res.json({ data: obs });
  } catch (err) {
    console.error('[observacionesServicio.atender]', err);
    res.status(500).json({ error: 'Error al atender observación' });
  }
};

const eliminar = async (req, res) => {
  try {
    if (!ROLES_ADMIN.includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'Solo super_admin/admin pueden eliminar observaciones' });
    }
    const id = Number(req.params.id);
    const previa = await prisma.tbl_servicios_observaciones.findUnique({ where: { id } });
    if (!previa || previa.estado !== 1) return res.status(404).json({ error: 'Observación no encontrada' });
    await prisma.tbl_servicios_observaciones.update({
      where: { id },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_observaciones', id_entidad: id,
      accion: 'DELETE', valor_anterior: previa, ip: req.ip
    });
    sincronizarRecordatorioObservaciones(previa.id_servicio).catch(err =>
      console.error('Sync rec observacion:', err));
    sincronizarRecordatorioCotizacionUrgente(previa.id_servicio).catch(err =>
      console.error('Sync cotizacion urgente:', err));
    descartarAlertaObservacion(previa.id).catch(err =>
      console.error('Descartar alerta observacion:', err));
    res.json({ ok: true });
  } catch (err) {
    console.error('[observacionesServicio.eliminar]', err);
    res.status(500).json({ error: 'Error al eliminar observación' });
  }
};

module.exports = { listar, crear, atender, eliminar };

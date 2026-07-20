const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { parseYMDLima, parseYMDFinDiaLima, inicioDelDiaLima, finDelDiaLima, parseDateTimeLocalLima, inicioDelMinutoActual } = require('../utils/tiempo');
const { COLORES } = require('../utils/recordatoriosAuto');
const { paginarArray } = require('../utils/paginacion');
const {
  tiposRecordatorioPermitidos,
  soloOperativosAsignados
} = require('../utils/visibilidadCalendario');

// Include base + asignaciones activas para poder validar acceso por técnico.
const includeRel = {
  servicio: {
    include: {
      cliente: true,
      ascensores: { where: { estado: 1 }, include: { ascensor: true } },
      tipo_servicio: true,
      asignaciones: { where: { estado: 1 } }
    }
  },
  mantenimiento_plan: { include: { cliente: true, ascensores: { where: { estado: 1 }, include: { ascensor: true } }, tipo_servicio: true } },
  emergencia: {
    include: {
      cliente: true,
      ascensor: true,
      servicio: { include: { asignaciones: { where: { estado: 1 } } } }
    }
  },
  cobro: { include: { cliente: true, servicio: true } },
  cuota: true
};

/**
 * Construye el `where` de Prisma con los filtros de visibilidad para el usuario:
 * - Limita por `tipo` según la matriz VISIBILIDAD_POR_ROL.
 * - Si el rol solo ve operativos asignados (técnico), exige que el recordatorio
 *   tenga `id_servicio` con asignación activa al técnico, o `id_emergencia`
 *   cuyo servicio esté asignado al técnico.
 */
function whereVisible(user) {
  const tipos = tiposRecordatorioPermitidos(user.rol_codigo);
  const clauses = [{ tipo: { in: tipos } }];
  // Los recordatorios manuales son PRIVADOS: cada usuario ve únicamente los que
  // él creó. Los demás tipos (auto: servicio, cobro, etc.) se comparten según
  // la matriz de roles.
  if (tipos.includes('manual')) {
    clauses.push({ OR: [{ tipo: { not: 'manual' } }, { user_id_registration: user.id }] });
  }
  if (soloOperativosAsignados(user.rol_codigo)) {
    const idTec = user.id_tecnico || -1;
    clauses.push({
      OR: [
        { servicio:   { asignaciones: { some: { id_tecnico: idTec, estado: 1 } } } },
        { emergencia: { servicio: { asignaciones: { some: { id_tecnico: idTec, estado: 1 } } } } }
      ]
    });
  }
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

/**
 * Combina dos `where` con AND. Útil para mezclar `whereVisible` con filtros del
 * request sin perder las cláusulas internas (incluido el `OR` por asignación).
 */
function andWhere(base, extra) {
  const a = base || {};
  const b = extra || {};
  if (Object.keys(a).length === 0) return b;
  if (Object.keys(b).length === 0) return a;
  return { AND: [a, b] };
}

/**
 * Valida si el usuario puede operar sobre un recordatorio concreto. Espera que
 * el recordatorio haya sido cargado con el `includeRel` de arriba (en
 * particular las asignaciones del servicio y de la emergencia.servicio).
 */
/**
 * True si el valor (string del input datetime-local o ISO) representa un
 * instante anterior al minuto actual. La fecha de un recordatorio no puede
 * quedar en el pasado, ni al crear ni al editar.
 */
function fechaEnPasado(valor) {
  if (!valor) return false;
  const fecha = parseDateTimeLocalLima(valor);
  if (!fecha || isNaN(fecha.getTime())) return false;
  return fecha.getTime() < inicioDelMinutoActual().getTime();
}

function puedeAcceder(rec, user) {
  const tipos = tiposRecordatorioPermitidos(user.rol_codigo);
  if (!tipos.includes(rec.tipo)) return false;
  // Un recordatorio manual solo lo puede ver/operar su creador (privado).
  if (rec.tipo === 'manual' && rec.user_id_registration !== user.id) return false;
  if (!soloOperativosAsignados(user.rol_codigo)) return true;
  const idTec = user.id_tecnico;
  if (!idTec) return false;
  const enServicio = (rec.servicio?.asignaciones || []).some(a => a.id_tecnico === idTec && a.estado === 1);
  const enEmergencia = (rec.emergencia?.servicio?.asignaciones || []).some(a => a.id_tecnico === idTec && a.estado === 1);
  return enServicio || enEmergencia;
}

const listar = async (req, res) => {
  try {
    const { tipo, estado_recordatorio, prioridad, id_cliente, desde, hasta, q, origen } = req.query;
    const filtros = { estado: 1 };
    if (tipo) filtros.tipo = tipo;
    if (estado_recordatorio) filtros.estado_recordatorio = estado_recordatorio;
    if (prioridad) filtros.prioridad = prioridad;
    if (origen) filtros.origen = origen;
    if (desde || hasta) {
      filtros.fecha_recordatorio = {};
      if (desde) filtros.fecha_recordatorio.gte = parseYMDLima(desde);
      if (hasta) filtros.fecha_recordatorio.lte = parseYMDFinDiaLima(hasta);
    }
    if (id_cliente) {
      const idC = Number(id_cliente);
      filtros.OR = [
        { servicio: { id_cliente: idC } },
        { mantenimiento_plan: { id_cliente: idC } },
        { emergencia: { id_cliente: idC } },
        { cobro: { id_cliente: idC } }
      ];
    }

    const where = andWhere(filtros, whereVisible(req.user));

    let list = await prisma.tbl_recordatorios.findMany({
      where,
      include: includeRel,
      orderBy: [{ fecha_recordatorio: 'asc' }, { id: 'desc' }],
      take: req.query.page ? undefined : 500
    });

    if (q) {
      const ql = q.toLowerCase();
      list = list.filter(r => {
        const haystack = [
          r.titulo, r.descripcion,
          r.servicio?.codigo, r.servicio?.cliente?.nombre,
          r.mantenimiento_plan?.cliente?.nombre,
          r.emergencia?.cliente?.nombre,
          r.cobro?.cliente?.nombre
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(ql);
      });
    }

    res.json(paginarArray(list, req.query));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar recordatorios' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await prisma.tbl_recordatorios.findUnique({
      where: { id }, include: includeRel
    });
    if (!r || r.estado !== 1) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    if (!puedeAcceder(r, req.user)) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    res.json({ data: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener recordatorio' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.titulo || !d.fecha_recordatorio) {
      return res.status(400).json({ error: 'Título y fecha son obligatorios' });
    }
    if (fechaEnPasado(d.fecha_recordatorio)) {
      return res.status(400).json({ error: 'La fecha no puede ser anterior al momento actual' });
    }
    const tipo = d.tipo || 'manual';
    const r = await prisma.tbl_recordatorios.create({
      data: {
        titulo: d.titulo,
        descripcion: d.descripcion || null,
        tipo,
        origen: 'manual',
        fecha_recordatorio: parseDateTimeLocalLima(d.fecha_recordatorio),
        prioridad: d.prioridad || 'media',
        estado_recordatorio: 'pendiente',
        color: d.color || COLORES[tipo] || COLORES.manual,
        id_servicio: d.id_servicio ? Number(d.id_servicio) : null,
        id_mantenimiento_plan: d.id_mantenimiento_plan ? Number(d.id_mantenimiento_plan) : null,
        id_emergencia: d.id_emergencia ? Number(d.id_emergencia) : null,
        id_cobro: d.id_cobro ? Number(d.id_cobro) : null,
        user_id_registration: req.user.id
      },
      include: includeRel
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_recordatorios', id_entidad: r.id,
      accion: 'CREATE', valor_nuevo: r, ip: req.ip
    });
    res.json({ data: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear recordatorio' });
  }
};

// Carga un recordatorio y valida acceso antes de mutarlo. Devuelve el registro
// previo o null si el usuario no puede acceder (caller responde 404).
async function cargarSiAcceso(id, user) {
  const previo = await prisma.tbl_recordatorios.findUnique({ where: { id }, include: includeRel });
  if (!previo || previo.estado !== 1) return null;
  if (!puedeAcceder(previo, user)) return null;
  return previo;
}

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await cargarSiAcceso(id, req.user);
    if (!previo) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    if (d.fecha_recordatorio !== undefined && fechaEnPasado(d.fecha_recordatorio)) {
      return res.status(400).json({ error: 'La fecha no puede ser anterior al momento actual' });
    }

    // El proceso vinculado solo se puede cambiar en recordatorios manuales; los
    // 'auto' derivan su vínculo del proceso que los generó y no debe tocarse.
    const puedeVincular = previo.origen === 'manual';

    const r = await prisma.tbl_recordatorios.update({
      where: { id },
      data: {
        ...(d.titulo !== undefined && { titulo: d.titulo }),
        ...(d.descripcion !== undefined && { descripcion: d.descripcion }),
        ...(d.fecha_recordatorio !== undefined && { fecha_recordatorio: parseDateTimeLocalLima(d.fecha_recordatorio) }),
        ...(d.prioridad !== undefined && { prioridad: d.prioridad }),
        ...(d.color !== undefined && { color: d.color }),
        ...(d.notas_seguimiento !== undefined && { notas_seguimiento: d.notas_seguimiento }),
        ...(puedeVincular && d.id_servicio !== undefined && { id_servicio: d.id_servicio ? Number(d.id_servicio) : null }),
        ...(puedeVincular && d.id_mantenimiento_plan !== undefined && { id_mantenimiento_plan: d.id_mantenimiento_plan ? Number(d.id_mantenimiento_plan) : null }),
        ...(puedeVincular && d.id_emergencia !== undefined && { id_emergencia: d.id_emergencia ? Number(d.id_emergencia) : null }),
        ...(puedeVincular && d.id_cobro !== undefined && { id_cobro: d.id_cobro ? Number(d.id_cobro) : null }),
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      },
      include: includeRel
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_recordatorios', id_entidad: r.id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: r, ip: req.ip
    });
    res.json({ data: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar recordatorio' });
  }
};

const cambiarEstado = (nuevoEstado) => async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await cargarSiAcceso(id, req.user);
    if (!previo) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    const r = await prisma.tbl_recordatorios.update({
      where: { id },
      data: {
        estado_recordatorio: nuevoEstado,
        fecha_atendido: nuevoEstado === 'atendido' ? new Date() : null,
        atendido_por: nuevoEstado === 'atendido' ? req.user.id : null,
        ...(req.body?.notas_seguimiento !== undefined && { notas_seguimiento: req.body.notas_seguimiento }),
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      },
      include: includeRel
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_recordatorios', id_entidad: r.id,
      accion: `ESTADO_${nuevoEstado.toUpperCase()}`, valor_anterior: previo, valor_nuevo: r, ip: req.ip
    });
    res.json({ data: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await cargarSiAcceso(id, req.user);
    if (!previo) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    if (previo.origen === 'auto') {
      return res.status(400).json({ error: 'Los recordatorios automáticos no se eliminan; descártalos en su lugar' });
    }
    await prisma.tbl_recordatorios.update({
      where: { id },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_recordatorios', id_entidad: id,
      accion: 'DELETE', valor_anterior: previo, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar' });
  }
};

const contadores = async (req, res) => {
  try {
    const hoy = inicioDelDiaLima();
    const finHoy = finDelDiaLima();
    const visible = whereVisible(req.user);
    const [pendientes, vencidos, hoyCount, proximos7, noLeidos] = await Promise.all([
      prisma.tbl_recordatorios.count({ where: andWhere({ estado: 1, estado_recordatorio: 'pendiente' }, visible) }),
      prisma.tbl_recordatorios.count({ where: andWhere({ estado: 1, estado_recordatorio: 'pendiente', fecha_recordatorio: { lt: hoy } }, visible) }),
      prisma.tbl_recordatorios.count({ where: andWhere({ estado: 1, estado_recordatorio: 'pendiente', fecha_recordatorio: { gte: hoy, lte: finHoy } }, visible) }),
      prisma.tbl_recordatorios.count({
        where: andWhere({
          estado: 1, estado_recordatorio: 'pendiente',
          fecha_recordatorio: { gte: hoy, lte: new Date(hoy.getTime() + 7 * 86400000) }
        }, visible)
      }),
      prisma.tbl_recordatorios.count({ where: andWhere({ estado: 1, estado_recordatorio: 'pendiente', fecha_lectura: null }, visible) })
    ]);
    res.json({ data: { pendientes, vencidos, hoy: hoyCount, proximos7, no_leidos: noLeidos } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en contadores' });
  }
};

const marcarLeido = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await cargarSiAcceso(id, req.user);
    if (!previo) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    if (previo.fecha_lectura) return res.json({ data: previo });
    const r = await prisma.tbl_recordatorios.update({
      where: { id },
      data: {
        fecha_lectura: new Date(),
        leido_por: req.user.id,
        date_time_modification: new Date()
      }
    });
    res.json({ data: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar leído' });
  }
};

const marcarTodosLeidos = async (req, res) => {
  try {
    const where = andWhere(
      { estado: 1, estado_recordatorio: 'pendiente', fecha_lectura: null },
      whereVisible(req.user)
    );
    const r = await prisma.tbl_recordatorios.updateMany({
      where,
      data: { fecha_lectura: new Date(), leido_por: req.user.id, date_time_modification: new Date() }
    });
    res.json({ data: { actualizados: r.count } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar todos leídos' });
  }
};

const proximos = async (req, res) => {
  try {
    const limite = Math.min(Number(req.query.limit) || 10, 50);
    const hoy = inicioDelDiaLima();
    const where = andWhere({
      estado: 1, estado_recordatorio: 'pendiente',
      fecha_recordatorio: { gte: new Date(hoy.getTime() - 30 * 86400000) }
    }, whereVisible(req.user));
    const list = await prisma.tbl_recordatorios.findMany({
      where,
      include: includeRel,
      orderBy: { fecha_recordatorio: 'asc' },
      take: limite
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener próximos' });
  }
};

module.exports = {
  listar, obtener, crear, actualizar, eliminar,
  marcarAtendido: cambiarEstado('atendido'),
  marcarPendiente: cambiarEstado('pendiente'),
  descartar: cambiarEstado('descartado'),
  marcarLeido, marcarTodosLeidos,
  contadores, proximos
};

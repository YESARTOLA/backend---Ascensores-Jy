const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { parseYMDLima, parseYMDFinDiaLima, inicioDelDiaLima, finDelDiaLima, parseDateTimeLocalLima, inicioDelMinutoActual } = require('../utils/tiempo');
const { COLORES } = require('../utils/recordatoriosAuto');
const { paginarArray } = require('../utils/paginacion');
const {
  whereRecordatoriosVisibles,
  whereRecordatoriosEnviados,
  relacionConRecordatorio
} = require('../utils/visibilidadRecordatorios');
const { mapaUsuariosPorId } = require('../utils/resolverUsuarios');
const {
  puedeVerFinanzas, servicioSinPrecios, planMantenimientoSinFinanzas, omitir
} = require('../utils/visibilidadFinanzas');

/**
 * Un recordatorio arrastra el servicio, el plan, el cobro y la cuota completos.
 * Para los roles sin visibilidad financiera se entrega solo la parte operativa:
 * sin precio del servicio, sin monto por ascensor del plan y sin cobro ni cuota.
 */
function sanearRecordatorio(r, user) {
  if (!r || puedeVerFinanzas(user)) return r;
  return omitir({
    ...r,
    servicio: r.servicio ? servicioSinPrecios(r.servicio) : r.servicio,
    mantenimiento_plan: r.mantenimiento_plan
      ? planMantenimientoSinFinanzas(r.mantenimiento_plan, user)
      : r.mantenimiento_plan,
    // La emergencia vinculada arrastra a su vez el servicio, con su precio.
    emergencia: r.emergencia
      ? { ...r.emergencia, servicio: r.emergencia.servicio ? servicioSinPrecios(r.emergencia.servicio) : r.emergencia.servicio }
      : r.emergencia
  }, ['cobro', 'cuota']);
}

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
  cuota: true,
  usuario_destino: { select: { id: true, nombres: true } }
};

// Quién ve qué vive en utils/visibilidadRecordatorios.js (compartido con el
// Calendario). Aquí solo se elige la bandeja: la agenda propia o los
// registrados para otra persona.
function whereVisible(user, vista) {
  return vista === 'enviados' ? whereRecordatoriosEnviados(user) : whereRecordatoriosVisibles(user);
}

/**
 * Valida el dueño elegido para un recordatorio manual. Devuelve el id o lanza
 * un error con `status` 400 si no es un usuario activo.
 */
async function resolverDestino(valor, user) {
  if (valor === undefined || valor === null || valor === '') return user.id;
  const id = Number(valor);
  const destino = Number.isInteger(id)
    ? await prisma.tbl_usuarios.findFirst({ where: { id, estado: 1 }, select: { id: true } })
    : null;
  if (!destino) {
    const err = new Error('El usuario elegido no existe o está inactivo');
    err.status = 400;
    throw err;
  }
  return destino.id;
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

// Añade el nombre de quien registró cada recordatorio (`user_id_registration`
// no es una relación declarada, así que no se puede `include`).
async function conAutor(list) {
  const usuarios = await mapaUsuariosPorId(list.map(r => r.user_id_registration));
  return list.map(r => {
    const u = usuarios[r.user_id_registration];
    return { ...r, registrado_por: u ? { id: u.id, nombres: u.nombres } : null };
  });
}

const listar = async (req, res) => {
  try {
    const { tipo, estado_recordatorio, prioridad, id_cliente, desde, hasta, q, origen, vista } = req.query;
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

    const where = andWhere(filtros, whereVisible(req.user, vista));

    // El más reciente arriba: orden por fecha del recordatorio, descendente.
    let list = await prisma.tbl_recordatorios.findMany({
      where,
      include: includeRel,
      orderBy: [{ fecha_recordatorio: 'desc' }, { id: 'desc' }],
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
          r.cobro?.cliente?.nombre,
          r.usuario_destino?.nombres
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(ql);
      });
    }

    const resp = paginarArray(list.map(r => sanearRecordatorio(r, req.user)), req.query);
    // Solo se hidrata el autor de lo que se devuelve (la página, no las 500 filas).
    res.json({ ...resp, data: await conAutor(resp.data) });
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
    if (!relacionConRecordatorio(r, req.user)) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    const [conNombre] = await conAutor([sanearRecordatorio(r, req.user)]);
    res.json({ data: conNombre });
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
    // Dueño: quien lo registra, salvo que lo registre para otra persona.
    const idDestino = await resolverDestino(d.id_usuario_destino, req.user);
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
        id_usuario_destino: idDestino,
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
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error al crear recordatorio' });
  }
};

// Carga un recordatorio y valida acceso antes de mutarlo. Devuelve
// { previo, relacion } —relación del usuario con él: 'destinatario' | 'autor'—
// o null si el usuario no puede acceder (caller responde 404).
async function cargarSiAcceso(id, user) {
  const previo = await prisma.tbl_recordatorios.findUnique({ where: { id }, include: includeRel });
  if (!previo || previo.estado !== 1) return null;
  const relacion = relacionConRecordatorio(previo, user);
  return relacion ? { previo, relacion } : null;
}

// Atender, descartar, reactivar o leer un recordatorio con dueño le toca a su
// dueño: quien se lo registró a otra persona no puede cerrárselo.
const NO_ES_DESTINATARIO = 'Solo la persona a quien va dirigido el recordatorio puede cambiar su estado';

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const acceso = await cargarSiAcceso(id, req.user);
    if (!acceso) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    const { previo } = acceso;
    if (d.fecha_recordatorio !== undefined && fechaEnPasado(d.fecha_recordatorio)) {
      return res.status(400).json({ error: 'La fecha no puede ser anterior al momento actual' });
    }

    // El proceso vinculado solo se puede cambiar en recordatorios manuales; los
    // 'auto' derivan su vínculo del proceso que los generó y no debe tocarse.
    const puedeVincular = previo.origen === 'manual';
    // En los manuales también se puede pasar el recordatorio a otra persona.
    const idDestino = puedeVincular && d.id_usuario_destino !== undefined
      ? await resolverDestino(d.id_usuario_destino, req.user)
      : undefined;

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
        ...(idDestino !== undefined && { id_usuario_destino: idDestino }),
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
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar recordatorio' });
  }
};

const cambiarEstado = (nuevoEstado) => async (req, res) => {
  try {
    const id = Number(req.params.id);
    const acceso = await cargarSiAcceso(id, req.user);
    if (!acceso) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    const { previo, relacion } = acceso;
    if (relacion !== 'destinatario') return res.status(403).json({ error: NO_ES_DESTINATARIO });
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
    const acceso = await cargarSiAcceso(id, req.user);
    if (!acceso) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    const { previo } = acceso;
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
    const acceso = await cargarSiAcceso(id, req.user);
    if (!acceso) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    const { previo, relacion } = acceso;
    // Abrirlo desde «Registrados para otros» no cuenta como lectura del dueño.
    if (previo.fecha_lectura || relacion !== 'destinatario') return res.json({ data: previo });
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
    res.json({ data: list.map(r => sanearRecordatorio(r, req.user)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener próximos' });
  }
};

// Personas a quienes se puede registrar un recordatorio: todos los usuarios
// activos. Endpoint propio porque /usuarios/catalogo no está abierto a todos los
// roles y cualquiera puede dejarle un recordatorio a otro.
const destinatarios = async (_req, res) => {
  try {
    const list = await prisma.tbl_usuarios.findMany({
      where: { estado: 1 },
      select: { id: true, nombres: true, rol: { select: { codigo: true, nombre: true } } },
      orderBy: { nombres: 'asc' }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar destinatarios' });
  }
};

module.exports = {
  listar, obtener, crear, actualizar, eliminar, destinatarios,
  marcarAtendido: cambiarEstado('atendido'),
  marcarPendiente: cambiarEstado('pendiente'),
  descartar: cambiarEstado('descartado'),
  marcarLeido, marcarTodosLeidos,
  contadores, proximos
};

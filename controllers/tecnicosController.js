const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { paginar } = require('../utils/paginacion');
const { idTecnicoFiltro } = require('../utils/visibilidadCalendario');

/**
 * El TÉCNICO solo se ve a sí mismo en este módulo.
 *
 * El resto de la aplicación ya le acota todo a lo suyo (servicios, calendario,
 * emergencias, correctivos, mantenimientos…), pero este endpoint era la puerta
 * de atrás: el listado devuelve la ficha completa de la plantilla —nombre,
 * documento, teléfono y correo— y el detalle incluye TODAS las asignaciones
 * activas del técnico consultado, es decir la programación de un compañero.
 *
 * Se acota el alcance en vez de responder 403 a propósito: los formularios de
 * gestión piden esta lista junto a clientes y ascensores en un mismo
 * `Promise.all`, y un rechazo tumbaría también esas cargas. Devolviendo su
 * propia ficha, quien no deba ver la plantilla recibe una respuesta válida y
 * ninguna pantalla se queda a medias.
 *
 * `idTecnicoFiltro` es el mismo SSoT que usan calendario y mantenimientos:
 * devuelve null para los roles que ven todo, y el id del técnico (o -1 si el
 * usuario no tiene ficha vinculada) para los que solo ven lo suyo.
 */

const listar = async (req, res) => {
  try {
    const { q, estado_operativo } = req.query;
    const where = { estado: 1 };
    const idTec = idTecnicoFiltro(req.user);
    if (idTec !== null) where.id = idTec;
    if (q) where.OR = [
      { nombre: { contains: q, mode: 'insensitive' } },
      { documento: { contains: q, mode: 'insensitive' } },
      { telefono: { contains: q, mode: 'insensitive' } },
      { especialidades: { contains: q, mode: 'insensitive' } }
    ];
    if (estado_operativo) where.estado_operativo = estado_operativo;

    // paginar() devuelve { data } cuando no llega ?page= (los dropdowns que usan
    // tecnicosService.list() siguen recibiendo el arreglo completo) y el sobre
    // { data, total, page, pageSize, totalPages } cuando la vista pagina.
    const result = await paginar(
      prisma.tbl_tecnicos,
      {
        where, orderBy: { id: 'asc' },
        include: { usuario: { select: { id: true, correo: true } } }
      },
      req.query
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar técnicos' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Un técnico solo abre su propia ficha: la de otro traería su agenda
    // completa. 404 y no 403, igual que en el detalle de servicios, para no
    // confirmar qué fichas existen.
    const idTec = idTecnicoFiltro(req.user);
    if (idTec !== null && id !== idTec) {
      return res.status(404).json({ error: 'Técnico no encontrado' });
    }
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

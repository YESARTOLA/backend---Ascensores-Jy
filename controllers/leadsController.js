const prisma = require('../config/prisma');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima } = require('../utils/tiempo');

const listar = async (req, res) => {
  try {
    const result = await paginar(
      prisma.tbl_leads,
      {
        where: { estado: 1 },
        orderBy: { id: 'desc' },
        include: {
          cliente: true,
          tipo_servicio: true,
          usuario_registrador: { select: { id: true, nombres: true } }
        }
      },
      req.query
    );

    // Resolver el nombre amigable del rol histórico desde tbl_roles para no
    // hardcodear etiquetas en el frontend.
    const codigosRol = [...new Set(
      result.data.map(l => l.rol_codigo_registrador).filter(Boolean)
    )];
    const rolesMap = codigosRol.length === 0
      ? new Map()
      : new Map((await prisma.tbl_roles.findMany({
          where: { codigo: { in: codigosRol } },
          select: { codigo: true, nombre: true }
        })).map(r => [r.codigo, r.nombre]));

    const data = result.data.map(l => ({
      ...l,
      rol_nombre_registrador: l.rol_codigo_registrador ? (rolesMap.get(l.rol_codigo_registrador) || l.rol_codigo_registrador) : null
    }));
    res.json({ ...result, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar leads' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.nombre_contacto || !d.telefono) {
      return res.status(400).json({ error: 'Nombre y teléfono son obligatorios' });
    }
    const lead = await prisma.tbl_leads.create({
      data: {
        nombre_contacto: d.nombre_contacto,
        telefono: d.telefono,
        canal: d.canal || null,
        id_tipo_servicio_solicitado: d.id_tipo_servicio_solicitado ? Number(d.id_tipo_servicio_solicitado) : null,
        cliente_existente: d.cliente_existente ? 1 : 0,
        id_cliente: d.id_cliente ? Number(d.id_cliente) : null,
        estado_lead: 'nuevo',
        observaciones: d.observaciones || null,
        user_id_registration: req.user.id,
        rol_codigo_registrador: req.user.rol_codigo || null
      }
    });
    res.status(201).json({ data: lead });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear lead' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const lead = await prisma.tbl_leads.update({
      where: { id },
      data: {
        nombre_contacto: d.nombre_contacto,
        telefono: d.telefono,
        canal: d.canal,
        id_tipo_servicio_solicitado: d.id_tipo_servicio_solicitado ? Number(d.id_tipo_servicio_solicitado) : null,
        cliente_existente: d.cliente_existente ? 1 : 0,
        id_cliente: d.id_cliente ? Number(d.id_cliente) : null,
        estado_lead: d.estado_lead,
        observaciones: d.observaciones,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    res.json({ data: lead });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar' });
  }
};

const convertir = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const lead = await prisma.tbl_leads.findUnique({ where: { id } });
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
    if (!d.id_cliente || !d.id_ascensor || !d.id_tipo_servicio || !d.fecha_programada || d.precio_interno === undefined) {
      return res.status(400).json({ error: 'Faltan datos para convertir (cliente, ascensor, tipo, fecha, precio)' });
    }

    const codigo = await generarCodigoServicio();
    const servicio = await prisma.tbl_servicios_proyectos.create({
      data: {
        codigo,
        tipo_registro: d.tipo_registro || 'servicio',
        id_tipo_servicio: Number(d.id_tipo_servicio),
        id_cliente: Number(d.id_cliente),
        id_ascensor: Number(d.id_ascensor),
        origen: 'lead',
        titulo: d.titulo || `Servicio desde lead ${lead.nombre_contacto}`,
        descripcion: d.descripcion || lead.observaciones,
        fecha_programada: parseYMDLima(d.fecha_programada),
        hora_programada: d.hora_programada || null,
        prioridad: d.prioridad || 'media',
        precio_interno: d.precio_interno,
        moneda: d.moneda || 'PEN',
        observaciones: d.observaciones || null,
        user_id_registration: req.user.id
      }
    });

    await prisma.tbl_leads.update({
      where: { id },
      data: {
        estado_lead: 'convertido',
        id_servicio_convertido: servicio.id,
        id_cliente: Number(d.id_cliente),
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    res.json({ data: { servicio, lead_id: id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al convertir lead: ' + err.message });
  }
};

module.exports = { listar, crear, actualizar, convertir };

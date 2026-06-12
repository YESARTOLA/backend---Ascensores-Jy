const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima } = require('../utils/tiempo');
const {
  aplicaAlcance,
  tiposRegistroPermitidos,
  servicioAlcanceWhere,
  ascensorAlcanceWhere,
} = require('../utils/alcanceUsuario');

// Datos del edificio (y su cliente) que la UI muestra junto al ascensor.
const INCLUDE_EDIFICIO = {
  edificio: {
    select: {
      id: true, nombre: true, tipo: true, distrito: true, direccion: true, latitud: true, longitud: true,
      cliente: { select: { id: true, nombre: true, telefono: true, whatsapp: true } }
    }
  }
};

const listar = async (req, res) => {
  try {
    const { q, id_cliente, id_edificio, estado_operativo } = req.query;
    const where = { estado: 1 };
    if (q) {
      where.OR = [
        { codigo: { contains: q, mode: 'insensitive' } },
        { ubicacion: { contains: q, mode: 'insensitive' } },
        { marca: { contains: q, mode: 'insensitive' } },
        { edificio: { is: { nombre: { contains: q, mode: 'insensitive' } } } },
        { edificio: { is: { cliente: { is: { nombre: { contains: q, mode: 'insensitive' } } } } } }
      ];
    }
    // El ascensor pertenece a un edificio; el filtro por cliente se resuelve a
    // través del edificio.
    if (id_edificio) where.id_edificio = Number(id_edificio);
    else if (id_cliente) where.edificio = { is: { id_cliente: Number(id_cliente) } };
    if (estado_operativo) where.estado_operativo = estado_operativo;

    // Ámbito del usuario: solo ascensores de clientes dentro del ámbito. Se aplica
    // vía AND para no pisar el filtro por edificio/cliente de arriba.
    const alcance = ascensorAlcanceWhere(req.user);
    if (Object.keys(alcance).length) where.AND = [...(where.AND || []), alcance];

    const result = await paginar(
      prisma.tbl_ascensores,
      { where, orderBy: { id: 'desc' }, include: INCLUDE_EDIFICIO },
      req.query
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar ascensores' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (aplicaAlcance(req.user)) {
      const enAmbito = await prisma.tbl_ascensores.findFirst({
        where: { id, ...ascensorAlcanceWhere(req.user) }, select: { id: true }
      });
      if (!enAmbito) return res.status(404).json({ error: 'Ascensor no encontrado' });
    }
    const ascensor = await prisma.tbl_ascensores.findUnique({
      where: { id },
      include: { edificio: { include: { cliente: true } } }
    });
    if (!ascensor) return res.status(404).json({ error: 'Ascensor no encontrado' });
    res.json({ data: ascensor });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener ascensor' });
  }
};

const historial = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (aplicaAlcance(req.user)) {
      const enAmbito = await prisma.tbl_ascensores.findFirst({
        where: { id, ...ascensorAlcanceWhere(req.user) }, select: { id: true }
      });
      if (!enAmbito) return res.status(404).json({ error: 'Ascensor no encontrado' });
    }
    const tipos = tiposRegistroPermitidos(req.user);
    const [ascensor, servicios, emergencias, mantenimientos, eventosHist] = await Promise.all([
      prisma.tbl_ascensores.findUnique({ where: { id }, include: { edificio: { include: { cliente: true } } } }),
      prisma.tbl_servicios_proyectos.findMany({
        where: { ascensores: { some: { id_ascensor: id, estado: 1 } }, estado: 1, ...servicioAlcanceWhere(req.user) },
        orderBy: { id: 'desc' },
        include: {
          tipo_servicio: true,
          ascensores: { where: { estado: 1 }, include: { ascensor: { select: { id: true, codigo: true, ubicacion: true } } } },
          asignaciones: { include: { tecnico: true }, where: { estado: 1 } },
          guias: { include: { archivo: true, tecnico: true } },
          evidencias: { include: { archivo: true, tecnico: true } }
        }
      }),
      prisma.tbl_emergencias.findMany({
        where: { id_ascensor: id, estado: 1 },
        orderBy: { fecha_reporte: 'desc' },
        include: { servicio: { select: { codigo: true } } }
      }),
      prisma.tbl_mantenimientos_planes.findMany({
        where: { id_ascensor: id, estado: 1 },
        include: { tipo_servicio: true }
      }),
      prisma.tbl_ascensores_historial.findMany({ where: { id_ascensor: id }, orderBy: { fecha_evento: 'desc' }, take: 200 })
    ]);
    if (!ascensor) return res.status(404).json({ error: 'Ascensor no encontrado' });

    const idsServicios = servicios.map(s => s.id);
    const [entregas, facturas, guias, evidencias] = idsServicios.length === 0
      ? [[], [], [], []]
      : await Promise.all([
        prisma.tbl_entregas.findMany({
          where: { id_servicio: { in: idsServicios }, estado: 1 },
          orderBy: { fecha_entrega: 'desc' },
          include: { archivo: true, servicio: { select: { codigo: true } } }
        }),
        prisma.tbl_facturas.findMany({
          where: { id_servicio: { in: idsServicios }, estado: 1 },
          orderBy: { id: 'desc' },
          include: { archivo: true, servicio: { select: { codigo: true } } }
        }),
        prisma.tbl_servicios_guias.findMany({
          where: { id_servicio: { in: idsServicios }, estado: 1 },
          orderBy: { fecha_carga: 'desc' },
          include: { archivo: true, tecnico: true, servicio: { select: { codigo: true } } }
        }),
        prisma.tbl_servicios_evidencias.findMany({
          where: { id_servicio: { in: idsServicios }, estado: 1 },
          orderBy: { fecha_carga: 'desc' },
          include: { archivo: true, tecnico: true, servicio: { select: { codigo: true } } }
        })
      ]);

    // Emergencias y mantenimientos son dominio de Servicios: se ocultan a un
    // usuario cuyo ámbito sea solo Proyectos.
    const soloProyectos = tipos && !tipos.includes('servicio');
    res.json({
      data: {
        ascensor,
        servicios,
        emergencias: soloProyectos ? [] : emergencias,
        mantenimientos: soloProyectos ? [] : mantenimientos,
        entregas,
        facturas,
        guias,
        evidencias,
        historial: eventosHist
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en historial del ascensor' });
  }
};

const crear = async (req, res) => {
  try {
    const data = req.body;
    if (!data.id_edificio || !data.codigo) {
      return res.status(400).json({ error: 'Edificio y código son obligatorios' });
    }
    const edificio = await prisma.tbl_edificios.findUnique({ where: { id: Number(data.id_edificio) } });
    if (!edificio || edificio.estado !== 1) return res.status(400).json({ error: 'Edificio no encontrado' });
    const existente = await prisma.tbl_ascensores.findUnique({ where: { codigo: data.codigo } });
    if (existente) return res.status(400).json({ error: 'Código de ascensor duplicado' });

    const ascensor = await prisma.tbl_ascensores.create({
      data: {
        id_edificio: Number(data.id_edificio),
        codigo: data.codigo,
        ubicacion: data.ubicacion || null,
        tipo: data.tipo || null,
        marca: data.marca || null,
        modelo: data.modelo || null,
        capacidad: data.capacidad || null,
        pisos: data.pisos ? Number(data.pisos) : null,
        anio_aproximado: data.anio_aproximado ? Number(data.anio_aproximado) : null,
        estado_operativo: data.estado_operativo || 'Operativo',
        fecha_instalacion: data.fecha_instalacion ? parseYMDLima(data.fecha_instalacion) : null,
        proximo_mantenimiento: data.proximo_mantenimiento ? parseYMDLima(data.proximo_mantenimiento) : null,
        observaciones: data.observaciones || null,
        user_id_registration: req.user.id
      }
    });
    await prisma.tbl_ascensores_historial.create({
      data: {
        id_ascensor: ascensor.id,
        tipo_evento: 'creacion',
        descripcion: `Ascensor ${ascensor.codigo} registrado`,
        creado_por: req.user.id
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_ascensores', id_entidad: ascensor.id,
      accion: 'CREATE', valor_nuevo: ascensor, ip: req.ip
    });
    res.status(201).json({ data: ascensor });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear ascensor' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body;
    const previo = await prisma.tbl_ascensores.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Ascensor no encontrado' });

    if (data.codigo && data.codigo !== previo.codigo) {
      const dup = await prisma.tbl_ascensores.findUnique({ where: { codigo: data.codigo } });
      if (dup) return res.status(400).json({ error: 'Código duplicado' });
    }

    const ascensor = await prisma.tbl_ascensores.update({
      where: { id },
      data: {
        id_edificio: data.id_edificio ? Number(data.id_edificio) : previo.id_edificio,
        codigo: data.codigo ?? previo.codigo,
        ubicacion: data.ubicacion ?? previo.ubicacion,
        tipo: data.tipo ?? previo.tipo,
        marca: data.marca ?? previo.marca,
        modelo: data.modelo ?? previo.modelo,
        capacidad: data.capacidad ?? previo.capacidad,
        pisos: data.pisos !== undefined ? Number(data.pisos) : previo.pisos,
        anio_aproximado: data.anio_aproximado !== undefined ? Number(data.anio_aproximado) : previo.anio_aproximado,
        estado_operativo: data.estado_operativo ?? previo.estado_operativo,
        fecha_instalacion: data.fecha_instalacion ? parseYMDLima(data.fecha_instalacion) : previo.fecha_instalacion,
        proximo_mantenimiento: data.proximo_mantenimiento ? parseYMDLima(data.proximo_mantenimiento) : previo.proximo_mantenimiento,
        observaciones: data.observaciones ?? previo.observaciones,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_ascensores', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: ascensor, ip: req.ip
    });
    res.json({ data: ascensor });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar ascensor' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    const previo = await prisma.tbl_ascensores.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Ascensor no encontrado' });
    const ascensor = await prisma.tbl_ascensores.update({
      where: { id },
      data: { estado: Number(estado), user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_ascensores', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado: Number(estado) }, ip: req.ip
    });
    res.json({ data: ascensor });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

module.exports = { listar, obtener, historial, crear, actualizar, cambiarEstado };

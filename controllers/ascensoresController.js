const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima } = require('../utils/tiempo');
const { bajaAscensorCascadaEnTx } = require('../utils/bajaAscensorCascada');
const { purgarObjetosWasabi, liberarTecnicos } = require('../utils/reversionEliminacion');
const { MONEDAS_CODIGOS, MONEDA_POR_DEFECTO } = require('../utils/catalogosBancarios');
const {
  aplicaAlcance,
  aplicaAlcanceEdificio,
  tiposRegistroPermitidos,
  servicioAlcanceWhere,
  ascensorAlcanceWhere,
  ascensorEdificioAlcanceWhere,
  conAlcance,
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

// Catálogo de precios por subtipo de servicio del ascensor. Lo consumen los
// formularios de plan/servicio para conocer el precio de cada ascensor.
const INCLUDE_PRECIOS = { where: { estado: 1 }, orderBy: { id: 'asc' } };

/**
 * Reemplaza el catálogo de precios del ascensor: da de baja (estado 0) los
 * subtipos que ya no vienen en el payload y hace upsert de los que sí. Idempotente.
 *
 * OJO: es un reemplazo TOTAL del catálogo del ascensor. Para tocar un solo
 * subtipo sin afectar al resto está `guardarPrecio`.
 */
async function reemplazarPreciosAscensor(tx, idAscensor, payload, idUsuario) {
  if (!Array.isArray(payload)) return;
  const limpios = [];
  for (const p of payload) {
    const idTipo = p && p.id_tipo_servicio ? Number(p.id_tipo_servicio) : null;
    const rawPrecio = p && p.precio !== undefined && p.precio !== null && p.precio !== '' ? Number(p.precio) : null;
    if (!idTipo || !Number.isFinite(rawPrecio) || rawPrecio < 0) continue;
    limpios.push({ id_tipo_servicio: idTipo, precio: rawPrecio, moneda: p.moneda || MONEDA_POR_DEFECTO });
  }
  const tiposActuales = limpios.map(l => l.id_tipo_servicio);
  await tx.tbl_ascensores_precios.updateMany({
    where: {
      id_ascensor: idAscensor,
      estado: 1,
      ...(tiposActuales.length > 0 ? { id_tipo_servicio: { notIn: tiposActuales } } : {})
    },
    data: { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() }
  });
  for (const l of limpios) {
    await tx.tbl_ascensores_precios.upsert({
      where: { id_ascensor_id_tipo_servicio: { id_ascensor: idAscensor, id_tipo_servicio: l.id_tipo_servicio } },
      create: {
        id_ascensor: idAscensor,
        id_tipo_servicio: l.id_tipo_servicio,
        precio: l.precio,
        moneda: l.moneda,
        user_id_registration: idUsuario
      },
      update: {
        precio: l.precio,
        moneda: l.moneda,
        estado: 1,
        user_id_modification: idUsuario,
        date_time_modification: new Date()
      }
    });
  }
}

const listar = async (req, res) => {
  try {
    const { q, id_cliente, id_edificio, estado_operativo, tipo, sort, dir } = req.query;
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
    if (tipo) where.tipo = tipo;

    // Ámbito del usuario: solo ascensores de clientes dentro del ámbito. Se aplica
    // vía AND para no pisar el filtro por edificio/cliente de arriba.
    conAlcance(where, ascensorAlcanceWhere(req.user));
    // Alcance por tipo de edificio (Administrador acotado a Edificios u Obras).
    conAlcance(where, ascensorEdificioAlcanceWhere(req.user));

    // Ordenamiento por columna (cabeceras clickables del listado). Campo permitido
    // + dirección; si no viene, orden por defecto (más recientes primero).
    const direccion = dir === 'asc' ? 'asc' : 'desc';
    const ORDEN = {
      codigo: { codigo: direccion },
      edificio: { edificio: { nombre: direccion } },
      tipo: { tipo: direccion },
      ubicacion: { ubicacion: direccion },
      estado: { estado_operativo: direccion },
      proximo_mantenimiento: { proximo_mantenimiento: direccion }
    };
    const orderBy = ORDEN[sort] || { id: 'desc' };

    const result = await paginar(
      prisma.tbl_ascensores,
      { where, orderBy, include: { ...INCLUDE_EDIFICIO, precios: INCLUDE_PRECIOS } },
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
    if (aplicaAlcance(req.user) || aplicaAlcanceEdificio(req.user)) {
      const w = { id };
      conAlcance(w, ascensorAlcanceWhere(req.user));
      conAlcance(w, ascensorEdificioAlcanceWhere(req.user));
      const enAmbito = await prisma.tbl_ascensores.findFirst({ where: w, select: { id: true } });
      if (!enAmbito) return res.status(404).json({ error: 'Ascensor no encontrado' });
    }
    const ascensor = await prisma.tbl_ascensores.findUnique({
      where: { id },
      include: { edificio: { include: { cliente: true } }, precios: INCLUDE_PRECIOS }
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
    if (aplicaAlcance(req.user) || aplicaAlcanceEdificio(req.user)) {
      const w = { id };
      conAlcance(w, ascensorAlcanceWhere(req.user));
      conAlcance(w, ascensorEdificioAlcanceWhere(req.user));
      const enAmbito = await prisma.tbl_ascensores.findFirst({ where: w, select: { id: true } });
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
        where: { estado: 1, ascensores: { some: { id_ascensor: id, estado: 1 } } },
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

    const ascensor = await prisma.$transaction(async (tx) => {
      const creado = await tx.tbl_ascensores.create({
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
          // 'Inactivo' es baja lógica: nace con estado = 0.
          estado: (data.estado_operativo || 'Operativo') === 'Inactivo' ? 0 : 1,
          fecha_instalacion: data.fecha_instalacion ? parseYMDLima(data.fecha_instalacion) : null,
          proximo_mantenimiento: data.proximo_mantenimiento ? parseYMDLima(data.proximo_mantenimiento) : null,
          observaciones: data.observaciones || null,
          user_id_registration: req.user.id
        }
      });
      await reemplazarPreciosAscensor(tx, creado.id, data.precios, req.user.id);
      return creado;
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

    // El estado_operativo 'Inactivo' es la baja lógica del ascensor: implica
    // estado = 0 (desaparece de listados y de la selección de servicios/planes),
    // pero sigue visible en la vista 360 del cliente. Cualquier otro estado
    // operativo lo mantiene/lo reactiva (estado = 1). Al pasar a inactivo se
    // corren los efectos en cascada sobre sus planes (baja lógica recuperable).
    const estadoOperativoFinal = data.estado_operativo ?? previo.estado_operativo;
    const nuevoEstado = estadoOperativoFinal === 'Inactivo' ? 0 : 1;
    const pasaAInactivo = nuevoEstado === 0 && previo.estado === 1;

    // Si el edificio / obra del ascensor está inactivo, el ascensor solo puede
    // quedar 'Inactivo': no se reactiva ni opera dentro de un edificio dado de baja.
    const idEdificioFinal = data.id_edificio ? Number(data.id_edificio) : previo.id_edificio;
    const edificioDestino = await prisma.tbl_edificios.findUnique({ where: { id: idEdificioFinal } });
    if (edificioDestino && edificioDestino.estado === 0 && estadoOperativoFinal !== 'Inactivo') {
      return res.status(400).json({ error: 'El edificio / obra está inactivo: el ascensor solo puede quedar en estado Inactivo.' });
    }

    const wasabiKeys = [];
    const tecnicoIds = [];
    const ascensor = await prisma.$transaction(async (tx) => {
      await tx.tbl_ascensores.update({
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
          estado_operativo: estadoOperativoFinal,
          // Si pasa a inactivo, la baja (estado = 0) y la cascada de planes las
          // hace bajaAscensorCascadaEnTx, que necesita ver estado = 1 para actuar;
          // por eso aquí no se toca todavía. En los demás casos se alinea directo.
          estado: pasaAInactivo ? previo.estado : nuevoEstado,
          fecha_instalacion: data.fecha_instalacion ? parseYMDLima(data.fecha_instalacion) : previo.fecha_instalacion,
          proximo_mantenimiento: data.proximo_mantenimiento ? parseYMDLima(data.proximo_mantenimiento) : previo.proximo_mantenimiento,
          observaciones: data.observaciones ?? previo.observaciones,
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });
      // Solo se toca el catálogo si el payload trae `precios` (el form lo envía);
      // otros orígenes que no lo mandan no borran los precios existentes.
      if (data.precios !== undefined) {
        await reemplazarPreciosAscensor(tx, id, data.precios, req.user.id);
      }
      if (pasaAInactivo) {
        const r = await bajaAscensorCascadaEnTx(tx, id, req.user.id, req.ip);
        wasabiKeys.push(...r.wasabiKeys);
        tecnicoIds.push(...r.tecnicoIds);
      }
      return tx.tbl_ascensores.findUnique({ where: { id } });
    }, { timeout: 30000 });
    await purgarObjetosWasabi(wasabiKeys);
    await liberarTecnicos(tecnicoIds, -1);
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

/**
 * Alta/edición del precio de UN subtipo de servicio en UN ascensor, sin tocar
 * los demás subtipos del mismo ascensor.
 *
 * Existe aparte de `actualizar` a propósito: `reemplazarPreciosAscensor` da de
 * baja todo subtipo ausente del payload, así que reutilizar PUT /ascensores/:id
 * para guardar un solo precio borraría el resto del catálogo del ascensor. Lo
 * consume la edición inline del modal de plan de mantenimiento.
 */
const guardarPrecio = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const idTipoServicio = Number(req.body?.id_tipo_servicio);
    const precio = req.body?.precio === '' || req.body?.precio == null ? NaN : Number(req.body.precio);
    const moneda = req.body?.moneda || MONEDA_POR_DEFECTO;

    if (!Number.isFinite(precio) || precio < 0) {
      return res.status(400).json({ error: 'El precio debe ser un número mayor o igual a 0' });
    }
    if (!MONEDAS_CODIGOS.includes(moneda)) {
      return res.status(400).json({ error: `Moneda inválida. Valores permitidos: ${MONEDAS_CODIGOS.join(', ')}` });
    }

    const ascensor = await prisma.tbl_ascensores.findFirst({ where: { id, estado: 1 } });
    if (!ascensor) return res.status(404).json({ error: 'Ascensor no encontrado' });

    // Solo los SUBTIPOS son cotizables; un tipo padre (id_padre null) no lleva precio.
    const tipo = await prisma.tbl_tipos_servicio.findFirst({ where: { id: idTipoServicio, estado: 1 } });
    if (!tipo) return res.status(404).json({ error: 'Subtipo de servicio no encontrado' });
    if (tipo.id_padre == null) {
      return res.status(400).json({ error: 'Solo se puede configurar precio sobre un subtipo de servicio' });
    }

    const previo = await prisma.tbl_ascensores_precios.findUnique({
      where: { id_ascensor_id_tipo_servicio: { id_ascensor: id, id_tipo_servicio: idTipoServicio } }
    });
    const guardado = await prisma.tbl_ascensores_precios.upsert({
      where: { id_ascensor_id_tipo_servicio: { id_ascensor: id, id_tipo_servicio: idTipoServicio } },
      create: {
        id_ascensor: id,
        id_tipo_servicio: idTipoServicio,
        precio,
        moneda,
        user_id_registration: req.user.id
      },
      update: {
        precio,
        moneda,
        estado: 1,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_ascensores_precios', id_entidad: guardado.id,
      accion: previo ? 'UPDATE' : 'INSERT', valor_anterior: previo, valor_nuevo: guardado, ip: req.ip
    });

    // Se devuelve el catálogo completo y vigente del ascensor para que la UI
    // reemplace `ascensor.precios` sin tener que recargar todo el listado.
    const precios = await prisma.tbl_ascensores_precios.findMany({
      where: { id_ascensor: id, ...INCLUDE_PRECIOS.where },
      orderBy: INCLUDE_PRECIOS.orderBy
    });
    res.json({ data: { id_ascensor: id, precios } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el precio del ascensor' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const estado = Number(req.body.estado);
    // Baja/alta lógica: el ascensor nunca se borra, solo alterna `estado`.
    if (estado !== 0 && estado !== 1) {
      return res.status(400).json({ error: 'Estado inválido: use 0 (desactivar) o 1 (reactivar)' });
    }
    const previo = await prisma.tbl_ascensores.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Ascensor no encontrado' });

    // Desactivar arrastra sus planes de mantenimiento (baja lógica, conservando
    // el historial ejecutado/cobrado). Reactivar solo reabre el ascensor: los
    // planes cancelados no se resucitan automáticamente.
    if (estado === 0) {
      const { wasabiKeys, tecnicoIds } = await prisma.$transaction(
        tx => bajaAscensorCascadaEnTx(tx, id, req.user.id, req.ip),
        { timeout: 30000 }
      );
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_ascensores', id_entidad: id,
        accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado }, ip: req.ip
      });
      await purgarObjetosWasabi(wasabiKeys);
      await liberarTecnicos(tecnicoIds, -1);
      const ascensor = await prisma.tbl_ascensores.findUnique({ where: { id } });
      return res.json({ data: ascensor });
    }

    const ascensor = await prisma.tbl_ascensores.update({
      where: { id },
      data: { estado, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_ascensores', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado }, ip: req.ip
    });
    res.json({ data: ascensor });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

module.exports = { listar, obtener, historial, crear, actualizar, guardarPrecio, cambiarEstado };

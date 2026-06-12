const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { paginar } = require('../utils/paginacion');
const configuracion = require('../utils/configuracion');
const { parseYMDLima, inicioDelDiaLima, ymdLima } = require('../utils/tiempo');
const { CLASIFICACIONES, CLASIFICACIONES_CODIGOS } = require('../utils/catalogosClientes');
const {
  aplicaAlcance,
  tiposRegistroPermitidos,
  clienteAlcanceWhere,
} = require('../utils/alcanceUsuario');

const normalizarClasificacion = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  return CLASIFICACIONES_CODIGOS.includes(s) ? s : null;
};

const parseFechaContrato = (valor) => {
  if (valor === undefined || valor === null || valor === '') return null;
  // Anclar a Lima TZ — `new Date("YYYY-MM-DD")` daría midnight UTC y se
  // desplazaría un día al serializarse a @db.Date en servidores no-UTC.
  const fecha = parseYMDLima(valor);
  if (!fecha || isNaN(fecha.getTime())) return undefined;
  return fecha;
};

const CAMPOS_CONTACTOS = [
  'contacto_principal_nombre', 'contacto_principal_correo', 'contacto_principal_telefono',
  'contacto_cobranzas_nombre', 'contacto_cobranzas_correo', 'contacto_cobranzas_telefono',
  'contacto_admin_nombre', 'contacto_admin_correo', 'contacto_admin_telefono'
];

const trimOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

/**
 * Toma `data.archivos: [{ id_archivo, descripcion?, orden? }]` y reemplaza
 * los adjuntos del cliente. Idempotente: si no se envía el campo no toca nada.
 */
async function reemplazarArchivosCliente(tx, idCliente, payload, idUsuario) {
  if (!Array.isArray(payload)) return;
  await tx.tbl_clientes_archivos.deleteMany({ where: { id_cliente: idCliente } });
  const limpios = payload
    .map((a, i) => ({
      id_archivo: a && a.id_archivo ? Number(a.id_archivo) : null,
      descripcion: trimOrNull(a?.descripcion),
      orden: Number.isFinite(Number(a?.orden)) ? Number(a.orden) : i + 1
    }))
    .filter(a => a.id_archivo);
  for (const a of limpios) {
    await tx.tbl_clientes_archivos.create({
      data: {
        id_cliente: idCliente,
        id_archivo: a.id_archivo,
        descripcion: a.descripcion,
        orden: a.orden,
        user_id_registration: idUsuario
      }
    });
  }
}

const INCLUDE_ARCHIVOS = {
  where: { estado: 1 },
  orderBy: { orden: 'asc' },
  include: { archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true, tamano_bytes: true, fecha_subida: true } } }
};

const INCLUDE_PRECIOS = {
  where: { estado: 1 },
  include: { tipo_servicio: { select: { id: true, nombre: true } } },
  orderBy: { id: 'asc' }
};

// Edificios activos del cliente (con su conteo de ascensores). Reemplaza la
// antigua relación directa cliente→ascensores en el detalle y la vista 360.
const INCLUDE_EDIFICIOS = {
  where: { estado: 1 },
  orderBy: { id: 'desc' },
  include: {
    ascensores: { where: { estado: 1 } },
    _count: { select: { ascensores: true } }
  }
};

/**
 * `payload` = `[{ id_tipo_servicio, precio, moneda }]`. Upsert por par
 * (id_cliente, id_tipo_servicio). Soft-delete (estado=0) las filas que ya no
 * vienen en el payload. Idempotente.
 */
async function reemplazarPreciosCliente(tx, idCliente, payload, idUsuario) {
  if (!Array.isArray(payload)) return;
  const limpios = [];
  for (const p of payload) {
    const idTipo = p && p.id_tipo_servicio ? Number(p.id_tipo_servicio) : null;
    const rawPrecio = p && p.precio !== undefined && p.precio !== null && p.precio !== '' ? Number(p.precio) : null;
    if (!idTipo || !Number.isFinite(rawPrecio) || rawPrecio < 0) continue;
    limpios.push({ id_tipo_servicio: idTipo, precio: rawPrecio, moneda: p.moneda || 'PEN' });
  }
  const tiposActuales = limpios.map(l => l.id_tipo_servicio);
  await tx.tbl_clientes_precios.updateMany({
    where: {
      id_cliente: idCliente,
      estado: 1,
      ...(tiposActuales.length > 0 ? { id_tipo_servicio: { notIn: tiposActuales } } : {})
    },
    data: { estado: 0, user_id_modification: idUsuario, date_time_modification: new Date() }
  });
  for (const l of limpios) {
    await tx.tbl_clientes_precios.upsert({
      where: { id_cliente_id_tipo_servicio: { id_cliente: idCliente, id_tipo_servicio: l.id_tipo_servicio } },
      create: {
        id_cliente: idCliente,
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

/**
 * Construye el `where` Prisma para tbl_clientes a partir de los filtros de querystring.
 * Centralizado para que listar() y exportar() apliquen exactamente los mismos criterios.
 *
 * La ubicación física vive ahora en los edificios del cliente, así que los
 * filtros por distrito y por tipo de ascensor se resuelven a través de la
 * relación `edificios`.
 *
 * Filtros soportados:
 *   q                — texto libre sobre nombre / nº documento / teléfono / nombre de edificio
 *   distrito         — clientes con algún edificio en ese distrito
 *   tipo_ascensor    — clientes con algún edificio que tenga un ascensor de ese tipo
 *   clasificacion    — match exacto
 *   estado           — 0 | 1 (activo/inactivo)
 *   estado_contrato  — vigente | por_vencer | vencido | sin_contrato
 *   con_contrato     — '1' | '0' filtra si tiene archivo de contrato adjunto
 *
 * `user` aplica el ámbito (Servicios/Proyectos): si el rol está acotado, solo
 * devuelve clientes con al menos un registro del ámbito permitido.
 */
async function construirWhereClientes(query, user) {
  const { q, distrito, tipo_ascensor, clasificacion, estado, estado_contrato, con_contrato } = query;
  const where = { estado: 1 };
  if (q) {
    where.OR = [
      { nombre: { contains: q, mode: 'insensitive' } },
      { numero_documento: { contains: q, mode: 'insensitive' } },
      { telefono: { contains: q, mode: 'insensitive' } },
      { edificios: { some: { estado: 1, nombre: { contains: q, mode: 'insensitive' } } } }
    ];
  }
  const edificioFilter = {};
  if (distrito) edificioFilter.distrito = distrito;
  if (tipo_ascensor) edificioFilter.ascensores = { some: { tipo: tipo_ascensor, estado: 1 } };
  if (Object.keys(edificioFilter).length > 0) {
    where.edificios = { some: { estado: 1, ...edificioFilter } };
  }
  if (clasificacion && CLASIFICACIONES_CODIGOS.includes(clasificacion)) {
    where.clasificacion = clasificacion;
  }
  if (estado === '0' || estado === '1') where.estado = Number(estado);

  if (estado_contrato) {
    const diasAviso = await configuracion.obtener('CLIENTES_DIAS_AVISO_VENCIMIENTO_CONTRATO');
    const hoy = inicioDelDiaLima();
    const proximo = new Date(hoy.getTime() + Number(diasAviso || 30) * 86400000);
    if (estado_contrato === 'vigente') {
      where.contrato_inicio = { lte: hoy };
      where.contrato_fin = { gte: hoy };
    } else if (estado_contrato === 'por_vencer') {
      where.contrato_fin = { gte: hoy, lte: proximo };
    } else if (estado_contrato === 'vencido') {
      where.contrato_fin = { lt: hoy };
    } else if (estado_contrato === 'sin_contrato') {
      where.OR = [...(where.OR || []), { contrato_inicio: null }, { contrato_fin: null }];
    }
  }
  if (con_contrato === '1') where.id_archivo_contrato = { not: null };
  else if (con_contrato === '0') where.id_archivo_contrato = null;

  // Ámbito del usuario: limita a clientes con registros del/los tipo(s) permitido(s).
  Object.assign(where, clienteAlcanceWhere(user));

  return where;
}

/**
 * Catálogo de clasificaciones de cliente (Grande / Pequeño / Marca JY).
 */
const listarClasificaciones = (_req, res) => {
  res.json({ data: CLASIFICACIONES });
};

/**
 * Busca un cliente ACTIVO por su número de documento (RUC/DNI). Lo usa el
 * wizard de conversión de leads para detectar si el documento ingresado ya
 * pertenece a un cliente y vincularlo en vez de crear un duplicado. Devuelve
 * el cliente o null; en ambos casos responde 200.
 */
const buscarPorDocumento = async (req, res) => {
  try {
    const numero = String(req.params.numero || '').trim();
    if (!numero) return res.json({ data: null });
    const cliente = await prisma.tbl_clientes.findFirst({
      where: { numero_documento: numero, estado: 1 },
      select: { id: true, nombre: true, numero_documento: true, tipo_documento: true }
    });
    res.json({ data: cliente || null });
  } catch (err) {
    console.error('[clientes.buscarPorDocumento]', err);
    res.status(500).json({ error: 'Error al buscar cliente por documento' });
  }
};

/**
 * Tipos de ascensor activos del catálogo (tbl_tipos_ascensor). Alimenta el
 * filtro "Tipo de ascensor" en el listado de clientes.
 */
const listarTiposAscensor = async (_req, res) => {
  try {
    const tipos = await prisma.tbl_tipos_ascensor.findMany({
      where: { estado: 1 },
      orderBy: [{ nombre: 'asc' }],
      select: { nombre: true }
    });
    res.json({ data: tipos.map(t => t.nombre) });
  } catch (err) {
    console.error('[clientes.listarTiposAscensor]', err);
    res.status(500).json({ error: 'Error al listar tipos de ascensor' });
  }
};

const listar = async (req, res) => {
  try {
    const where = await construirWhereClientes(req.query, req.user);

    const result = await paginar(
      prisma.tbl_clientes,
      {
        where,
        orderBy: { id: 'desc' },
        include: {
          _count: { select: { edificios: true, servicios: true, archivos: true } },
          archivo_contrato: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } }
        }
      },
      req.query
    );

    const userIds = [...new Set(result.data.map(c => c.user_id_registration).filter(Boolean))];
    if (userIds.length > 0) {
      const usuarios = await prisma.tbl_usuarios.findMany({
        where: { id: { in: userIds } },
        select: { id: true, nombres: true, rol: { select: { nombre: true } } }
      });
      const userMap = new Map(usuarios.map(u => [u.id, u]));
      result.data = result.data.map(c => ({
        ...c,
        usuario_registrador: c.user_id_registration ? (userMap.get(c.user_id_registration) || null) : null
      }));
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar clientes' });
  }
};

/**
 * Devuelve el listado de clientes en XLSX o PDF según ?formato=excel|pdf.
 * Reusa exactamente el mismo `where` que listar().
 */
const exportar = async (req, res) => {
  try {
    const formato = String(req.query.formato || 'excel').toLowerCase();
    if (!['excel', 'pdf'].includes(formato)) {
      return res.status(400).json({ error: 'Formato debe ser "excel" o "pdf"' });
    }

    const where = await construirWhereClientes(req.query, req.user);
    const clientes = await prisma.tbl_clientes.findMany({
      where,
      orderBy: { nombre: 'asc' },
      include: {
        _count: { select: { edificios: true, servicios: true, archivos: true } },
        edificios: { where: { estado: 1 }, select: { nombre: true, distrito: true, tipo: true, _count: { select: { ascensores: true } } } },
        archivo_contrato: { select: { nombre_original: true } }
      }
    });

    const { generarExcelClientes, generarPdfClientes } = require('../utils/clientesExport');
    const stamp = ymdLima();

    if (formato === 'excel') {
      const buffer = await generarExcelClientes(clientes);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="clientes-${stamp}.xlsx"`);
      return res.end(buffer);
    }

    const buffer = await generarPdfClientes(clientes);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="clientes-${stamp}.pdf"`);
    return res.end(buffer);
  } catch (err) {
    console.error('[clientes.exportar]', err);
    res.status(500).json({ error: 'Error al exportar clientes: ' + err.message });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (aplicaAlcance(req.user)) {
      const enAmbito = await prisma.tbl_clientes.findFirst({
        where: { id, ...clienteAlcanceWhere(req.user) }, select: { id: true }
      });
      if (!enAmbito) return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const cliente = await prisma.tbl_clientes.findUnique({
      where: { id },
      include: {
        edificios: INCLUDE_EDIFICIOS,
        archivo_contrato: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true, fecha_subida: true } },
        archivos: INCLUDE_ARCHIVOS,
        precios: INCLUDE_PRECIOS
      }
    });
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ data: cliente });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener cliente' });
  }
};

const vista360 = async (req, res) => {
  try {
    const id = Number(req.params.id);

    // Ámbito del usuario: un cliente fuera del ámbito no es accesible ni por URL,
    // y dentro de un cliente mixto solo se muestran los registros del ámbito.
    const tipos = tiposRegistroPermitidos(req.user); // null (sin restricción) | ['servicio'|'proyecto']
    const filtroServicio = tipos ? { tipo_registro: { in: tipos.length ? tipos : ['__sin_ambito__'] } } : {};
    const filtroServicioRel = tipos ? { servicio: filtroServicio } : {};
    const filtroCategoria = tipos
      ? { categoria_funcional: { in: tipos.length ? tipos.map(t => (t === 'proyecto' ? 'PROYECTOS' : 'SERVICIOS')) : ['__sin_ambito__'] } }
      : {};
    if (aplicaAlcance(req.user)) {
      const enAmbito = await prisma.tbl_clientes.findFirst({
        where: { id, ...clienteAlcanceWhere(req.user) }, select: { id: true }
      });
      if (!enAmbito) return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const cliente = await prisma.tbl_clientes.findUnique({
      where: { id },
      include: {
        edificios: INCLUDE_EDIFICIOS,
        archivos: INCLUDE_ARCHIVOS,
        precios: INCLUDE_PRECIOS,
        archivo_contrato: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true, fecha_subida: true } },
        servicios: {
          where: { estado: 1, ...filtroServicio },
          orderBy: { id: 'desc' },
          take: 100,
          include: {
            tipo_servicio: true,
            ascensores: { where: { estado: 1 }, include: { ascensor: { select: { codigo: true, ubicacion: true } } } },
            asignaciones: { include: { tecnico: true }, where: { estado: 1 } }
          }
        },
        emergencias: {
          orderBy: { fecha_reporte: 'desc' },
          take: 50,
          where: { estado: 1 },
          include: { ascensor: { select: { codigo: true } } }
        },
        mantenimientos: {
          where: { estado: 1 },
          include: { ascensor: { select: { codigo: true } }, tipo_servicio: true }
        },
        cobros: { where: { estado: 1, ...filtroServicioRel }, orderBy: { id: 'desc' } },
        facturas: {
          where: { estado: 1, ...filtroServicioRel }, orderBy: { id: 'desc' }, take: 50,
          include: { archivo: true, servicio: { select: { codigo: true } } }
        },
        cotizaciones: {
          where: { estado: 1, ...(tipos ? { tipo_servicio: filtroCategoria } : {}) }, orderBy: { id: 'desc' }, take: 50,
          include: {
            tipo_servicio: { select: { nombre: true } },
            versiones: {
              where: { estado: 1 },
              orderBy: { numero_version: 'desc' },
              take: 1,
              select: { numero_version: true, estado_version: true, monto_total: true, moneda: true, fecha_validez: true }
            }
          }
        },
        historial: { orderBy: { fecha_evento: 'desc' }, take: 100 }
      }
    });
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Emergencias y mantenimientos son dominio de Servicios: se ocultan a un
    // usuario cuyo ámbito sea solo Proyectos.
    if (tipos && !tipos.includes('servicio')) {
      cliente.emergencias = [];
      cliente.mantenimientos = [];
    }

    const idsServicios = cliente.servicios.map(s => s.id);
    const [entregas, documentosCliente] = await Promise.all([
      idsServicios.length === 0 ? [] : prisma.tbl_entregas.findMany({
        where: { id_servicio: { in: idsServicios }, estado: 1 },
        orderBy: { fecha_entrega: 'desc' },
        include: { archivo: true, servicio: { select: { codigo: true } } }
      }),
      // Documentos: archivos asociados a guías/evidencias/facturas/entregas del cliente
      idsServicios.length === 0 ? [] : prisma.tbl_archivos.findMany({
        where: {
          estado: 1,
          OR: [
            { guias: { some: { id_servicio: { in: idsServicios }, estado: 1 } } },
            { evidencias: { some: { id_servicio: { in: idsServicios }, estado: 1 } } },
            { facturas: { some: { id_servicio: { in: idsServicios }, estado: 1 } } },
            { entregas: { some: { id_servicio: { in: idsServicios }, estado: 1 } } }
          ]
        },
        orderBy: { fecha_subida: 'desc' },
        take: 100
      })
    ]);

    res.json({ data: { ...cliente, entregas, documentos: documentosCliente } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en vista 360' });
  }
};

const crear = async (req, res) => {
  try {
    const data = req.body;
    if (!data.nombre) {
      return res.status(400).json({ error: 'La razón social / nombre es obligatorio' });
    }
    if (!data.contrato_inicio || !data.contrato_fin) {
      return res.status(400).json({ error: 'Inicio y fin del contrato de servicio son obligatorios' });
    }
    const contratoInicio = parseFechaContrato(data.contrato_inicio);
    const contratoFin = parseFechaContrato(data.contrato_fin);
    if (!contratoInicio || !contratoFin) {
      return res.status(400).json({ error: 'Fechas de contrato inválidas' });
    }
    if (contratoFin < contratoInicio) {
      return res.status(400).json({ error: 'La fecha fin del contrato no puede ser anterior al inicio' });
    }
    if (data.numero_documento) {
      const duplicado = await prisma.tbl_clientes.findFirst({
        where: {
          tipo_documento: data.tipo_documento || 'RUC',
          numero_documento: data.numero_documento,
          estado: 1
        }
      });
      if (duplicado) {
        return res.status(400).json({ error: `Ya existe un cliente con ${data.tipo_documento || 'RUC'} ${data.numero_documento}` });
      }
    }
    const contactos = Object.fromEntries(CAMPOS_CONTACTOS.map(k => [k, trimOrNull(data[k])]));
    const cliente = await prisma.$transaction(async (tx) => {
      const creado = await tx.tbl_clientes.create({
        data: {
          tipo_documento: data.tipo_documento || 'RUC',
          numero_documento: data.numero_documento || null,
          nombre: data.nombre,
          telefono: trimOrNull(data.telefono),
          whatsapp: trimOrNull(data.whatsapp),
          correo: trimOrNull(data.correo),
          ...contactos,
          observaciones: data.observaciones || null,
          contrato_inicio: contratoInicio,
          contrato_fin: contratoFin,
          id_archivo_contrato: data.id_archivo_contrato ? Number(data.id_archivo_contrato) : null,
          clasificacion: normalizarClasificacion(data.clasificacion),
          user_id_registration: req.user.id
        }
      });
      await reemplazarArchivosCliente(tx, creado.id, data.archivos, req.user.id);
      await reemplazarPreciosCliente(tx, creado.id, data.precios, req.user.id);
      return tx.tbl_clientes.findUnique({
        where: { id: creado.id },
        include: {
          archivo_contrato: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } },
          archivos: INCLUDE_ARCHIVOS,
          precios: INCLUDE_PRECIOS
        }
      });
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_clientes', id_entidad: cliente.id,
      accion: 'CREATE', valor_nuevo: cliente, ip: req.ip
    });
    res.status(201).json({ data: cliente });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body;
    const previo = await prisma.tbl_clientes.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Cliente no encontrado' });

    if (data.numero_documento && data.numero_documento !== previo.numero_documento) {
      const tipoDoc = data.tipo_documento || previo.tipo_documento;
      const duplicado = await prisma.tbl_clientes.findFirst({
        where: {
          tipo_documento: tipoDoc,
          numero_documento: data.numero_documento,
          id: { not: id },
          estado: 1
        }
      });
      if (duplicado) {
        return res.status(400).json({ error: `Ya existe otro cliente con ${tipoDoc} ${data.numero_documento}` });
      }
    }

    let contratoInicio = previo.contrato_inicio;
    let contratoFin = previo.contrato_fin;
    if (data.contrato_inicio !== undefined) {
      contratoInicio = parseFechaContrato(data.contrato_inicio);
      if (contratoInicio === undefined) {
        return res.status(400).json({ error: 'Fecha de inicio de contrato inválida' });
      }
    }
    if (data.contrato_fin !== undefined) {
      contratoFin = parseFechaContrato(data.contrato_fin);
      if (contratoFin === undefined) {
        return res.status(400).json({ error: 'Fecha de fin de contrato inválida' });
      }
    }
    if (contratoInicio && contratoFin && contratoFin < contratoInicio) {
      return res.status(400).json({ error: 'La fecha fin del contrato no puede ser anterior al inicio' });
    }

    let idArchivoContrato = previo.id_archivo_contrato;
    if (Object.prototype.hasOwnProperty.call(data, 'id_archivo_contrato')) {
      const valor = data.id_archivo_contrato;
      idArchivoContrato = (valor === null || valor === '' || valor === undefined) ? null : Number(valor);
    }

    const dataContactos = {};
    for (const k of CAMPOS_CONTACTOS) {
      if (Object.prototype.hasOwnProperty.call(data, k)) dataContactos[k] = trimOrNull(data[k]);
    }
    const cliente = await prisma.$transaction(async (tx) => {
      await tx.tbl_clientes.update({
        where: { id },
        data: {
          tipo_documento: data.tipo_documento ?? previo.tipo_documento,
          numero_documento: data.numero_documento ?? previo.numero_documento,
          nombre: data.nombre ?? previo.nombre,
          telefono: data.telefono ?? previo.telefono,
          whatsapp: data.whatsapp ?? previo.whatsapp,
          correo: data.correo ?? previo.correo,
          ...dataContactos,
          observaciones: data.observaciones ?? previo.observaciones,
          contrato_inicio: contratoInicio,
          contrato_fin: contratoFin,
          id_archivo_contrato: idArchivoContrato,
          clasificacion: Object.prototype.hasOwnProperty.call(data, 'clasificacion')
            ? normalizarClasificacion(data.clasificacion)
            : previo.clasificacion,
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });
      await reemplazarArchivosCliente(tx, id, data.archivos, req.user.id);
      await reemplazarPreciosCliente(tx, id, data.precios, req.user.id);
      return tx.tbl_clientes.findUnique({
        where: { id },
        include: {
          archivo_contrato: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } },
          archivos: INCLUDE_ARCHIVOS,
          precios: INCLUDE_PRECIOS
        }
      });
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_clientes', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: cliente, ip: req.ip
    });
    res.json({ data: cliente });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    const cliente = await prisma.tbl_clientes.update({
      where: { id },
      data: { estado: Number(estado), user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_clientes', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_nuevo: { estado: Number(estado) }, ip: req.ip
    });
    res.json({ data: cliente });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

module.exports = { listar, listarTiposAscensor, listarClasificaciones, buscarPorDocumento, exportar, obtener, vista360, crear, actualizar, cambiarEstado };

const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { puedeVerFinanzasReq, servicioSinPrecios, planMantenimientoSinFinanzas } = require('../utils/visibilidadFinanzas');
const { paginar } = require('../utils/paginacion');
const configuracion = require('../utils/configuracion');
const { parseYMDLima, inicioDelDiaLima, ymdLima } = require('../utils/tiempo');
const {
  CLASIFICACIONES, CLASIFICACIONES_CODIGOS, normalizarClasificacion,
  CAMPOS_CONTRATO_AREA, ETIQUETA_AREA, AREAS_CLIENTE, AREA_AMBAS
} = require('../utils/catalogosClientes');
const {
  tiposRegistroPermitidos,
  puedeVerTipoRegistro,
  clienteAlcanceWhere,
} = require('../utils/alcanceUsuario');

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
 * Reemplaza los adjuntos del cliente POR ÁREA. Recibe, por cada área,
 * `data.archivos_servicio` / `data.archivos_proyecto` (arrays de
 * { id_archivo, descripcion?, orden? }). Solo toca las áreas presentes en el
 * payload Y que el usuario tenga permitido gestionar según su ámbito: así un
 * usuario acotado a un área no borra los documentos de la otra (que ni ve).
 * Compatibilidad: `data.archivos` (legacy, sin área) se trata como 'servicio'.
 */
async function reemplazarArchivosCliente(tx, idCliente, data, idUsuario, user) {
  const porArea = {
    servicio: Array.isArray(data.archivos_servicio) ? data.archivos_servicio
      : (Array.isArray(data.archivos) ? data.archivos : undefined),
    proyecto: Array.isArray(data.archivos_proyecto) ? data.archivos_proyecto : undefined
  };
  for (const area of AREAS_CLIENTE) {
    const payload = porArea[area];
    if (!Array.isArray(payload)) continue;                     // área no enviada → intacta
    if (user && !puedeVerTipoRegistro(user, area)) continue;   // sin permiso sobre el área → intacta
    await tx.tbl_clientes_archivos.deleteMany({ where: { id_cliente: idCliente, area } });
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
          area,
          descripcion: a.descripcion,
          orden: a.orden,
          user_id_registration: idUsuario
        }
      });
    }
  }
}

/**
 * Include de adjuntos del cliente filtrado por el ÁMBITO del usuario: un usuario
 * acotado a un área solo ve los documentos de esa área. Roles sin ámbito
 * (super_admin, contabilidad…) ven todos.
 */
function includeArchivos(user) {
  const tipos = tiposRegistroPermitidos(user); // null = sin restricción
  const where = { estado: 1 };
  if (tipos) where.area = { in: tipos.length ? tipos : ['__sin_ambito__'] };
  return {
    where,
    orderBy: { orden: 'asc' },
    include: { archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true, tamano_bytes: true, fecha_subida: true } } }
  };
}

/**
 * Include de los contratos ya reemplazados, filtrado por el ÁMBITO del usuario:
 * un usuario acotado a un área solo ve el historial de contratos de esa área.
 * Del más reciente al más antiguo.
 */
function includeContratosHistorial(user) {
  const tipos = tiposRegistroPermitidos(user); // null = sin restricción
  const where = { estado: 1 };
  if (tipos) where.area = { in: tipos.length ? tipos : ['__sin_ambito__'] };
  return { where, orderBy: { fecha_reemplazo: 'desc' } };
}

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

// Igual que INCLUDE_EDIFICIOS pero sin filtrar por estado: la vista 360 es el
// único lugar donde se ven los edificios y ascensores dados de baja, para poder
// reactivarlos. Los activos van primero (tanto edificios como ascensores).
const INCLUDE_EDIFICIOS_360 = {
  orderBy: [{ estado: 'desc' }, { id: 'desc' }],
  include: {
    ascensores: { orderBy: [{ estado: 'desc' }, { id: 'asc' }] },
    _count: { select: { ascensores: true } }
  }
};

/**
 * Condición Prisma sobre tbl_ascensores para el buscador libre de clientes.
 * Un ascensor coincide por su código (identificador que usa el técnico en campo),
 * su ubicación dentro del edificio, o su marca / modelo.
 */
const matchAscensorBusqueda = (q) => ({
  estado: 1,
  OR: [
    { codigo: { contains: q, mode: 'insensitive' } },
    { ubicacion: { contains: q, mode: 'insensitive' } },
    { marca: { contains: q, mode: 'insensitive' } },
    { modelo: { contains: q, mode: 'insensitive' } }
  ]
});

/**
 * Condición Prisma sobre tbl_edificios para el buscador libre: el edificio/obra
 * coincide por su nombre o su dirección, o bien tiene algún ascensor que coincide.
 */
const matchEdificioBusqueda = (q) => ({
  estado: 1,
  OR: [
    { nombre: { contains: q, mode: 'insensitive' } },
    { direccion: { contains: q, mode: 'insensitive' } },
    { ascensores: { some: matchAscensorBusqueda(q) } }
  ]
});

/**
 * Construye el `where` Prisma para tbl_clientes a partir de los filtros de querystring.
 * Centralizado para que listar() y exportar() apliquen exactamente los mismos criterios.
 *
 * La ubicación física vive ahora en los edificios del cliente, así que los
 * filtros por distrito y por tipo de ascensor se resuelven a través de la
 * relación `edificios`.
 *
 * Filtros soportados:
 *   q                — texto libre sobre nombre / nº documento / teléfono (del cliente o
 *                      de su contacto principal), nombre o dirección de edificio/obra, y
 *                      código / ubicación / marca / modelo de sus ascensores
 *   distrito         — clientes con algún edificio en ese distrito
 *   tipo_ascensor    — clientes con algún edificio que tenga un ascensor de ese tipo
 *   clasificacion    — match exacto
 *   estado           — 0 | 1 (activo/inactivo)
 *   estado_contrato  — vigente | por_vencer | vencido | sin_contrato
 *   con_contrato     — '1' | '0' filtra si tiene archivo de contrato adjunto
 *   area_contrato    — servicio | proyecto | ambos: área cuyos datos de contrato
 *                      y documentación registra el cliente (inclusivo)
 *
 * `user` aplica el ámbito (Servicios/Proyectos): si el rol está acotado, solo
 * devuelve los clientes de su(s) área(s) (ver clienteAlcanceWhere).
 */
async function construirWhereClientes(query, user) {
  const { q, distrito, tipo_ascensor, clasificacion, estado, estado_contrato, con_contrato, area_contrato } = query;
  const where = { estado: 1 };
  if (q) {
    where.OR = [
      { nombre: { contains: q, mode: 'insensitive' } },
      { numero_documento: { contains: q, mode: 'insensitive' } },
      { telefono: { contains: q, mode: 'insensitive' } },
      { contacto_principal_telefono: { contains: q, mode: 'insensitive' } },
      { edificios: { some: matchEdificioBusqueda(q) } }
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

  // Estado de contrato POR ÁREA: se evalúa sobre las áreas que el usuario puede
  // ver (según su ámbito). Si ve ambas, un cliente coincide si CUALQUIERA cumple.
  // Se usa where.AND para no pisar el where.OR del buscador `q`.
  const tiposContrato = tiposRegistroPermitidos(user);
  const areasContrato = (tiposContrato && tiposContrato.length) ? tiposContrato : AREAS_CLIENTE;
  const colInicio = (a) => CAMPOS_CONTRATO_AREA[a].inicio;
  const colFin = (a) => CAMPOS_CONTRATO_AREA[a].fin;
  const colArch = (a) => CAMPOS_CONTRATO_AREA[a].archivo;
  const pushAnd = (cond) => { (where.AND = where.AND || []).push(cond); };

  if (estado_contrato) {
    const diasAviso = await configuracion.obtener('CLIENTES_DIAS_AVISO_VENCIMIENTO_CONTRATO');
    const hoy = inicioDelDiaLima();
    const proximo = new Date(hoy.getTime() + Number(diasAviso || 30) * 86400000);
    const condArea = (a) => {
      if (estado_contrato === 'vigente') return { [colInicio(a)]: { lte: hoy }, [colFin(a)]: { gte: hoy } };
      if (estado_contrato === 'por_vencer') return { [colFin(a)]: { gte: hoy, lte: proximo } };
      if (estado_contrato === 'vencido') return { [colFin(a)]: { lt: hoy } };
      if (estado_contrato === 'sin_contrato') return { OR: [{ [colInicio(a)]: null }, { [colFin(a)]: null }] };
      return {};
    };
    pushAnd({ OR: areasContrato.map(condArea) });
  }
  if (con_contrato === '1') pushAnd({ OR: areasContrato.map(a => ({ [colArch(a)]: { not: null } })) });
  else if (con_contrato === '0') pushAnd({ AND: areasContrato.map(a => ({ [colArch(a)]: null })) });

  // Área cuyos datos de contrato y documentación registra el cliente. Un área
  // cuenta cuando tiene contrato registrado (inicio y fin), el mismo criterio
  // que exige el alta y que usa el ámbito. Es inclusivo: pedir un área devuelve
  // también a los clientes que registran las dos.
  const conContratoDe = (a) => ({ [colInicio(a)]: { not: null }, [colFin(a)]: { not: null } });
  if (area_contrato === AREA_AMBAS) pushAnd({ AND: AREAS_CLIENTE.map(conContratoDe) });
  else if (AREAS_CLIENTE.includes(area_contrato)) pushAnd(conContratoDe(area_contrato));

  // Ámbito del usuario: limita a clientes de su(s) área(s). Se agrega como una
  // cláusula AND (no con Object.assign) para no pisar el where.OR del buscador `q`.
  const alcance = clienteAlcanceWhere(user);
  if (Object.keys(alcance).length) pushAnd(alcance);

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

    // Cuando hay búsqueda libre, además del contador traemos los edificios y
    // ascensores que coinciden con el término, para que el listado pueda señalar
    // de forma discreta de dónde vino la coincidencia (edificio/obra o ascensor).
    const q = (req.query.q || '').trim();
    const include = {
      _count: { select: { edificios: true, servicios: true, archivos: true } },
      archivo_contrato_servicio: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } },
      archivo_contrato_proyecto: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } }
    };
    if (q) {
      include.edificios = {
        where: matchEdificioBusqueda(q),
        select: {
          id: true, nombre: true, direccion: true,
          ascensores: {
            where: matchAscensorBusqueda(q),
            select: { id: true, codigo: true, ubicacion: true },
            orderBy: { codigo: 'asc' }
          }
        },
        orderBy: { nombre: 'asc' }
      };
    }

    const result = await paginar(
      prisma.tbl_clientes,
      { where, orderBy: { id: 'desc' }, include },
      req.query
    );

    if (q) {
      // El include trae los edificios que coinciden por sus propios datos Y los que
      // solo entraron por tener un ascensor coincidente: se separan aquí para no
      // marcar como "coincide el edificio" lo que en realidad coincidió por ascensor.
      const term = q.toLowerCase();
      const coincideEdificio = (e) =>
        (e.nombre || '').toLowerCase().includes(term) || (e.direccion || '').toLowerCase().includes(term);
      result.data = result.data.map(c => {
        const { edificios, ...resto } = c;
        const lista = edificios || [];
        return {
          ...resto,
          edificios_coincidentes: lista.filter(coincideEdificio).map(({ id, nombre }) => ({ id, nombre })),
          ascensores_coincidentes: lista.flatMap(e =>
            (e.ascensores || []).map(a => ({ ...a, edificio: e.nombre }))
          )
        };
      });
    }

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
        archivo_contrato_servicio: { select: { nombre_original: true } },
        archivo_contrato_proyecto: { select: { nombre_original: true } }
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
    // El ámbito va en el propio where: un cliente de otra área no existe para
    // este usuario, tampoco entrando por URL directa.
    const cliente = await prisma.tbl_clientes.findFirst({
      where: { id, ...clienteAlcanceWhere(req.user) },
      include: {
        edificios: INCLUDE_EDIFICIOS,
        ...INCLUDE_CONTRATOS,
        contratos_historial: includeContratosHistorial(req.user),
        archivos: includeArchivos(req.user)
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
    const cliente = await prisma.tbl_clientes.findFirst({
      where: { id, ...clienteAlcanceWhere(req.user) },
      include: {
        edificios: INCLUDE_EDIFICIOS_360,
        archivos: includeArchivos(req.user),
        ...INCLUDE_CONTRATOS,
        contratos_historial: includeContratosHistorial(req.user),
        servicios: {
          where: { estado: 1, ...filtroServicio },
          orderBy: { id: 'desc' },
          take: 100,
          include: {
            tipo_servicio: true,
            ascensores: { where: { estado: 1 }, include: { ascensor: { select: { codigo: true, ubicacion: true, edificio: { select: { nombre: true } } } } } },
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
          include: { ascensores: { where: { estado: 1 }, include: { ascensor: { select: { codigo: true } } } }, tipo_servicio: true }
        },
        cobros: { where: { estado: 1, ...filtroServicioRel }, orderBy: { id: 'desc' } },
        facturas: {
          where: { estado: 1, ...filtroServicioRel }, orderBy: { id: 'desc' }, take: 50,
          include: { archivo: true, servicio: { select: { codigo: true } } }
        },
        cotizaciones: {
          where: { estado: 1, ...(tipos ? { tipo_servicio: filtroCategoria } : {}) }, orderBy: { id: 'desc' }, take: 50,
          include: {
            tipo_servicio: { select: { nombre: true, categoria_funcional: true } },
            versiones: {
              where: { estado: 1 },
              orderBy: { numero_version: 'desc' },
              take: 1,
              select: { numero_version: true, estado_version: true, monto_total: true, moneda: true }
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

    const data = { ...cliente, entregas, documentos: documentosCliente };
    // Roles sin visibilidad financiera (Coordinador, Técnico…): la ficha 360 se
    // entrega sin cobros ni facturas, sin el precio de cada servicio y sin el
    // total de las cotizaciones. Se conservan código, tipo, estado y fechas.
    if (!puedeVerFinanzasReq(req)) {
      delete data.cobros;
      delete data.facturas;
      data.servicios = (data.servicios || []).map(servicioSinPrecios);
      data.mantenimientos = (data.mantenimientos || [])
        .map(m => planMantenimientoSinFinanzas(m, req.user));
      data.cotizaciones = (data.cotizaciones || []).map(c => ({
        ...c,
        versiones: (c.versiones || []).map(({ monto_total, moneda, ...v }) => v)
      }));
    }
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en vista 360' });
  }
};

// Include de los documentos de contrato de ambas áreas.
const INCLUDE_CONTRATOS = {
  archivo_contrato_servicio: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true, fecha_subida: true } },
  archivo_contrato_proyecto: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true, fecha_subida: true } }
};

/**
 * Resuelve y valida el contrato de servicio POR ÁREA (Servicios / Proyectos).
 * Reglas: si un área trae una fecha, debe traer ambas (y fin >= inicio); debe
 * existir contrato completo en AL MENOS un área. Respeta el ámbito: un usuario
 * acotado solo modifica sus áreas (las demás conservan lo previo). `previo` = el
 * cliente actual (o {} al crear). Devuelve { ok, error?, valores }.
 */
function resolverContratosPorArea(data, previo, user) {
  const valores = {};
  const completos = {};
  for (const area of AREAS_CLIENTE) {
    const c = CAMPOS_CONTRATO_AREA[area];
    const gestiona = !user || puedeVerTipoRegistro(user, area);
    let inicio = previo[c.inicio] ?? null;
    let fin = previo[c.fin] ?? null;
    let archivo = previo[c.archivo] ?? null;
    if (gestiona) {
      if (Object.prototype.hasOwnProperty.call(data, c.inicio)) {
        const v = parseFechaContrato(data[c.inicio]);
        if (v === undefined) return { ok: false, error: `Fecha de inicio de contrato de ${ETIQUETA_AREA[area]} inválida` };
        inicio = v;
      }
      if (Object.prototype.hasOwnProperty.call(data, c.fin)) {
        const v = parseFechaContrato(data[c.fin]);
        if (v === undefined) return { ok: false, error: `Fecha de fin de contrato de ${ETIQUETA_AREA[area]} inválida` };
        fin = v;
      }
      if (Object.prototype.hasOwnProperty.call(data, c.archivo)) {
        const raw = data[c.archivo];
        archivo = (raw === null || raw === '' || raw === undefined) ? null : Number(raw);
      }
    }
    if ((inicio && !fin) || (!inicio && fin)) {
      return { ok: false, error: `Complete inicio y fin del contrato de ${ETIQUETA_AREA[area]}` };
    }
    if (inicio && fin && fin < inicio) {
      return { ok: false, error: `La fecha fin del contrato de ${ETIQUETA_AREA[area]} no puede ser anterior al inicio` };
    }
    valores[c.inicio] = inicio;
    valores[c.fin] = fin;
    valores[c.archivo] = archivo;
    completos[area] = !!(inicio && fin);
  }
  if (!completos.servicio && !completos.proyecto) {
    return { ok: false, error: 'Registre el contrato (inicio y fin) de al menos un área: Servicios o Proyectos' };
  }
  return { ok: true, valores };
}

const crear = async (req, res) => {
  try {
    const data = req.body;
    if (!data.nombre) {
      return res.status(400).json({ error: 'La razón social / nombre es obligatorio' });
    }
    const contratos = resolverContratosPorArea(data, {}, req.user);
    if (!contratos.ok) return res.status(400).json({ error: contratos.error });
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
          ...contratos.valores,
          clasificacion: normalizarClasificacion(data.clasificacion),
          user_id_registration: req.user.id
        }
      });
      await reemplazarArchivosCliente(tx, creado.id, data, req.user.id, req.user);
      return tx.tbl_clientes.findUnique({
        where: { id: creado.id },
        include: {
          ...INCLUDE_CONTRATOS,
          archivos: includeArchivos(req.user)
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
    // Mismo criterio que `obtener`: un cliente fuera del ámbito no existe para
    // este usuario, tampoco para editarlo por ID.
    const previo = await prisma.tbl_clientes.findFirst({
      where: { id, ...clienteAlcanceWhere(req.user) }
    });
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

    const contratos = resolverContratosPorArea(data, previo, req.user);
    if (!contratos.ok) return res.status(400).json({ error: contratos.error });

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
          ...contratos.valores,
          clasificacion: Object.prototype.hasOwnProperty.call(data, 'clasificacion')
            ? normalizarClasificacion(data.clasificacion)
            : previo.clasificacion,
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });
      await reemplazarArchivosCliente(tx, id, data, req.user.id, req.user);
      return tx.tbl_clientes.findUnique({
        where: { id },
        include: {
          ...INCLUDE_CONTRATOS,
          archivos: includeArchivos(req.user)
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

/**
 * Registra un CONTRATO NUEVO para un área del cliente (renovación).
 *
 * El contrato que estaba vigente en esa área deja de estarlo: sus fechas se
 * archivan en tbl_clientes_contratos_historial y el cliente queda con la nueva
 * vigencia, de modo que el listado y los filtros por estado de contrato siempre
 * miran el vigente. El documento NO se historiza: el PDF es uno solo por área y
 * el nuevo reemplaza al anterior (si no se adjunta uno, se conserva el actual).
 *
 * Body: { area, fecha_inicio, fecha_fin, id_archivo?, observaciones? }
 */
const registrarContrato = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { area, fecha_inicio, fecha_fin, id_archivo, observaciones } = req.body;

    if (!AREAS_CLIENTE.includes(area)) {
      return res.status(400).json({ error: 'Área de contrato inválida' });
    }
    // Ámbito: además de ver al cliente, el usuario debe gestionar esa área.
    if (!puedeVerTipoRegistro(req.user, area)) {
      return res.status(403).json({ error: `No tiene acceso al área de ${ETIQUETA_AREA[area]}` });
    }

    const campos = CAMPOS_CONTRATO_AREA[area];
    const previo = await prisma.tbl_clientes.findFirst({
      where: { id, ...clienteAlcanceWhere(req.user) }
    });
    if (!previo) return res.status(404).json({ error: 'Cliente no encontrado' });

    const inicio = parseFechaContrato(fecha_inicio);
    const fin = parseFechaContrato(fecha_fin);
    if (inicio === undefined || fin === undefined) {
      return res.status(400).json({ error: 'Fechas de vigencia inválidas' });
    }
    if (!inicio || !fin) {
      return res.status(400).json({ error: 'Indique el inicio y el fin de la nueva vigencia' });
    }
    if (fin < inicio) {
      return res.status(400).json({ error: 'La fecha fin no puede ser anterior al inicio' });
    }

    // Sin archivo en el payload → se conserva el documento actual del área.
    const archivoNuevo = (id_archivo === undefined || id_archivo === null || id_archivo === '')
      ? previo[campos.archivo]
      : Number(id_archivo);

    const cliente = await prisma.$transaction(async (tx) => {
      // El anterior solo se archiva si estaba completo; un área sin contrato
      // previo (o a medio llenar) no deja rastro porque no había nada vigente.
      if (previo[campos.inicio] && previo[campos.fin]) {
        await tx.tbl_clientes_contratos_historial.create({
          data: {
            id_cliente: id,
            area,
            fecha_inicio: previo[campos.inicio],
            fecha_fin: previo[campos.fin],
            observaciones: trimOrNull(observaciones),
            user_id_registration: req.user.id
          }
        });
      }
      await tx.tbl_clientes.update({
        where: { id },
        data: {
          [campos.inicio]: inicio,
          [campos.fin]: fin,
          [campos.archivo]: archivoNuevo,
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });
      return tx.tbl_clientes.findUnique({
        where: { id },
        include: { ...INCLUDE_CONTRATOS, contratos_historial: includeContratosHistorial(req.user) }
      });
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_clientes', id_entidad: id,
      accion: 'CONTRATO_NUEVO',
      valor_anterior: {
        area,
        [campos.inicio]: previo[campos.inicio],
        [campos.fin]: previo[campos.fin],
        [campos.archivo]: previo[campos.archivo]
      },
      valor_nuevo: { area, [campos.inicio]: inicio, [campos.fin]: fin, [campos.archivo]: archivoNuevo },
      ip: req.ip
    });

    res.status(201).json({ data: cliente });
  } catch (err) {
    console.error('[clientes.registrarContrato]', err);
    res.status(500).json({ error: 'Error al registrar el contrato' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    const enAmbito = await prisma.tbl_clientes.findFirst({
      where: { id, ...clienteAlcanceWhere(req.user) }, select: { id: true }
    });
    if (!enAmbito) return res.status(404).json({ error: 'Cliente no encontrado' });
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

module.exports = { listar, listarTiposAscensor, listarClasificaciones, buscarPorDocumento, exportar, obtener, vista360, crear, actualizar, registrarContrato, cambiarEstado };

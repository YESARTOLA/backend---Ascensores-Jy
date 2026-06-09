const prisma = require('../config/prisma');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima, combinarFechaHoraLima } = require('../utils/tiempo');
const { colorPorTipo } = require('../utils/visibilidadCalendario');
const { sincronizarRecordatorioServicio } = require('../utils/recordatoriosAuto');
const {
  ESTADO_LEAD_CONSULTA,
  ESTADO_LEAD_COTIZADO,
  ESTADO_LEAD_INGRESADO,
  ESTADO_LEAD_DESCARTADO,
  esEstadoLeadValido,
  ESTADOS_LEAD
} = require('../utils/estadoLead');

// --- Edición de datos importantes -----------------------------------------
// Cada guardado del formulario de edición con cambios reales consume 1 edición
// (campo `ediciones`). Los roles distintos de super_admin tienen un máximo;
// cambiar de estado, descartar, cotizar o convertir NO consumen ediciones.
// Cada edición queda trazada en tbl_auditoria con el diff antes/después.
const LIMITE_EDICIONES_LEAD = 2;
const ROL_EDICION_ILIMITADA = 'super_admin';
const AUDITORIA_ENTIDAD_LEAD = 'tbl_leads';
const AUDITORIA_ACCION_EDICION = 'EDICION_DATOS';

// Relaciones necesarias para describir un lead en la trazabilidad.
const INCLUDE_EDICION = {
  cliente: { select: { nombre: true } },
  tipo_servicio: { select: { nombre: true } },
  ubigeo: true,
  tipo_ascensor: { select: { nombre: true } },
  vendedor: { select: { nombres: true } }
};

// Catálogo de datos importantes: columna editable + etiqueta y valor legible
// para el historial (las FKs se traducen a nombres, no se exponen ids).
const CAMPOS_EDITABLES_LEAD = [
  { campo: 'nombre_contacto', etiqueta: 'Nombre del contacto', valor: l => l.nombre_contacto },
  { campo: 'telefono', etiqueta: 'Teléfono', valor: l => l.telefono },
  { campo: 'correo', etiqueta: 'Correo', valor: l => l.correo },
  { campo: 'canal', etiqueta: 'Canal', valor: l => l.canal },
  { campo: 'codigo_ubigeo', etiqueta: 'Ubicación', valor: l => l.ubigeo ? `${l.ubigeo.distrito}, ${l.ubigeo.provincia}, ${l.ubigeo.departamento}` : null },
  { campo: 'id_tipo_ascensor', etiqueta: 'Tipo de ascensor', valor: l => l.tipo_ascensor?.nombre ?? null },
  { campo: 'razon_social', etiqueta: 'Razón social', valor: l => l.razon_social },
  { campo: 'ruc', etiqueta: 'RUC', valor: l => l.ruc },
  { campo: 'nombre_proyecto', etiqueta: 'Nombre del proyecto', valor: l => l.nombre_proyecto },
  { campo: 'id_tipo_servicio_solicitado', etiqueta: 'Tipo de servicio solicitado', valor: l => l.tipo_servicio?.nombre ?? null },
  { campo: 'cliente_existente', etiqueta: '¿Cliente existente?', valor: l => (l.cliente_existente ? 'Sí' : 'No') },
  { campo: 'id_cliente', etiqueta: 'Cliente asociado', valor: l => l.cliente?.nombre ?? null },
  { campo: 'id_vendedor', etiqueta: 'Vendedor', valor: l => l.vendedor?.nombres ?? null },
  { campo: 'observaciones', etiqueta: 'Observaciones', valor: l => l.observaciones }
];

// El motivo de descarte solo existe mientras el lead está Descartado: es
// obligatorio al descartar y se limpia (null) al reactivar a otro estado.
function resolverMotivoDescarte(estado_lead, motivo) {
  if (estado_lead !== ESTADO_LEAD_DESCARTADO) return { motivo_descarte: null };
  const limpio = (motivo || '').trim();
  if (!limpio) return { error: 'El motivo de descarte es obligatorio' };
  return { motivo_descarte: limpio };
}

// Valida y normaliza los campos comerciales del lead (ubicación por ubigeo,
// tipo de ascensor, correo, empresa del prospecto y nombre del proyecto).
// Con `requeridos: true` (alta) exige ubicación y tipo de ascensor; en la
// actualización solo valida lo que viene en el payload (update parcial).
async function resolverCamposComerciales(d, { requeridos }) {
  const data = {};

  if (requeridos || d.codigo_ubigeo !== undefined) {
    const codigo = String(d.codigo_ubigeo || '').trim();
    if (!codigo) return { error: 'La ubicación (departamento, provincia y distrito) es obligatoria' };
    const ubigeo = await prisma.tbl_ubigeo_peru.findUnique({ where: { codigo } });
    if (!ubigeo) return { error: 'El distrito seleccionado no es válido' };
    data.codigo_ubigeo = codigo;
  }

  if (requeridos || d.id_tipo_ascensor !== undefined) {
    const idTipo = Number(d.id_tipo_ascensor);
    if (!idTipo) return { error: 'El tipo de ascensor es obligatorio' };
    const tipo = await prisma.tbl_tipos_ascensor.findFirst({ where: { id: idTipo, estado: 1 } });
    if (!tipo) return { error: 'El tipo de ascensor seleccionado no es válido' };
    data.id_tipo_ascensor = idTipo;
  }

  if (requeridos || d.correo !== undefined) {
    const correo = String(d.correo || '').trim();
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      return { error: 'El correo no tiene un formato válido' };
    }
    data.correo = correo || null;
  }

  // La empresa (razón social + RUC) solo aplica a prospectos: si el lead se
  // vincula a un cliente existente esos datos viven en el cliente.
  const esClienteExistente = !!d.cliente_existente;
  if (requeridos || d.razon_social !== undefined || d.ruc !== undefined || d.cliente_existente !== undefined) {
    const razonSocial = esClienteExistente ? '' : String(d.razon_social || '').trim();
    const ruc = esClienteExistente ? '' : String(d.ruc || '').trim();
    if (ruc && !/^\d{11}$/.test(ruc)) {
      return { error: 'El RUC debe tener 11 dígitos numéricos' };
    }
    data.razon_social = razonSocial || null;
    data.ruc = ruc || null;
  }

  if (requeridos || d.nombre_proyecto !== undefined) {
    data.nombre_proyecto = String(d.nombre_proyecto || '').trim() || null;
  }

  return { data };
}

// Construye el `where` de la lista de leads a partir de los filtros de la URL.
// Filtros soportados:
//   q             — texto libre sobre nombre del proyecto / contacto / razón
//                   social / RUC / correo / teléfono / nombre del cliente vinculado
//   id_vendedor   — vendedor asignado (exacto)
//   provincia     — provincia del proyecto (vía relación ubigeo)
//   codigo_ubigeo — distrito del proyecto (preciso; implica su provincia)
function construirWhereLeads(query) {
  const { q, id_vendedor, provincia, codigo_ubigeo } = query;
  const where = { estado: 1 };
  const qLimpio = (q || '').trim();
  if (qLimpio) {
    where.OR = [
      { nombre_proyecto: { contains: qLimpio, mode: 'insensitive' } },
      { nombre_contacto: { contains: qLimpio, mode: 'insensitive' } },
      { razon_social: { contains: qLimpio, mode: 'insensitive' } },
      { ruc: { contains: qLimpio, mode: 'insensitive' } },
      { correo: { contains: qLimpio, mode: 'insensitive' } },
      { telefono: { contains: qLimpio, mode: 'insensitive' } },
      { cliente: { is: { nombre: { contains: qLimpio, mode: 'insensitive' } } } }
    ];
  }
  if (id_vendedor) where.id_vendedor = Number(id_vendedor);
  if (codigo_ubigeo) where.codigo_ubigeo = String(codigo_ubigeo);
  else if (provincia) where.ubigeo = { is: { provincia: String(provincia) } };
  return where;
}

const listar = async (req, res) => {
  try {
    const result = await paginar(
      prisma.tbl_leads,
      {
        where: construirWhereLeads(req.query),
        orderBy: { id: 'desc' },
        include: {
          cliente: true,
          tipo_servicio: true,
          ubigeo: true,
          tipo_ascensor: { select: { id: true, nombre: true } },
          usuario_registrador: { select: { id: true, nombres: true } },
          vendedor: { select: { id: true, nombres: true } }
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
      rol_nombre_registrador: l.rol_codigo_registrador ? (rolesMap.get(l.rol_codigo_registrador) || l.rol_codigo_registrador) : null,
      // El límite viaja con cada fila para que el frontend no lo hardcodee.
      ediciones_max: LIMITE_EDICIONES_LEAD
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
    const comerciales = await resolverCamposComerciales(d, { requeridos: true });
    if (comerciales.error) return res.status(400).json({ error: comerciales.error });
    const lead = await prisma.tbl_leads.create({
      data: {
        nombre_contacto: d.nombre_contacto,
        telefono: d.telefono,
        canal: d.canal || null,
        id_tipo_servicio_solicitado: d.id_tipo_servicio_solicitado ? Number(d.id_tipo_servicio_solicitado) : null,
        cliente_existente: d.cliente_existente ? 1 : 0,
        id_cliente: d.id_cliente ? Number(d.id_cliente) : null,
        id_vendedor: d.id_vendedor ? Number(d.id_vendedor) : null,
        estado_lead: ESTADO_LEAD_CONSULTA,
        observaciones: d.observaciones || null,
        ...comerciales.data,
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

// Edición de datos importantes del lead. El estado NO se edita por aquí:
// tiene su propio flujo (PATCH /:id/estado, cotizar, convertir), que no
// consume ediciones. Un guardado sin cambios reales tampoco consume.
const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_leads.findUnique({ where: { id }, include: INCLUDE_EDICION });
    if (!previo || previo.estado !== 1) return res.status(404).json({ error: 'Lead no encontrado' });
    const comerciales = await resolverCamposComerciales(d, { requeridos: false });
    if (comerciales.error) return res.status(400).json({ error: comerciales.error });

    // Campos opcionales se normalizan a null cuando vienen vacíos (igual que en
    // `crear`): así un campo vacío equivale a "sin valor" y un guardado sin
    // cambios reales (p. ej. observaciones null mostrado como '' en el form) no
    // dispara un falso positivo en el diff ni consume una edición.
    const data = {
      nombre_contacto: d.nombre_contacto,
      telefono: d.telefono,
      canal: d.canal || null,
      id_tipo_servicio_solicitado: d.id_tipo_servicio_solicitado ? Number(d.id_tipo_servicio_solicitado) : null,
      cliente_existente: d.cliente_existente ? 1 : 0,
      id_cliente: d.id_cliente ? Number(d.id_cliente) : null,
      id_vendedor: d.id_vendedor ? Number(d.id_vendedor) : null,
      observaciones: d.observaciones || null,
      ...comerciales.data
    };

    // Diff real contra los valores actuales: si nada cambió, no cuenta edición.
    const hayCambios = Object.keys(data).some(
      k => data[k] !== undefined && (data[k] ?? null) !== (previo[k] ?? null)
    );
    if (!hayCambios) return res.json({ data: previo });

    const esIlimitado = req.user.rol_codigo === ROL_EDICION_ILIMITADA;
    if (!esIlimitado && previo.ediciones >= LIMITE_EDICIONES_LEAD) {
      return res.status(403).json({ error: `Este lead ya alcanzó el máximo de ${LIMITE_EDICIONES_LEAD} ediciones` });
    }

    // Update + contador + trazabilidad en una sola transacción: el contador y
    // el historial nunca quedan desincronizados.
    const lead = await prisma.$transaction(async (tx) => {
      await tx.tbl_leads.update({
        where: { id },
        data: {
          ...data,
          ediciones: { increment: 1 },
          user_id_modification: req.user.id, date_time_modification: new Date()
        }
      });
      const nuevo = await tx.tbl_leads.findUnique({ where: { id }, include: INCLUDE_EDICION });
      const cambios = CAMPOS_EDITABLES_LEAD
        .map(c => ({ etiqueta: c.etiqueta, anterior: c.valor(previo) ?? null, nuevo: c.valor(nuevo) ?? null }))
        .filter(c => c.anterior !== c.nuevo);
      await tx.tbl_auditoria.create({
        data: {
          id_usuario: req.user.id,
          entidad: AUDITORIA_ENTIDAD_LEAD,
          id_entidad: id,
          accion: AUDITORIA_ACCION_EDICION,
          valor_anterior: Object.fromEntries(cambios.map(c => [c.etiqueta, c.anterior])),
          valor_nuevo: Object.fromEntries(cambios.map(c => [c.etiqueta, c.nuevo])),
          ip: req.ip || null
        }
      });
      return nuevo;
    });
    res.json({ data: lead });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar' });
  }
};

// Trazabilidad de ediciones del lead (solo super_admin, ver leadsRoutes):
// devuelve cada edición con fecha, usuario y campos cambiados antes/después.
const historial = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const eventos = await prisma.tbl_auditoria.findMany({
      where: { entidad: AUDITORIA_ENTIDAD_LEAD, id_entidad: id, accion: AUDITORIA_ACCION_EDICION, estado: 1 },
      orderBy: { fecha_evento: 'desc' }
    });
    const idsUsuarios = [...new Set(eventos.map(e => e.id_usuario).filter(Boolean))];
    const usuariosMap = idsUsuarios.length === 0
      ? new Map()
      : new Map((await prisma.tbl_usuarios.findMany({
          where: { id: { in: idsUsuarios } },
          select: { id: true, nombres: true }
        })).map(u => [u.id, u.nombres]));
    const data = eventos.map(e => ({
      id: e.id,
      fecha: e.fecha_evento,
      usuario: e.id_usuario ? (usuariosMap.get(e.id_usuario) || `Usuario ${e.id_usuario}`) : null,
      anterior: e.valor_anterior || {},
      nuevo: e.valor_nuevo || {}
    }));
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el historial del lead' });
  }
};

const convertir = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const lead = await prisma.tbl_leads.findUnique({
      where: { id },
      include: { ubigeo: true, tipo_ascensor: { select: { nombre: true } } }
    });
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
    if (lead.estado_lead === ESTADO_LEAD_DESCARTADO) {
      return res.status(400).json({ error: 'El lead está descartado; reactívalo antes de convertirlo' });
    }
    if (!d.id_cliente || !d.id_ascensor || !d.id_tipo_servicio || !d.fecha_programada || d.precio_interno === undefined) {
      return res.status(400).json({ error: 'Faltan datos para convertir (cliente, ascensor, tipo, fecha, precio)' });
    }

    const codigo = await generarCodigoServicio();
    const moneda = d.moneda || 'PEN';
    // Los datos comerciales del lead viajan al servicio: el nombre del
    // proyecto como título y la ubicación + tipo de ascensor en la descripción.
    const detallesLead = [];
    if (lead.ubigeo) {
      detallesLead.push(`Ubicación: ${lead.ubigeo.distrito}, ${lead.ubigeo.provincia}, ${lead.ubigeo.departamento}`);
    }
    if (lead.tipo_ascensor) detallesLead.push(`Tipo de ascensor: ${lead.tipo_ascensor.nombre}`);
    const descripcion = [d.descripcion || lead.observaciones, ...detallesLead].filter(Boolean).join('\n') || null;
    // El ascensor se vincula por la tabla puente tbl_servicios_ascensores (el
    // servicio no tiene columna id_ascensor). El monto de la línea es el precio.
    const servicio = await prisma.tbl_servicios_proyectos.create({
      data: {
        codigo,
        tipo_registro: d.tipo_registro || 'servicio',
        id_tipo_servicio: Number(d.id_tipo_servicio),
        id_cliente: Number(d.id_cliente),
        origen: 'lead',
        titulo: d.titulo || lead.nombre_proyecto || `Servicio desde lead ${lead.nombre_contacto}`,
        descripcion,
        fecha_programada: parseYMDLima(d.fecha_programada),
        hora_programada: d.hora_programada || null,
        prioridad: d.prioridad || 'media',
        precio_interno: d.precio_interno,
        moneda,
        observaciones: d.observaciones || null,
        user_id_registration: req.user.id,
        ascensores: {
          create: [{
            id_ascensor: Number(d.id_ascensor),
            monto: d.precio_interno,
            moneda,
            user_id_registration: req.user.id
          }]
        }
      }
    });

    // Registrar el evento en el calendario, igual que el alta normal de servicios,
    // para que el servicio convertido figure en el calendario operativo.
    await prisma.tbl_calendario_eventos.create({
      data: {
        id_servicio: servicio.id,
        titulo: `${servicio.codigo} – ${servicio.titulo}`,
        tipo_evento: 'servicio',
        fecha_inicio: combinarFechaHoraLima(d.fecha_programada, d.hora_programada),
        estado_evento: 'programado',
        color: colorPorTipo('servicio')
      }
    });
    sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync recordatorio:', err));

    await prisma.tbl_leads.update({
      where: { id },
      data: {
        estado_lead: ESTADO_LEAD_INGRESADO,
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

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado_lead, motivo_descarte } = req.body;
    if (!esEstadoLeadValido(estado_lead)) {
      return res.status(400).json({ error: `Estado inválido. Permitidos: ${ESTADOS_LEAD.join(', ')}` });
    }
    const motivo = resolverMotivoDescarte(estado_lead, motivo_descarte);
    if (motivo.error) return res.status(400).json({ error: motivo.error });
    const previo = await prisma.tbl_leads.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Lead no encontrado' });
    const lead = await prisma.tbl_leads.update({
      where: { id },
      data: {
        estado_lead,
        motivo_descarte: motivo.motivo_descarte,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    res.json({ data: lead });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado del lead' });
  }
};

// --- Cotizaciones adjuntas del lead (PDF versionado) -----------------------
// Cada PDF subido registra una versión incremental por lead. Subir una
// cotización marca el lead como "Cotizado" (salvo que ya esté Ingresado).

const listarCotizaciones = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = await prisma.tbl_leads_cotizaciones.findMany({
      where: { id_lead: id, estado: 1 },
      orderBy: { version: 'desc' },
      include: {
        archivo: true,
        usuario_registrador: { select: { id: true, nombres: true } }
      }
    });
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar cotizaciones del lead' });
  }
};

const subirCotizacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const idArchivo = Number(req.body.id_archivo);
    if (!idArchivo) return res.status(400).json({ error: 'El archivo de la cotización es obligatorio' });

    const lead = await prisma.tbl_leads.findUnique({ where: { id } });
    if (!lead || lead.estado !== 1) return res.status(404).json({ error: 'Lead no encontrado' });
    if (lead.estado_lead === ESTADO_LEAD_DESCARTADO) {
      return res.status(400).json({ error: 'El lead está descartado; reactívalo antes de adjuntar una cotización' });
    }

    const archivo = await prisma.tbl_archivos.findUnique({ where: { id: idArchivo } });
    if (!archivo) return res.status(400).json({ error: 'El archivo indicado no existe' });
    const esPdf = /pdf/i.test(archivo.mime_type || '') || /\.pdf$/i.test(archivo.nombre_original || '');
    if (!esPdf) return res.status(400).json({ error: 'La cotización debe ser un archivo PDF' });

    // Versión incremental por lead + cambio de estado, en una sola transacción.
    const cotizacion = await prisma.$transaction(async (tx) => {
      const ultima = await tx.tbl_leads_cotizaciones.aggregate({
        where: { id_lead: id },
        _max: { version: true }
      });
      const creada = await tx.tbl_leads_cotizaciones.create({
        data: {
          id_lead: id,
          version: (ultima._max.version || 0) + 1,
          id_archivo: idArchivo,
          user_id_registration: req.user.id
        },
        include: {
          archivo: true,
          usuario_registrador: { select: { id: true, nombres: true } }
        }
      });
      // Un lead ya Ingresado conserva su estado; el resto pasa a Cotizado.
      if (lead.estado_lead !== ESTADO_LEAD_INGRESADO && lead.estado_lead !== ESTADO_LEAD_COTIZADO) {
        await tx.tbl_leads.update({
          where: { id },
          data: {
            estado_lead: ESTADO_LEAD_COTIZADO,
            motivo_descarte: null,
            user_id_modification: req.user.id, date_time_modification: new Date()
          }
        });
      }
      return creada;
    });

    res.status(201).json({ data: cotizacion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al adjuntar la cotización' });
  }
};

// Vendedores que realmente figuran en algún lead, para poblar el filtro de la
// lista. Se deriva de los datos (no de /usuarios, que es solo super_admin) para
// que admin y coordinador también puedan filtrar por vendedor.
const listarVendedores = async (_req, res) => {
  try {
    const ids = await prisma.tbl_leads.findMany({
      where: { estado: 1, id_vendedor: { not: null } },
      distinct: ['id_vendedor'],
      select: { id_vendedor: true }
    });
    const idsVendedores = ids.map(r => r.id_vendedor);
    const vendedores = idsVendedores.length === 0 ? [] : await prisma.tbl_usuarios.findMany({
      where: { id: { in: idsVendedores } },
      select: { id: true, nombres: true },
      orderBy: { nombres: 'asc' }
    });
    res.json({ data: vendedores });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar vendedores' });
  }
};

module.exports = { listar, crear, actualizar, historial, convertir, cambiarEstado, listarCotizaciones, subirCotizacion, listarVendedores };

const prisma = require('../config/prisma');
const { ESTADO_EVENTO_PROGRAMADO } = require('../utils/estadoEvento');
const { puedeVerFinanzasReq } = require('../utils/visibilidadFinanzas');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { datosSitioParaServicio } = require('../utils/datosSitioAscensor');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima, combinarFechaHoraLima } = require('../utils/tiempo');
const { colorPorTipo } = require('../utils/visibilidadCalendario');
const { sincronizarRecordatorioServicio } = require('../utils/recordatoriosAuto');
const { replicarEnModulo } = require('../utils/replicarEnModulo');
const { clasificarTipoServicio } = require('../utils/clasificacionServicio');
const { conAlcance } = require('../utils/alcanceUsuario');
const {
  ROL_VENDEDORA,
  ROLES_ASIGNABLES_LEAD,
  soloSusLeads,
  leadAlcanceWhere,
  puedeVerLead
} = require('../utils/accesoLeads');
const {
  TIPO_DOC_RUC,
  BUEN_PAGADOR_SIN_CALIFICAR,
  esBuenPagadorValido,
  ESTADOS_BUEN_PAGADOR,
  resolverDocumento
} = require('../utils/datosLead');
const { buscarDuplicadosLead, mensajeDuplicados } = require('../utils/duplicadosLead');
const {
  MAX_DOCUMENTOS,
  INCLUDE_DOCUMENTOS,
  COUNT_DOCUMENTOS,
  puedeGestionarDocumentos,
  vincularDocumentosEnTx,
  keyDocumento
} = require('../utils/documentosLead');
const { eliminarObjeto } = require('../utils/storage');
const { registrarAuditoria } = require('../utils/auditoria');
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
  { campo: 'tipo_documento', etiqueta: 'Tipo de documento', valor: l => l.tipo_documento },
  { campo: 'ruc', etiqueta: 'RUC / DNI', valor: l => l.ruc },
  { campo: 'buen_pagador', etiqueta: 'Referencia de pago', valor: l => l.buen_pagador },
  { campo: 'nombre_proyecto', etiqueta: 'Nombre del proyecto', valor: l => l.nombre_proyecto },
  { campo: 'id_tipo_servicio_solicitado', etiqueta: 'Tipo de servicio solicitado', valor: l => l.tipo_servicio?.nombre ?? null },
  { campo: 'cliente_existente', etiqueta: '¿Cliente existente?', valor: l => (l.cliente_existente ? 'Sí' : 'No') },
  { campo: 'id_cliente', etiqueta: 'Cliente asociado', valor: l => l.cliente?.nombre ?? null },
  { campo: 'id_vendedor', etiqueta: 'Vendedora asignada', valor: l => l.vendedor?.nombres ?? null },
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

// La Vendedora asignada es quien decide la visibilidad del lead: solo ella lo
// ve y solo ella puede convertirlo. Por eso el campo se valida contra usuarios
// ACTIVOS con rol Vendedora (vacío = lead sin asignar, visible solo para la
// Central de ventas y administración).
// `actual` = asignación vigente del lead: se acepta tal cual aunque hoy no
// cumpla el criterio (leads históricos asignados a usuarios de otro rol), para
// que editar cualquier otro dato no obligue a reasignar el lead.
async function resolverVendedorAsignado(valor, actual = null) {
  if (valor === undefined) return { omitido: true };
  if (valor === null || valor === '') return { id_vendedor: null };
  const id = Number(valor);
  if (!id) return { error: 'La vendedora asignada no es válida' };
  if (actual !== null && id === actual) return { id_vendedor: actual };
  const usuario = await prisma.tbl_usuarios.findFirst({
    where: { id, estado: 1, rol: { is: { codigo: { in: ROLES_ASIGNABLES_LEAD } } } },
    select: { id: true }
  });
  if (!usuario) return { error: 'La vendedora asignada no existe o no está activa' };
  return { id_vendedor: id };
}

// Carga un lead comprobando el alcance del usuario: la Vendedora solo accede a
// los suyos. Se responde 404 (y no 403) para no revelar la existencia de leads
// de otras vendedoras.
async function cargarLeadPermitido(req, id, include = undefined) {
  const lead = await prisma.tbl_leads.findUnique({ where: { id }, include });
  if (!lead || lead.estado !== 1) return { error: 'Lead no encontrado' };
  if (!puedeVerLead(req.user, lead)) return { error: 'Lead no encontrado' };
  return { lead };
}

// Valida y normaliza los campos comerciales del lead (ubicación por ubigeo,
// tipo de ascensor, correo, empresa del prospecto y nombre del proyecto).
// El lead es el punto de captura: solo exige contacto (nombre, teléfono,
// correo) y tipo de ascensor. La ubicación y el resto de datos comerciales son
// opcionales aquí y se piden como obligatorios recién al convertirlo a cliente
// (wizard cliente → edificio → ascensor → servicio).
// Con `requeridos: true` (alta) exige tipo de ascensor y correo; en la
// actualización solo valida lo que viene en el payload (update parcial).
async function resolverCamposComerciales(d, { requeridos }) {
  const data = {};

  // Ubicación opcional: si llega vacía se guarda sin ubigeo; al convertir, el
  // distrito lo pide el edificio.
  if (requeridos || d.codigo_ubigeo !== undefined) {
    const codigo = String(d.codigo_ubigeo || '').trim();
    if (codigo) {
      const ubigeo = await prisma.tbl_ubigeo_peru.findUnique({ where: { codigo } });
      if (!ubigeo) return { error: 'El distrito seleccionado no es válido' };
    }
    data.codigo_ubigeo = codigo || null;
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
    if (!correo) return { error: 'El correo es obligatorio' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      return { error: 'El correo no tiene un formato válido' };
    }
    data.correo = correo;
  }

  // La empresa (razón social + documento) solo aplica a prospectos: si el lead
  // se vincula a un cliente existente esos datos viven en el cliente.
  // El prospecto puede ser empresa (RUC) o persona natural (DNI): el par
  // tipo/número lo valida `resolverDocumento`.
  const esClienteExistente = !!d.cliente_existente;
  if (requeridos || d.razon_social !== undefined || d.ruc !== undefined
      || d.tipo_documento !== undefined || d.cliente_existente !== undefined) {
    const razonSocial = esClienteExistente ? '' : String(d.razon_social || '').trim();
    const documento = esClienteExistente
      ? { tipo_documento: null, numero: null }
      : resolverDocumento(d.tipo_documento, d.ruc);
    if (documento.error) return { error: documento.error };
    data.razon_social = razonSocial || null;
    data.tipo_documento = documento.tipo_documento;
    data.ruc = documento.numero;
  }

  // Referencia comercial informativa. No se toca si el payload no la trae.
  if (requeridos || d.buen_pagador !== undefined) {
    const valor = String(d.buen_pagador || '').trim() || BUEN_PAGADOR_SIN_CALIFICAR;
    if (!esBuenPagadorValido(valor)) {
      return { error: `La referencia de pago debe ser: ${ESTADOS_BUEN_PAGADOR.join(', ')}` };
    }
    data.buen_pagador = valor;
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
//   buen_pagador  — referencia comercial (Buen pagador / No es buen pagador /
//                   Sin calificar)
function construirWhereLeads(query) {
  const { q, id_vendedor, provincia, codigo_ubigeo, id_padre, buen_pagador } = query;
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
  // Tabs por Tipo padre: 'sin' = leads sin subtipo solicitado; un id = subtipos
  // cuyo padre es ese id; ausente/'todos' = sin filtro.
  if (id_padre === 'sin') where.id_tipo_servicio_solicitado = null;
  else if (id_padre) where.tipo_servicio = { is: { id_padre: Number(id_padre) } };
  if (buen_pagador && esBuenPagadorValido(buen_pagador)) where.buen_pagador = buen_pagador;
  return where;
}

const listar = async (req, res) => {
  try {
    // Alcance por usuario: la Vendedora solo ve los leads que tiene asignados.
    const where = conAlcance(construirWhereLeads(req.query), leadAlcanceWhere(req.user));
    const result = await paginar(
      prisma.tbl_leads,
      {
        where,
        orderBy: { id: 'desc' },
        include: {
          cliente: true,
          tipo_servicio: true,
          ubigeo: true,
          tipo_ascensor: { select: { id: true, nombre: true } },
          usuario_registrador: { select: { id: true, nombres: true } },
          vendedor: { select: { id: true, nombres: true } },
          // Solo el CONTADOR de documentos: la tabla pinta un chip con el
          // número y el detalle se pide al abrir el modal.
          _count: COUNT_DOCUMENTOS
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
    // El tipo (padre) + subtipo de servicio es OPCIONAL al crear el lead: en la
    // primera consulta muchas veces todavía no se sabe qué se va a contratar.
    // Se vuelve obligatorio al convertir el lead (POST /:id/convertir).
    // Se persiste el subtipo; el padre se deriva de él (tipo_servicio.id_padre).
    if (d.id_tipo_servicio_solicitado) {
      const subtipo = await prisma.tbl_tipos_servicio.findUnique({ where: { id: Number(d.id_tipo_servicio_solicitado) } });
      if (!subtipo || subtipo.estado !== 1 || subtipo.id_padre == null) {
        return res.status(400).json({ error: 'El subtipo de servicio solicitado no es válido' });
      }
    }
    const comerciales = await resolverCamposComerciales(d, { requeridos: true });
    if (comerciales.error) return res.status(400).json({ error: comerciales.error });
    // Un prospecto ya registrado (como lead o como cliente) no se vuelve a dar
    // de alta: se responde 409 con las coincidencias para que el usuario abra
    // el registro existente en vez de duplicar la cartera.
    const duplicados = await buscarDuplicadosLead({
      telefono: d.telefono,
      nombre: d.nombre_contacto,
      razon_social: comerciales.data.razon_social,
      documento: comerciales.data.ruc
    // Si el lead se declara de un cliente existente, compartir sus datos con
    // ese cliente no es un duplicado: es la vinculación esperada.
    }, { excluirClienteId: d.cliente_existente && d.id_cliente ? Number(d.id_cliente) : null });
    if (duplicados.length > 0) {
      return res.status(409).json({ error: mensajeDuplicados(duplicados), duplicados });
    }
    // Vendedora asignada: determina quién podrá ver y convertir este lead.
    const vendedor = await resolverVendedorAsignado(d.id_vendedor);
    if (vendedor.error) return res.status(400).json({ error: vendedor.error });
    const lead = await prisma.tbl_leads.create({
      data: {
        nombre_contacto: d.nombre_contacto,
        telefono: d.telefono,
        canal: d.canal || null,
        id_tipo_servicio_solicitado: d.id_tipo_servicio_solicitado ? Number(d.id_tipo_servicio_solicitado) : null,
        cliente_existente: d.cliente_existente ? 1 : 0,
        id_cliente: d.id_cliente ? Number(d.id_cliente) : null,
        id_vendedor: vendedor.id_vendedor ?? null,
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
    const acceso = await cargarLeadPermitido(req, id, INCLUDE_EDICION);
    if (acceso.error) return res.status(404).json({ error: acceso.error });
    const previo = acceso.lead;
    const comerciales = await resolverCamposComerciales(d, { requeridos: false });
    if (comerciales.error) return res.status(400).json({ error: comerciales.error });
    // Mismo control que en el alta, pero SOLO sobre los datos que esta edición
    // cambia. Un lead que ya venía coincidiendo con otro registro (la cartera
    // histórica tiene duplicados, y convertir un lead crea un cliente con sus
    // mismos datos) debe poder seguir corrigiéndose en el resto de campos: si
    // se validara todo, esos leads quedarían imposibles de editar.
    const nuevos = {
      telefono: d.telefono ?? previo.telefono,
      nombre: d.nombre_contacto ?? previo.nombre_contacto,
      razon_social: 'razon_social' in comerciales.data ? comerciales.data.razon_social : previo.razon_social,
      documento: 'ruc' in comerciales.data ? comerciales.data.ruc : previo.ruc
    };
    const cambiados = {
      telefono: nuevos.telefono !== previo.telefono ? nuevos.telefono : null,
      nombre: nuevos.nombre !== previo.nombre_contacto ? nuevos.nombre : null,
      razon_social: nuevos.razon_social !== previo.razon_social ? nuevos.razon_social : null,
      documento: nuevos.documento !== previo.ruc ? nuevos.documento : null
    };
    if (Object.values(cambiados).some(Boolean)) {
      const duplicados = await buscarDuplicadosLead(cambiados, {
        excluirLeadId: id,
        excluirClienteId: previo.id_cliente || null
      });
      if (duplicados.length > 0) {
        return res.status(409).json({ error: mensajeDuplicados(duplicados), duplicados });
      }
    }
    // La asignación de vendedora la decide la Central de ventas / administración:
    // la Vendedora conserva la suya (si pudiera cambiarla, se quitaría el lead a
    // sí misma o se lo pasaría a otra sin control).
    const vendedor = soloSusLeads(req.user)
      ? { id_vendedor: previo.id_vendedor }
      : await resolverVendedorAsignado(d.id_vendedor, previo.id_vendedor);
    if (vendedor.error) return res.status(400).json({ error: vendedor.error });

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
      // `omitido` = el payload no trae el campo (update parcial): se conserva.
      id_vendedor: vendedor.omitido ? previo.id_vendedor : (vendedor.id_vendedor ?? null),
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
    // Solo la Vendedora asignada convierte su lead (administración ve todos).
    const acceso = await cargarLeadPermitido(req, id, { ubigeo: true, tipo_ascensor: { select: { nombre: true } } });
    if (acceso.error) return res.status(404).json({ error: acceso.error });
    const lead = acceso.lead;
    if (lead.estado_lead === ESTADO_LEAD_DESCARTADO) {
      return res.status(400).json({ error: 'El lead está descartado; reactívalo antes de convertirlo' });
    }
    if (!d.id_cliente || !d.id_ascensor || !d.id_tipo_servicio || !d.fecha_programada) {
      return res.status(400).json({ error: 'Faltan datos para convertir (cliente, ascensor, subtipo, fecha)' });
    }
    // El precio es opcional: los roles sin visibilidad financiera (Vendedora,
    // Coordinador) no manejan precios. Si no llega —o llega desde un rol que no
    // puede fijarlo— el servicio se crea con 0 y lo completa luego un rol con
    // visibilidad de precios.
    const precioInterno = (!puedeVerFinanzasReq(req)
      || d.precio_interno === undefined || d.precio_interno === null || d.precio_interno === '')
      ? 0
      : d.precio_interno;

    // El tipo recibido es un SUBTIPO; se clasifica (SSoT) para derivar
    // tipo_registro y el módulo operativo destino.
    const subtipoLead = await prisma.tbl_tipos_servicio.findUnique({
      where: { id: Number(d.id_tipo_servicio) }, include: { padre: true }
    });
    if (!subtipoLead || subtipoLead.estado !== 1 || subtipoLead.id_padre == null) {
      return res.status(400).json({ error: 'Debe seleccionar un subtipo de servicio válido.' });
    }
    let clasifLead;
    try { clasifLead = clasificarTipoServicio(subtipoLead); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const codigo = await generarCodigoServicio(clasifLead.tipo_registro);
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
    const servicio = await prisma.$transaction(async (tx) => {
      // Contacto en sitio y cuarto de máquinas heredados de la ficha del ascensor.
      const datosSitio = await datosSitioParaServicio(tx, [d.id_ascensor], d);
      const s = await tx.tbl_servicios_proyectos.create({
        data: {
          codigo,
          // tipo_registro derivado del subtipo (SSoT), no del body.
          tipo_registro: clasifLead.tipo_registro,
          id_tipo_servicio: Number(d.id_tipo_servicio),
          id_cliente: Number(d.id_cliente),
          origen: 'lead',
          titulo: d.titulo || lead.nombre_proyecto || `Servicio desde lead ${lead.nombre_contacto}`,
          descripcion,
          fecha_programada: parseYMDLima(d.fecha_programada),
          hora_programada: d.hora_programada || null,
          prioridad: d.prioridad || 'media',
          precio_interno: precioInterno,
          moneda,
          observaciones: d.observaciones || null,
          ...datosSitio,
          user_id_registration: req.user.id,
          ascensores: {
            create: [{
              id_ascensor: Number(d.id_ascensor),
              monto: precioInterno,
              moneda,
              user_id_registration: req.user.id
            }]
          }
        }
      });
      // Asignación opcional del técnico responsable hecha en la conversión: se
      // registra como responsable principal del servicio recién creado.
      if (d.id_tecnico) {
        await tx.tbl_servicios_asignaciones.create({
          data: {
            id_servicio: s.id,
            id_tecnico: Number(d.id_tecnico),
            rol_asignacion: 'Responsable',
            responsable_principal: 1,
            asignado_por: req.user.id,
            user_id_registration: req.user.id
          }
        });
      }
      // Si el subtipo pertenece a un módulo operativo, crear su fila/plan para que
      // el servicio sea visible en Emergencias/Correctivos/Mantenimientos.
      // atencion_rapida se omite: es punto de captura inicial, no resultado de la
      // conversión, y replicarEnModulo exigiría contacto (nombre/teléfono) que el
      // lead no aporta (mismo criterio que cotizacionesController y atencionesRapidasController).
      if (clasifLead.modulo_asociado && clasifLead.modulo_asociado !== 'atencion_rapida') {
        await replicarEnModulo(tx, {
          servicio: s,
          tipoServicio: subtipoLead,
          idsAscensores: [Number(d.id_ascensor)],
          idCliente: Number(d.id_cliente),
          horaProgramada: d.hora_programada || null,
          fechaProgramada: parseYMDLima(d.fecha_programada),
          usuarioId: req.user.id,
          datosModulo: { motivo: descripcion, falla: descripcion, nivel_urgencia: d.prioridad },
          origenEtiqueta: `conversión de lead #${id}`
        });
      }
      return s;
    });

    // Registrar el evento en el calendario, igual que el alta normal de servicios,
    // para que el servicio convertido figure en el calendario operativo.
    const tipoEventoLead = clasifLead.tipo_registro === 'proyecto' ? 'proyecto' : 'servicio';
    await prisma.tbl_calendario_eventos.create({
      data: {
        id_servicio: servicio.id,
        titulo: `${servicio.codigo} – ${servicio.titulo}`,
        tipo_evento: tipoEventoLead,
        fecha_inicio: combinarFechaHoraLima(d.fecha_programada, d.hora_programada),
        estado_evento: ESTADO_EVENTO_PROGRAMADO,
        color: colorPorTipo(tipoEventoLead)
      }
    });
    sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync recordatorio:', err));

    // Los documentos libres del lead (tbl_leads_archivos) NO se copian ni se
    // mueven al cliente/servicio: son el expediente comercial del prospecto y
    // se quedan en el lead, que sigue consultable con estado "Ingresado".
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
    const acceso = await cargarLeadPermitido(req, id);
    if (acceso.error) return res.status(404).json({ error: acceso.error });
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
    const acceso = await cargarLeadPermitido(req, id);
    if (acceso.error) return res.status(404).json({ error: acceso.error });
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

    const acceso = await cargarLeadPermitido(req, id);
    if (acceso.error) return res.status(404).json({ error: acceso.error });
    const lead = acceso.lead;
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

// --- Documentos libres del lead -------------------------------------------
// Expediente comercial del prospecto: la Central de ventas sube cualquier
// documento (PDF, imágenes, videos, Office…) y la Vendedora asignada los
// consulta desde su lead. Al convertir el lead NO se copian ni se mueven: se
// quedan aquí (ver `convertir`). Las reglas viven en utils/documentosLead.

const listarDocumentos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const acceso = await cargarLeadPermitido(req, id);
    if (acceso.error) return res.status(404).json({ error: acceso.error });
    const data = await prisma.tbl_leads_archivos.findMany({
      ...INCLUDE_DOCUMENTOS,
      where: { ...INCLUDE_DOCUMENTOS.where, id_lead: id }
    });
    res.json({
      data,
      meta: { max: MAX_DOCUMENTOS, puede_gestionar: puedeGestionarDocumentos(req.user) }
    });
  } catch (err) {
    console.error('[leads.listarDocumentos]', err);
    res.status(500).json({ error: 'Error al listar los documentos del lead' });
  }
};

const agregarDocumentos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const acceso = await cargarLeadPermitido(req, id);
    if (acceso.error) return res.status(404).json({ error: acceso.error });
    if (acceso.lead.estado_lead === ESTADO_LEAD_DESCARTADO) {
      return res.status(400).json({ error: 'El lead está descartado; reactívalo antes de adjuntar documentos' });
    }

    const creados = await vincularDocumentosEnTx(prisma, id, req.body?.documentos, req.user.id);
    if (creados === 0) return res.status(400).json({ error: 'No se recibió ningún archivo válido' });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_leads_archivos', id_entidad: id,
      accion: 'CREATE', valor_nuevo: { id_lead: id, documentos: creados }, ip: req.ip
    });

    const data = await prisma.tbl_leads_archivos.findMany({
      ...INCLUDE_DOCUMENTOS,
      where: { ...INCLUDE_DOCUMENTOS.where, id_lead: id }
    });
    res.status(201).json({ data });
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error('[leads.agregarDocumentos]', err);
    res.status(500).json({ error: 'Error al adjuntar los documentos' });
  }
};

const eliminarDocumento = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const idVinculo = Number(req.params.idVinculo);
    const acceso = await cargarLeadPermitido(req, id);
    if (acceso.error) return res.status(404).json({ error: acceso.error });

    const vinculo = await prisma.tbl_leads_archivos.findFirst({
      where: { id: idVinculo, id_lead: id, estado: 1 },
      include: { archivo: { select: { id: true, ruta_almacenamiento: true } } }
    });
    if (!vinculo) return res.status(404).json({ error: 'Documento no encontrado' });

    const marca = { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() };
    await prisma.$transaction(async (tx) => {
      await tx.tbl_leads_archivos.update({ where: { id: idVinculo }, data: marca });
      await tx.tbl_archivos.updateMany({ where: { id: vinculo.id_archivo, estado: 1 }, data: marca });
    });

    // Purga del bucket TRAS el commit: si falla, el registro ya quedó dado de
    // baja y el objeto se limpia después — nunca al revés.
    const key = keyDocumento(vinculo.archivo);
    if (key) {
      try { await eliminarObjeto(key); }
      catch (e) { console.warn('[leads.eliminarDocumento] no se pudo borrar del bucket:', e.message); }
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_leads_archivos', id_entidad: idVinculo,
      accion: 'DELETE', valor_anterior: vinculo, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[leads.eliminarDocumento]', err);
    res.status(500).json({ error: 'Error al eliminar el documento' });
  }
};

// Vendedores que realmente figuran en algún lead, para poblar el filtro de la
// lista. Se deriva de los datos (no de /usuarios, que es solo super_admin) para
// que admin y coordinador también puedan filtrar por vendedor.
const listarVendedores = async (req, res) => {
  try {
    const ids = await prisma.tbl_leads.findMany({
      // Mismo alcance que la lista: una Vendedora solo se ve a sí misma.
      where: conAlcance({ estado: 1, id_vendedor: { not: null } }, leadAlcanceWhere(req.user)),
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

/**
 * Verificación de duplicados EN VIVO para el formulario de leads: devuelve las
 * coincidencias de teléfono / nombre / documento contra la cartera de leads y
 * de clientes, sin crear nada. El alta y la edición vuelven a comprobarlo por
 * su cuenta: esto es solo para avisar mientras se escribe.
 */
const verificarDuplicados = async (req, res) => {
  try {
    const { telefono, nombre, razon_social, documento, excluir_id } = req.query;
    const duplicados = await buscarDuplicadosLead(
      { telefono, nombre, razon_social, documento },
      { excluirLeadId: excluir_id ? Number(excluir_id) : null }
    );
    res.json({ data: duplicados });
  } catch (err) {
    console.error('[leads.verificarDuplicados]', err);
    res.status(500).json({ error: 'Error al verificar duplicados' });
  }
};

/**
 * Personas a las que se puede ASIGNAR un lead: usuarios activos cuyo rol puede
 * trabajarlo y convertirlo (ver ROLES_ASIGNABLES_LEAD). Vive en el módulo de
 * leads —y no en /usuarios— porque la Central de ventas es un rol confinado a
 * este módulo, y porque el selector debe seguir el criterio del negocio, no el
 * catálogo genérico de usuarios.
 */
const listarAsignables = async (_req, res) => {
  try {
    const usuarios = await prisma.tbl_usuarios.findMany({
      where: { estado: 1, rol: { is: { codigo: { in: ROLES_ASIGNABLES_LEAD } } } },
      select: { id: true, nombres: true, rol: { select: { codigo: true, nombre: true } } },
      orderBy: { nombres: 'asc' }
    });
    res.json({
      data: usuarios.map(u => ({ id: u.id, nombres: u.nombres.trim(), rol: u.rol?.nombre || null }))
    });
  } catch (err) {
    console.error('[leads.listarAsignables]', err);
    res.status(500).json({ error: 'Error al listar las vendedoras asignables' });
  }
};

module.exports = {
  listar, crear, actualizar, historial, convertir, cambiarEstado,
  verificarDuplicados, listarAsignables,
  listarCotizaciones, subirCotizacion,
  listarDocumentos, agregarDocumentos, eliminarDocumento,
  listarVendedores
};

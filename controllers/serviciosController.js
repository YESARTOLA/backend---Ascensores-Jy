const prisma = require('../config/prisma');
const { ESTADO_EVENTO_FINALIZADO, ESTADO_EVENTO_CANCELADO } = require('../utils/estadoEvento');
const { registrarAuditoria } = require('../utils/auditoria');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const {
  cambiarEstadoServicio,
  esServicioEditable,
  esServicioPostRevision,
  estaServicioFinalizado,
  ESTADO_SERVICIO_FINALIZADO_TECNICO,
  ESTADO_SERVICIO_FINALIZADO_OBSERVADO,
  ESTADO_ADMIN_REVISADO,
  ESTADO_ADMIN_OBSERVADO,
  ESTADO_ADMIN_RECHAZADO,
  RESULTADO_REVISION
} = require('../utils/estadoServicio');
const {
  ESTADO_GUIA_ADJUNTA,
  ESTADO_GUIA_OBSERVADA,
  estadoGuiaSegunArchivo,
  esEstadoGuiaValido
} = require('../utils/estadoGuia');
const {
  ESTADO_FACTURA_ANULADA,
  ESTADO_FACTURACION_SIN,
  calcularEstadoFacturacion
} = require('../utils/estadoFactura');
const { combinarFechaHoraLima, parseYMDLima, parseYMDFinDiaLima, parseYMDUTC } = require('../utils/tiempo');
const { crearCobroInicial } = require('../utils/crearCobroInicial');
const {
  sincronizarRecordatorioServicio,
  sincronizarRecordatorioRevisarServicio,
  sincronizarRecordatorioFacturarServicio,
  sincronizarRecordatorioAvisoFinalizacion
} = require('../utils/recordatoriosAuto');
const {
  sincronizarDiasYEventos,
  diasSinEvidencia,
  ConfirmacionRequeridaError
} = require('../utils/diasServicio');
const { paginar } = require('../utils/paginacion');
const { validarConsistenciaAsignaciones } = require('../utils/asignacionesValidaciones');
const { replicarEnModulo } = require('../utils/replicarEnModulo');
const { clasificarTipoServicio } = require('../utils/clasificacionServicio');
const { aplicaAlcance, aplicaAlcanceEdificio, tiposRegistroPermitidos, tiposEdificioPermitidos, porJunctionAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');
const { visibilidadPorJunctionWhere, aplicarVisibilidadWhere, servicioVisiblePorEdificio } = require('../utils/visibilidadEdificio');
const { materializarSiguienteEventoDelPlan } = require('./mantenimientosController');
const { _recalcEstadoChecklist } = require('./checklistController');
const { validarAscensores, repartirParejo } = require('../utils/ascensoresMonto');
const { ensureChecklistFinalizacion } = require('./checklistFinalizacionController');

/**
 * Resuelve la lista de ascensores de un proyecto a ids concretos, dentro de una
 * transacción. Cada entrada es un ascensor EXISTENTE ({ id_ascensor }) o uno
 * NUEVO a instalar ({ ascensor_nuevo: { id_edificio, ... } }), que se crea con
 * estado 'Por instalar'. Homogeneiza la creación directa de proyectos con el
 * flujo de aprobación de cotización. Lanza Error (mensaje al usuario) si algo no
 * valida (ascensor ajeno al cliente, edificio inválido, instalación cancelada…).
 */
async function resolverAscensoresProyectoEnTx(tx, ascensores, idCliente, userId) {
  if (!Array.isArray(ascensores) || ascensores.length === 0) {
    throw new Error('Debe indicar al menos un ascensor');
  }
  const ids = [];
  let totalAscensoresCliente = await tx.tbl_ascensores.count({
    where: { edificio: { is: { id_cliente: Number(idCliente) } } }
  });
  for (const fila of ascensores) {
    if (fila?.id_ascensor) {
      const idAsc = Number(fila.id_ascensor);
      if (ids.includes(idAsc)) throw new Error('No se puede repetir un mismo ascensor');
      const asc = await tx.tbl_ascensores.findFirst({
        where: { id: idAsc, estado: 1 },
        include: { edificio: { select: { id_cliente: true } } }
      });
      if (!asc) throw new Error('Uno o más ascensores no existen o están inactivos');
      if (asc.edificio?.id_cliente !== Number(idCliente)) {
        throw new Error(`El ascensor ${asc.codigo} no pertenece al cliente seleccionado`);
      }
      if (asc.estado_operativo === 'Instalación cancelada') {
        throw new Error(`El ascensor ${asc.codigo} tiene la instalación cancelada y no admite servicios`);
      }
      ids.push(idAsc);
      continue;
    }
    // Ascensor nuevo a instalar: se crea en un edificio del cliente, 'Por instalar'.
    const datos = fila?.ascensor_nuevo;
    if (!datos || !datos.id_edificio) throw new Error('Cada ascensor nuevo debe indicar su edificio');
    const edif = await tx.tbl_edificios.findFirst({
      where: { id: Number(datos.id_edificio), id_cliente: Number(idCliente) }
    });
    if (!edif) throw new Error('El edificio del ascensor nuevo no pertenece al cliente');
    totalAscensoresCliente += 1;
    const codigoAsc = `ASC-${idCliente}-${String(totalAscensoresCliente).padStart(3, '0')}-${Date.now().toString().slice(-4)}`;
    const nuevo = await tx.tbl_ascensores.create({
      data: {
        id_edificio: Number(datos.id_edificio),
        codigo: codigoAsc,
        ubicacion: datos.ubicacion || null,
        tipo: datos.tipo || null,
        marca: datos.marca || null,
        modelo: datos.modelo || null,
        capacidad: datos.capacidad || null,
        pisos: datos.pisos ? Number(datos.pisos) : null,
        anio_aproximado: datos.anio_aproximado ? Number(datos.anio_aproximado) : null,
        estado_operativo: 'Por instalar',
        observaciones: datos.descripcion || null,
        user_id_registration: userId
      }
    });
    ids.push(nuevo.id);
  }
  return ids;
}

const ROLES_PRECIO = ['super_admin', 'admin', 'contabilidad'];

function sanitizarPrecio(servicio, rolCodigo) {
  if (!servicio) return servicio;
  if (ROLES_PRECIO.includes(rolCodigo)) return servicio;
  const clon = { ...servicio };
  clon.precio_interno = null;
  if (Array.isArray(clon.ascensores)) {
    clon.ascensores = clon.ascensores.map(a => ({ ...a, monto: null }));
  }
  // Ítems de la cotización de origen: ocultar precios a roles sin permiso (técnicos).
  if (clon.cotizacion && Array.isArray(clon.cotizacion.versiones)) {
    clon.cotizacion = {
      ...clon.cotizacion,
      versiones: clon.cotizacion.versiones.map(v => ({
        ...v,
        monto_total: null,
        items: Array.isArray(v.items)
          ? v.items.map(it => ({ ...it, precio_unitario: null, descuento_porcentaje: null, importe: null }))
          : v.items
      }))
    };
  }
  return clon;
}

/**
 * Para el rol técnico, retira del detalle todo bloque económico (cobros y
 * facturas, con sus montos, pagos y cuotas). Complementa a `sanitizarPrecio`
 * (que solo anula precio_interno/monto): el técnico únicamente ve la información
 * operativa de sus servicios/proyectos asignados, nada económico.
 */
function sanitizarEconomicoTecnico(servicio, rolCodigo) {
  if (!servicio || rolCodigo !== 'tecnico') return servicio;
  const clon = { ...servicio };
  delete clon.cobro;
  delete clon.facturas;
  return clon;
}


const listar = async (req, res) => {
  try {
    const { q, estado_servicio, estados, prioridad, id_cliente, id_ascensor, tipo_registro, id_tipo_servicio, origen, id_tecnico, desde, hasta } = req.query;
    const where = { estado: 1 };
    if (q) where.OR = [
      // Código y título del servicio
      { codigo: { contains: q, mode: 'insensitive' } },
      { titulo: { contains: q, mode: 'insensitive' } },
      // Cliente
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      // Ascensores asociados: código y tipo (Pasajeros / Camillero / Carga)
      { ascensores: { some: { estado: 1, ascensor: { codigo: { contains: q, mode: 'insensitive' } } } } },
      { ascensores: { some: { estado: 1, ascensor: { tipo: { contains: q, mode: 'insensitive' } } } } },
      // Edificio / obra del ascensor asociado
      { ascensores: { some: { estado: 1, ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } } } },
      // Código de la cotización origen (si fue aprobada)
      { cotizacion: { codigo: { contains: q, mode: 'insensitive' } } }
    ];
    // `estados` (lista separada por comas) tiene prioridad sobre `estado_servicio`
    // (valor único). Permite a la vista de Asignaciones pedir el conjunto de
    // estados "en gestión" sin traerse todo y filtrar en cliente.
    const estadosLista = (estados ? String(estados).split(',') : [])
      .map(s => s.trim()).filter(Boolean);
    if (estadosLista.length > 0) where.estado_servicio = { in: estadosLista };
    else if (estado_servicio) where.estado_servicio = estado_servicio;
    if (prioridad) where.prioridad = prioridad;
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_ascensor) where.ascensores = { some: { id_ascensor: Number(id_ascensor), estado: 1 } };
    // Ámbito del usuario: acota el tipo_registro visible. Si pide uno fuera de su
    // ámbito, no devuelve nada; si no pide ninguno, se limita a los permitidos.
    const tiposPermitidos = tiposRegistroPermitidos(req.user);
    if (tipo_registro) {
      where.tipo_registro = (tiposPermitidos && !tiposPermitidos.includes(tipo_registro))
        ? '__sin_ambito__'
        : tipo_registro;
    } else if (tiposPermitidos) {
      where.tipo_registro = { in: tiposPermitidos.length ? tiposPermitidos : ['__sin_ambito__'] };
    }
    if (id_tipo_servicio) where.id_tipo_servicio = Number(id_tipo_servicio);
    if (origen) where.origen = origen;
    if (desde || hasta) {
      // fecha_programada es @db.Date (medianoche UTC): los límites deben ir en
      // medianoche UTC, no en Lima, o el borde superior arrastra el día siguiente.
      where.fecha_programada = {};
      if (desde) where.fecha_programada.gte = parseYMDUTC(desde);
      if (hasta) where.fecha_programada.lte = parseYMDUTC(hasta);
    }

    // Si el rol es tecnico, solo ve servicios donde está asignado
    if (req.user.rol_codigo === 'tecnico') {
      where.asignaciones = { some: { id_tecnico: req.user.id_tecnico || -1, estado: 1 } };
    } else if (id_tecnico) {
      where.asignaciones = { some: { id_tecnico: Number(id_tecnico), estado: 1 } };
    }

    // Oculta a roles distintos de super_admin lo asociado a edificios inactivos.
    aplicarVisibilidadWhere(where, visibilidadPorJunctionWhere(req.user));
    // Alcance por tipo de edificio (Administrador acotado a Edificios u Obras).
    conAlcance(where, porJunctionAscensorEdificioWhere(req.user));

    const result = await paginar(
      prisma.tbl_servicios_proyectos,
      {
        where, orderBy: { id: 'desc' },
        include: {
          cliente: { select: { id: true, nombre: true, telefono: true, whatsapp: true } },
          ascensores: { where: { estado: 1 }, include: { ascensor: { select: { id: true, codigo: true, ubicacion: true, edificio: { select: { id: true, nombre: true, tipo: true, distrito: true, direccion: true } } } } } },
          tipo_servicio: true,
          asignaciones: { where: { estado: 1 }, include: { tecnico: true } }
        }
      },
      req.query
    );
    res.json({ ...result, data: result.data.map(s => sanitizarPrecio(s, req.user.rol_codigo)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar servicios' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      include: {
        cliente: true,
        ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: true } } }, orderBy: { id: 'asc' } },
        tipo_servicio: true,
        cotizacion: {
          select: {
            id: true,
            codigo: true,
            estado_global: true,
            version_activa: true,
            // Versiones con sus ítems (y la foto de cada ítem) para mostrar la
            // lista de ítems en la página del servicio. Los precios se ocultan a
            // los técnicos vía sanitizarPrecio().
            versiones: {
              where: { estado: 1 },
              select: {
                numero_version: true, estado_version: true, monto_total: true, moneda: true, sin_igv: true,
                items: {
                  where: { estado: 1 }, orderBy: { orden: 'asc' },
                  select: {
                    id: true, orden: true, descripcion: true, cantidad: true, unidad: true,
                    precio_unitario: true, descuento_porcentaje: true, importe: true,
                    archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } }
                  }
                }
              }
            }
          }
        },
        mantenimiento_plan: {
          select: {
            id: true,
            tipo_plan: true,
            frecuencia: true,
            frecuencia_dias_custom: true,
            cantidad_mantenimientos: true,
            cantidad_mantenimientos_gratuitos: true,
            fecha_inicio: true,
            estado_plan: true,
            tipo_servicio: { select: { id: true, nombre: true, modulo_asociado: true } }
          }
        },
        emergencia: { select: { id: true, id_ascensor: true, motivo: true, nivel_urgencia: true, estado_emergencia: true, fecha_reporte: true } },
        correctivo: { select: { id: true, id_ascensor: true, falla: true, nivel_urgencia: true, estado_correctivo: true, fecha_reporte: true } },
        asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
        dias: { where: { estado: 1 }, orderBy: { orden: 'asc' } },
        checklists: { include: { items: { where: { estado: 1 } } } },
        guias: { include: { archivo: true, tecnico: true } },
        evidencias: { where: { estado: 1 }, include: { archivo: true, tecnico: true } },
        entregas: { include: { archivo: true } },
        cobro: { include: { pagos: { where: { estado: 1 }, include: { archivo: true } }, cuotas: { where: { estado: 1 } } } },
        facturas: { include: { archivo: true } },
        historial_estados: { orderBy: { fecha_cambio: 'desc' } },
        servicio_realizado: { include: { archivo_ot: true } },
        finalizacion_checklist: { include: { archivo_pdf: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } } } }
      }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    // Ámbito: un servicio/proyecto fuera del ámbito no es accesible ni por URL.
    if (aplicaAlcance(req.user)) {
      const permitidos = tiposRegistroPermitidos(req.user);
      if (!permitidos.includes(servicio.tipo_registro)) {
        return res.status(404).json({ error: 'Servicio no encontrado' });
      }
    }
    // Un servicio/proyecto de un edificio inactivo no es accesible (salvo super_admin).
    if (!servicioVisiblePorEdificio(req.user, servicio)) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }
    // Alcance por tipo de edificio: el Administrador acotado no accede a un
    // servicio cuyos ascensores no estén en un tipo permitido (ni por URL).
    const tiposEdif = tiposEdificioPermitidos(req.user);
    if (tiposEdif) {
      const vinculos = (servicio.ascensores || []).filter(sa => sa.estado === 1);
      if (vinculos.length > 0 && !vinculos.some(sa => tiposEdif.includes(sa.ascensor?.edificio?.tipo))) {
        return res.status(404).json({ error: 'Servicio no encontrado' });
      }
    }
    // Un técnico solo accede al detalle de servicios/proyectos donde está
    // asignado (igual que la lista). Sin esto podría abrir cualquiera por URL.
    if (req.user.rol_codigo === 'tecnico') {
      const asignado = (servicio.asignaciones || []).some(a => a.id_tecnico === req.user.id_tecnico);
      if (!asignado) return res.status(404).json({ error: 'Servicio no encontrado' });
    }
    const data = sanitizarEconomicoTecnico(
      sanitizarPrecio(servicio, req.user.rol_codigo),
      req.user.rol_codigo
    );
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener servicio' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_cliente || !d.id_tipo_servicio || !d.fecha_programada) {
      return res.status(400).json({ error: 'Cliente, tipo y fecha son obligatorios' });
    }
    if (!ROLES_PRECIO.includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'Rol no autorizado para crear servicios con precio' });
    }
    // Precio GLOBAL del proyecto (lo pone el usuario). Cubre a uno o varios
    // ascensores; el precio se reparte parejo entre ellos (homogéneo con la
    // aprobación de cotización). Ya no se compone por precio de catálogo.
    const precioProyecto = Number(d.precio_interno);
    if (!Number.isFinite(precioProyecto) || precioProyecto < 0) {
      return res.status(400).json({ error: 'El precio del proyecto es obligatorio' });
    }
    if (!Array.isArray(d.ascensores) || d.ascensores.length === 0) {
      return res.status(400).json({ error: 'Debe indicar al menos un ascensor' });
    }
    const monedaProyecto = d.moneda || 'PEN';

    const esBorrador = d.es_borrador === true || d.es_borrador === 1 || d.estado_servicio === 'Borrador';
    const estadoInicial = esBorrador ? 'Borrador' : 'Pendiente';

    // El tipo recibido es un SUBTIPO. Se carga con su padre para clasificarlo
    // (SSoT): el padre define si es Proyecto o Servicio (tipo_registro) y, si es
    // Servicio, el módulo operativo donde se replica (Emergencias / Correctivos /
    // Mantenimientos / Atención Rápida).
    const tipoServicio = await prisma.tbl_tipos_servicio.findUnique({
      where: { id: Number(d.id_tipo_servicio) },
      include: { padre: true }
    });
    if (!tipoServicio) return res.status(400).json({ error: 'Tipo de servicio inválido' });
    if (tipoServicio.id_padre == null) {
      return res.status(400).json({ error: 'Debe seleccionar un subtipo de servicio, no un tipo padre.' });
    }

    let clasificacion;
    try { clasificacion = clasificarTipoServicio(tipoServicio); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // tipo_registro (servicio/proyecto) y origen se DERIVAN del subtipo, nunca del
    // body, para garantizar una sola fuente de verdad.
    const tipoRegistro = clasificacion.tipo_registro;
    const origenDerivado = clasificacion.modulo_asociado || 'directo';

    // Duración en días (consecutivos desde la fecha programada). Default 1.
    const duracionDias = Math.max(1, parseInt(d.duracion_dias, 10) || 1);

    // Ámbito: un usuario acotado no puede crear registros fuera de su ámbito.
    const permitidosCrear = tiposRegistroPermitidos(req.user);
    if (permitidosCrear && !permitidosCrear.includes(tipoRegistro)) {
      return res.status(403).json({ error: 'No tiene acceso para crear registros de este ámbito' });
    }

    const codigo = await generarCodigoServicio(tipoRegistro);
    let idsAscensores = [];
    let servicio;
    try {
      servicio = await prisma.$transaction(async (tx) => {
        // Resolver ascensores (existentes y/o nuevos a instalar) e igualar el
        // reparto del precio global entre todos ellos.
        idsAscensores = await resolverAscensoresProyectoEnTx(tx, d.ascensores, d.id_cliente, req.user.id);
        const montos = repartirParejo(precioProyecto, idsAscensores.length);
        const s = await tx.tbl_servicios_proyectos.create({
          data: {
            codigo,
            tipo_registro: tipoRegistro,
            id_tipo_servicio: Number(d.id_tipo_servicio),
            id_cliente: Number(d.id_cliente),
            origen: origenDerivado,
            titulo: d.titulo || `Servicio ${codigo}`,
            descripcion: d.descripcion || null,
            fecha_programada: parseYMDLima(d.fecha_programada),
            hora_programada: d.hora_programada || null,
            duracion_dias: duracionDias,
            fecha_estimada_entrega: d.fecha_estimada_entrega ? parseYMDLima(d.fecha_estimada_entrega) : null,
            prioridad: d.prioridad || 'media',
            estado_servicio: estadoInicial,
            precio_interno: precioProyecto,
            moneda: monedaProyecto,
            sin_cobro: d.sin_cobro ? 1 : 0,
            observaciones: d.observaciones || null,
            user_id_registration: req.user.id,
            ascensores: {
              create: idsAscensores.map((idAsc, i) => ({
                id_ascensor: idAsc,
                monto: montos[i],
                moneda: monedaProyecto,
                user_id_registration: req.user.id
              }))
            }
          }
        });

        // Replicar en el módulo operativo (no-op si tipo no tiene módulo asociado).
        await replicarEnModulo(tx, {
          servicio: s,
          tipoServicio,
          idsAscensores,
          idCliente: Number(d.id_cliente),
          horaProgramada: d.hora_programada || null,
          fechaProgramada: parseYMDLima(d.fecha_programada),
          usuarioId: req.user.id,
          datosModulo: d,
          origenEtiqueta: `servicio ${codigo}`
        });

        return s;
      });
    } catch (e) {
      // Errores de validación de ascensores → 400 (mensaje al usuario). Los
      // errores de Prisma (con .code) se tratan como 500 en el catch externo.
      if (e.code) throw e;
      return res.status(400).json({ error: e.message || 'No se pudo crear el proyecto' });
    }

    // Solo registrar en calendario, historiales y notificar a otros módulos si NO es borrador.
    // Los borradores quedan invisibles para todos los flujos operativos hasta promoverse.
    if (!esBorrador) {
      // Genera la grilla de días (1..N) y un evento de calendario por día.
      await sincronizarDiasYEventos(prisma, servicio.id, { userId: req.user.id });
      sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync recordatorio:', err));

      await prisma.tbl_clientes_historial.create({
        data: {
          id_cliente: servicio.id_cliente, id_servicio: servicio.id,
          tipo_evento: 'servicio_creado',
          descripcion: `Servicio ${servicio.codigo} creado`,
          creado_por: req.user.id
        }
      });
      for (const idAsc of idsAscensores) {
        await prisma.tbl_ascensores_historial.create({
          data: {
            id_ascensor: idAsc, id_servicio: servicio.id,
            tipo_evento: 'servicio_creado',
            descripcion: `Servicio ${servicio.codigo} creado`,
            creado_por: req.user.id
          }
        });
      }
    }

    await prisma.tbl_servicios_estados_historial.create({
      data: { id_servicio: servicio.id, estado_anterior: null, estado_nuevo: estadoInicial, cambiado_por: req.user.id }
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: servicio.id,
      accion: 'CREATE', valor_nuevo: servicio, ip: req.ip
    });
    res.status(201).json({ data: servicio });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear servicio: ' + err.message });
  }
};

/**
 * Promueve un borrador a estado Pendiente, generando evento de calendario e historiales.
 */
const promoverBorrador = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      include: { ascensores: { where: { estado: 1 } } }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (servicio.estado_servicio !== 'Borrador') {
      return res.status(400).json({ error: 'Solo se pueden promover servicios en Borrador' });
    }
    // cambiarEstadoServicio registra historial, recordatorio y sincroniza
    // estado_global de la cotización (si la hay).
    await cambiarEstadoServicio(id, 'Pendiente', req.user.id);
    // Genera la grilla de días y sus eventos de calendario al salir de borrador.
    await sincronizarDiasYEventos(prisma, servicio.id, { userId: req.user.id });
    await prisma.tbl_clientes_historial.create({
      data: {
        id_cliente: servicio.id_cliente, id_servicio: servicio.id,
        tipo_evento: 'servicio_creado',
        descripcion: `Servicio ${servicio.codigo} promovido desde borrador`,
        creado_por: req.user.id
      }
    });
    for (const sa of servicio.ascensores) {
      await prisma.tbl_ascensores_historial.create({
        data: {
          id_ascensor: sa.id_ascensor, id_servicio: servicio.id,
          tipo_evento: 'servicio_creado',
          descripcion: `Servicio ${servicio.codigo} promovido desde borrador`,
          creado_por: req.user.id
        }
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al promover borrador' });
  }
};

/**
 * Revisión administrativa de un servicio operativo finalizado por el técnico.
 *
 * Resultado posible (body.resultado): 'aprobado' | 'observado' | 'rechazado'.
 *  - APROBADO  → estado_administrativo = 'Revisado'; HABILITA gestión contable
 *                (transición a 'A gestión de cobro' / 'Cobrado total'). Es la
 *                única vía por la que un servicio operativo llega a Contabilidad.
 *  - OBSERVADO → estado_administrativo = 'Observado'; devuelve el servicio a
 *                'En curso' para que el técnico corrija y vuelva a finalizar.
 *                NO habilita Contabilidad.
 *  - RECHAZADO → estado_administrativo = 'Rechazado'; igual devolución a 'En
 *                curso', sin habilitación contable.
 *
 * En los tres casos se guarda la trazabilidad (revisado_por, fecha_revision,
 * resultado_revision, observacion_revision). Observado/Rechazado exigen motivo.
 */
const revisarServicio = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { observaciones } = req.body;
    const resultado = String(req.body.resultado || RESULTADO_REVISION.APROBADO).toLowerCase();
    if (!['super_admin', 'admin', 'contabilidad'].includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'Solo Admin o Contabilidad pueden revisar' });
    }
    if (!Object.values(RESULTADO_REVISION).includes(resultado)) {
      return res.status(400).json({ error: `Resultado inválido. Use: ${Object.values(RESULTADO_REVISION).join(', ')}` });
    }
    const esRechazoUObservacion = resultado !== RESULTADO_REVISION.APROBADO;
    if (esRechazoUObservacion && !String(observaciones || '').trim()) {
      return res.status(400).json({ error: 'Debe indicar el motivo al observar o rechazar' });
    }
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id }, include: { servicio_realizado: true, cobro: true }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (servicio.estado_servicio !== 'En revisión administrativa') {
      return res.status(400).json({ error: 'El servicio no está en revisión administrativa' });
    }

    const trazaRevision = {
      revisado_por: req.user.id,
      fecha_revision: new Date(),
      resultado_revision: resultado,
      observacion_revision: observaciones || null,
      user_id_modification: req.user.id,
      date_time_modification: new Date()
    };

    // OBSERVADO / RECHAZADO: devolver a corrección, sin habilitar Contabilidad.
    if (esRechazoUObservacion) {
      const estadoAdmin = resultado === RESULTADO_REVISION.OBSERVADO ? ESTADO_ADMIN_OBSERVADO : ESTADO_ADMIN_RECHAZADO;
      await prisma.tbl_servicios_realizados.updateMany({
        where: { id_servicio: id },
        data: { estado_administrativo: estadoAdmin, ...trazaRevision }
      });
      // Regresa al flujo operativo para que el técnico corrija y re-finalice.
      await cambiarEstadoServicio(id, 'En curso', req.user.id, `Revisión ${estadoAdmin.toLowerCase()}: ${observaciones}`);
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
        accion: 'REVIEW', valor_nuevo: { resultado, estado_administrativo: estadoAdmin }, ip: req.ip
      });
      return res.json({ ok: true, resultado, estado_administrativo: estadoAdmin, estado: 'En curso' });
    }

    // APROBADO: habilita gestión contable.
    await prisma.tbl_servicios_realizados.updateMany({
      where: { id_servicio: id },
      data: { estado_administrativo: ESTADO_ADMIN_REVISADO, ...trazaRevision }
    });
    const monto = Number(servicio.cobro?.monto_total || servicio.precio_interno || 0);
    const destino = (monto > 0 && servicio.sin_cobro !== 1) ? 'A gestión de cobro' : 'Cobrado total';
    await cambiarEstadoServicio(id, destino, req.user.id, observaciones || 'Revisión administrativa aprobada');

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'REVIEW', valor_nuevo: { resultado, estado_administrativo: ESTADO_ADMIN_REVISADO, estado_servicio: destino }, ip: req.ip
    });
    res.json({ ok: true, resultado, estado_administrativo: ESTADO_ADMIN_REVISADO, estado: destino });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al revisar servicio: ' + err.message });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_servicios_proyectos.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Servicio no encontrado' });

    // Solo super_admin o admin pueden editar
    if (!['super_admin', 'admin'].includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'No autorizado para editar' });
    }

    // Gate de estado: solo se edita en estados pre-ejecución. Una vez que el
    // servicio sale a campo (En camino / En curso / Finalizado...) la edición
    // libre rompería historial, evidencias, guías, cobros y facturación.
    if (!esServicioEditable(previo.estado_servicio)) {
      return res.status(409).json({
        error: `No se puede editar un servicio en estado "${previo.estado_servicio}". Solo es editable antes de salir a campo.`
      });
    }

    const puedeCambiarPrecio = ROLES_PRECIO.includes(req.user.rol_codigo);
    const nuevoIdCliente = d.id_cliente ? Number(d.id_cliente) : previo.id_cliente;
    const nuevoPrecio = puedeCambiarPrecio && d.precio_interno !== undefined ? Number(d.precio_interno) : Number(previo.precio_interno);
    const nuevaMoneda = d.moneda ?? previo.moneda;

    // Si se reciben ascensores, validar y sincronizar la junction
    let validacion = null;
    if (d.ascensores !== undefined) {
      validacion = await validarAscensores(d.ascensores, nuevoIdCliente, nuevoPrecio, nuevaMoneda);
      if (!validacion.ok) return res.status(400).json({ error: validacion.error });
    }

    const nuevaFechaProgramada = d.fecha_programada ? parseYMDLima(d.fecha_programada) : previo.fecha_programada;
    const nuevaHoraProgramada = d.hora_programada ?? previo.hora_programada;
    const nuevaDuracionDias = d.duracion_dias !== undefined
      ? Math.max(1, parseInt(d.duracion_dias, 10) || 1)
      : previo.duracion_dias;
    const cambiaDuracion = nuevaDuracionDias !== previo.duracion_dias;
    // `fecha_programada` puede ser null (servicio aprobado sin programar): la
    // comparación debe ser null-safe para no romper al registrar la fecha.
    const msFecha = (f) => (f instanceof Date ? f.getTime() : null);
    const cambiaFechaHora =
      (d.fecha_programada !== undefined && msFecha(nuevaFechaProgramada) !== msFecha(previo.fecha_programada)) ||
      (d.hora_programada !== undefined && d.hora_programada !== previo.hora_programada);

    // tipo_registro se DERIVA del subtipo (SSoT), nunca del body. Si cambia el
    // subtipo, se reclasifica; si no, se conserva el valor previo.
    const nuevoIdTipo = d.id_tipo_servicio ? Number(d.id_tipo_servicio) : previo.id_tipo_servicio;
    let nuevoTipoRegistro = previo.tipo_registro;
    if (nuevoIdTipo !== previo.id_tipo_servicio) {
      const subNuevo = await prisma.tbl_tipos_servicio.findUnique({ where: { id: nuevoIdTipo }, include: { padre: true } });
      if (!subNuevo || subNuevo.id_padre == null) {
        return res.status(400).json({ error: 'Debe seleccionar un subtipo de servicio válido.' });
      }
      nuevoTipoRegistro = clasificarTipoServicio(subNuevo).tipo_registro;
    }

    const servicio = await prisma.tbl_servicios_proyectos.update({
      where: { id },
      data: {
        id_tipo_servicio: nuevoIdTipo,
        id_cliente: nuevoIdCliente,
        tipo_registro: nuevoTipoRegistro,
        // `origen` no se actualiza desde el form: representa el canal de
        // creación original (trazabilidad), no algo editable.
        origen: previo.origen,
        titulo: d.titulo ?? previo.titulo,
        descripcion: d.descripcion ?? previo.descripcion,
        fecha_programada: nuevaFechaProgramada,
        hora_programada: nuevaHoraProgramada,
        duracion_dias: nuevaDuracionDias,
        fecha_estimada_entrega: d.fecha_estimada_entrega ? parseYMDLima(d.fecha_estimada_entrega) : previo.fecha_estimada_entrega,
        prioridad: d.prioridad ?? previo.prioridad,
        precio_interno: puedeCambiarPrecio && d.precio_interno !== undefined ? d.precio_interno : previo.precio_interno,
        moneda: nuevaMoneda,
        sin_cobro: d.sin_cobro !== undefined ? (d.sin_cobro ? 1 : 0) : previo.sin_cobro,
        observaciones: d.observaciones ?? previo.observaciones,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });

    if (validacion) {
      const idsNuevos = validacion.items.map(i => i.id_ascensor);
      // Soft-delete los que ya no están
      await prisma.tbl_servicios_ascensores.updateMany({
        where: { id_servicio: id, id_ascensor: { notIn: idsNuevos } },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      // Upsert por (id_servicio, id_ascensor)
      for (const it of validacion.items) {
        await prisma.tbl_servicios_ascensores.upsert({
          where: { id_servicio_id_ascensor: { id_servicio: id, id_ascensor: it.id_ascensor } },
          update: {
            monto: it.monto, moneda: validacion.moneda, estado: 1,
            user_id_modification: req.user.id, date_time_modification: new Date()
          },
          create: {
            id_servicio: id, id_ascensor: it.id_ascensor,
            monto: it.monto, moneda: validacion.moneda,
            user_id_registration: req.user.id
          }
        });
      }
    }

    // Sincronizar la grilla de días y sus eventos de calendario.
    // Un servicio aprobado por cotización nace SIN fecha (y sin días/eventos): al
    // registrar la fecha por primera vez se generan; si ya existían, se regeneran
    // conservando los días ya trabajados. Sin fecha programada no hay nada que
    // llevar al calendario. No aplica a borradores (no tienen días/eventos).
    if (previo.estado_servicio !== 'Borrador') {
      const cambiaTitulo = d.titulo !== undefined && d.titulo !== previo.titulo;
      if ((cambiaFechaHora || cambiaTitulo || cambiaDuracion) && nuevaFechaProgramada) {
        // `actualizar` solo opera en estados pre-campo (esServicioEditable), donde
        // aún no hay evidencia: regenerar es seguro sin pedir confirmación.
        await sincronizarDiasYEventos(prisma, id, { userId: req.user.id, confirmar: true });
      }
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: servicio, ip: req.ip
    });
    sincronizarRecordatorioServicio(id).catch(err => console.error('Sync recordatorio:', err));
    res.json({ data: servicio });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar servicio' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado_servicio } = req.body;
    const previo = await prisma.tbl_servicios_proyectos.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Servicio no encontrado' });

    // cambiarEstadoServicio registra historial, sincroniza recordatorio y
    // sincroniza estado_global de la cotización origen (si la hay).
    const servicio = await cambiarEstadoServicio(id, estado_servicio, req.user.id);
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado_servicio }, valor_nuevo: { estado: estado_servicio }, ip: req.ip
    });
    res.json({ data: servicio });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

const asignarTecnicos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { tecnicos = [], items_checklist = [] } = req.body;
    if (!Array.isArray(tecnicos) || tecnicos.length === 0) {
      return res.status(400).json({ error: 'Debe asignar al menos un técnico' });
    }

    const servicioActual = await prisma.tbl_servicios_proyectos.findUnique({ where: { id }, select: { estado_servicio: true } });
    if (!servicioActual) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (servicioActual.estado_servicio === 'Borrador') {
      return res.status(400).json({ error: 'Debe promover el borrador antes de asignar técnicos' });
    }
    if (estaServicioFinalizado(servicioActual.estado_servicio)) {
      return res.status(400).json({
        error: `El servicio está ${servicioActual.estado_servicio}: ya no se pueden modificar técnicos ni ítems del checklist`
      });
    }

    const consistencia = validarConsistenciaAsignaciones(tecnicos);
    if (!consistencia.ok) return res.status(400).json({ error: consistencia.error });

    // Validar todos los técnicos antes de tocar la BD (evita estado parcial si alguno falla)
    const idsNuevos = tecnicos.map(t => Number(t.id_tecnico));
    const tecsBD = await prisma.tbl_tecnicos.findMany({ where: { id: { in: idsNuevos } } });
    const tecsMap = new Map(tecsBD.map(t => [t.id, t]));
    for (const t of tecnicos) {
      const tec = tecsMap.get(Number(t.id_tecnico));
      if (!tec || tec.estado !== 1) {
        return res.status(400).json({ error: `Técnico ${t.id_tecnico} no disponible` });
      }
    }

    // Soft-delete sólo los técnicos que ya NO están en la nueva lista
    await prisma.tbl_servicios_asignaciones.updateMany({
      where: { id_servicio: id, id_tecnico: { notIn: idsNuevos } },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });

    // Upsert por (id_servicio, id_tecnico): reactiva los previos y crea los nuevos
    for (const t of tecnicos) {
      await prisma.tbl_servicios_asignaciones.upsert({
        where: { id_servicio_id_tecnico: { id_servicio: id, id_tecnico: Number(t.id_tecnico) } },
        update: {
          rol_asignacion: t.rol_asignacion || 'Apoyo',
          responsable_principal: t.responsable_principal ? 1 : 0,
          responsable_documentacion: t.responsable_documentacion ? 1 : 0,
          responsable_checklist: t.responsable_checklist ? 1 : 0,
          estado: 1,
          estado_asignacion: 'activa',
          asignado_por: req.user.id,
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        },
        create: {
          id_servicio: id,
          id_tecnico: Number(t.id_tecnico),
          rol_asignacion: t.rol_asignacion || 'Apoyo',
          responsable_principal: t.responsable_principal ? 1 : 0,
          responsable_documentacion: t.responsable_documentacion ? 1 : 0,
          responsable_checklist: t.responsable_checklist ? 1 : 0,
          asignado_por: req.user.id,
          user_id_registration: req.user.id
        }
      });
    }

    // Checklist (sin destruir el progreso del técnico)
    const tecChecklist = tecnicos.find(t => t.responsable_checklist) || tecnicos[0];
    const checklistExist = await prisma.tbl_checklists_salida.findUnique({ where: { id_servicio: id } });
    let checklist;
    if (checklistExist) {
      checklist = await prisma.tbl_checklists_salida.update({
        where: { id_servicio: id },
        data: {
          id_tecnico_responsable: Number(tecChecklist.id_tecnico),
          user_id_modification: req.user.id, date_time_modification: new Date()
        }
      });
    } else {
      checklist = await prisma.tbl_checklists_salida.create({
        data: {
          id_servicio: id,
          id_tecnico_responsable: Number(tecChecklist.id_tecnico),
          estado_checklist: 'Pendiente',
          user_id_registration: req.user.id
        }
      });
    }

    // Merge de ítems por id: preserva estado_item del técnico.
    // - id existente → update de campos editables (sin tocar estado_item)
    // - sin id (o id desconocido) → create con estado_item = 'Pendiente' (default)
    // - ítems activos que ya no vienen → soft-delete (estado = 0)
    const itemsExistentes = await prisma.tbl_checklists_salida_items.findMany({
      where: { id_checklist: checklist.id, estado: 1 },
      select: { id: true }
    });
    const idsExistentes = new Set(itemsExistentes.map(it => it.id));
    const idsEntrantes = new Set();
    for (const it of items_checklist) {
      if (!it.nombre) continue;
      const idInc = Number(it.id) || null;
      const base = {
        tipo_item: it.tipo_item || 'Herramienta',
        nombre: it.nombre,
        cantidad: it.cantidad || 1,
        unidad: it.unidad || 'Unidad',
        observaciones: it.observaciones || null
      };
      if (idInc && idsExistentes.has(idInc)) {
        idsEntrantes.add(idInc);
        await prisma.tbl_checklists_salida_items.update({
          where: { id: idInc },
          data: { ...base, user_id_modification: req.user.id, date_time_modification: new Date() }
        });
      } else {
        await prisma.tbl_checklists_salida_items.create({
          data: { id_checklist: checklist.id, ...base, user_id_registration: req.user.id }
        });
      }
    }
    const idsAEliminar = [...idsExistentes].filter(idx => !idsEntrantes.has(idx));
    if (idsAEliminar.length > 0) {
      await prisma.tbl_checklists_salida_items.updateMany({
        where: { id: { in: idsAEliminar } },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
    }

    // Recalcular estado_checklist según los ítems que sobrevivieron al merge.
    // El helper sólo promueve estado_servicio (Checklist de salida pendiente → Listo para salida),
    // nunca lo demota, así que es seguro llamarlo aun si el servicio está más avanzado.
    await _recalcEstadoChecklist(checklist.id, req.user.id);

    // estado_servicio: ajustar sólo si el servicio aún está en la fase pre-checklist.
    // Si el técnico ya completó el checklist y el servicio avanzó (Listo para salida / En camino /
    // En curso / etc.), una re-asignación administrativa no debe demotarlo.
    // 'Pendiente' es el estado inicial al crear el servicio: incluirlo aquí es
    // lo que mueve el servicio de la fase "recién creado" a la fase operativa.
    // Sin esto, asignar técnicos a un servicio recién creado deja el estado en
    // 'Pendiente' indefinidamente y los botones de Iniciar/Finalizar nunca aparecen.
    const estadosPreChecklist = ['Pendiente', 'Asignado', 'Checklist de salida pendiente'];
    const estadoActual = servicioActual.estado_servicio;
    const nuevoEstadoServicio = estadosPreChecklist.includes(estadoActual)
      ? (items_checklist.length > 0 ? 'Checklist de salida pendiente' : 'Asignado')
      : estadoActual;
    if (nuevoEstadoServicio !== estadoActual) {
      // cambiarEstadoServicio registra historial, sincroniza recordatorio y
      // sincroniza estado_global de la cotización origen (si la hay).
      await cambiarEstadoServicio(id, nuevoEstadoServicio, req.user.id);
    } else {
      await prisma.tbl_servicios_proyectos.update({
        where: { id },
        data: { user_id_modification: req.user.id, date_time_modification: new Date() }
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al asignar técnicos: ' + err.message });
  }
};

const iniciarServicio = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { accion = 'iniciar_servicio' } = req.body;
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      include: {
        checklists: { include: { items: { where: { estado: 1 } } } },
        asignaciones: { where: { estado: 1 } },
        emergencia: { select: { id: true } },
        correctivo: { select: { id: true } }
      }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (servicio.estado_servicio === 'Cancelado' || servicio.estado_servicio.startsWith('Finalizado')) {
      return res.status(400).json({ error: 'Servicio no se puede iniciar' });
    }

    // Validar checklist completo si la acción es iniciar_servicio
    const chk = servicio.checklists[0];
    if (chk && chk.estado_checklist !== 'Completo' && chk.estado_checklist !== 'Aprobado' && chk.items.length > 0 && accion === 'iniciar_servicio') {
      return res.status(400).json({ error: 'El checklist de salida debe estar completo' });
    }

    let nuevoEstado = servicio.estado_servicio;
    if (accion === 'en_camino') nuevoEstado = 'En camino';
    else if (accion === 'iniciar_servicio') nuevoEstado = 'En curso';

    await cambiarEstadoServicio(id, nuevoEstado, req.user.id);

    // Al pasar a "En curso" se crea el checklist de finalización para que el
    // técnico lo vaya completando durante la ejecución (foto por ítem). Si la
    // plantilla de la categoría no tiene ítems configurados no se crea (el panel
    // mostrará el aviso para configurarla); no debe bloquear el inicio.
    if (nuevoEstado === 'En curso') {
      try {
        await ensureChecklistFinalizacion(prisma, servicio, req.user.id);
      } catch (err) {
        console.error('[iniciarServicio] No se pudo crear el checklist de finalización:', err.message);
      }
    }

    // Marcar técnicos como ocupados
    for (const a of servicio.asignaciones) {
      await prisma.tbl_tecnicos.update({
        where: { id: a.id_tecnico },
        data: { estado_operativo: nuevoEstado === 'En curso' ? 'En servicio' : 'Ocupado' }
      });
    }

    res.json({ ok: true, estado: nuevoEstado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar servicio: ' + err.message });
  }
};

const finalizarServicio = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { observaciones_tecnicas, descargo_tecnico, codigo_guia, id_archivo_guia, finalizar_observado, id_archivos_evidencias, numero_ot, id_archivo_ot } = req.body;
    const numeroOtNormalizado = typeof numero_ot === 'string' ? numero_ot.trim() : '';
    const idArchivoOtNormalizado = Number.isFinite(Number(id_archivo_ot)) && Number(id_archivo_ot) > 0
      ? Number(id_archivo_ot)
      : null;
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      include: {
        asignaciones: { where: { estado: 1 } },
        guias: { where: { estado: 1 } },
        ascensores: { where: { estado: 1 } }
      }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (servicio.estado_servicio !== 'En curso') {
      return res.status(400).json({ error: 'El servicio debe estar en curso para finalizarlo' });
    }
    const sinGuia = !id_archivo_guia && servicio.guias.length === 0;
    const sinObservaciones = !observaciones_tecnicas;
    if (sinGuia && sinObservaciones) {
      return res.status(400).json({ error: 'Se requiere guía o al menos observación técnica' });
    }
    // Checklist de finalización: OPCIONAL. La configuración de plantillas es
    // opcional y un checklist incompleto (o inexistente) no impide cerrar el
    // servicio. Si existe informe generado se conserva enlazado; si no, se cierra
    // igual. Por eso ya no se valida su existencia aquí.

    // Evidencias del trabajo terminado: obligatorias para técnicos al finalizar.
    // Admin/SuperAdmin pueden cerrar sin evidencias (igual que con la guía).
    const evidenciasIds = Array.isArray(id_archivos_evidencias)
      ? id_archivos_evidencias.map(Number).filter(Number.isFinite)
      : [];
    if (req.user.rol_codigo === 'tecnico' && evidenciasIds.length === 0) {
      return res.status(400).json({ error: 'Debe adjuntar al menos una foto de evidencia del trabajo terminado' });
    }
    // OT (Orden de Trabajo): obligatoria para técnicos al finalizar.
    // Admin/SuperAdmin pueden cerrar sin OT (mismo patrón que guía y evidencias).
    if (req.user.rol_codigo === 'tecnico' && (!numeroOtNormalizado || !idArchivoOtNormalizado)) {
      return res.status(400).json({ error: 'Debe adjuntar la OT (número y documento) para finalizar' });
    }
    // Servicios multidía: el técnico no puede subir la OT si algún día programado
    // quedó sin evidencia. Admin/SuperAdmin pueden cerrar igual (mismo patrón que
    // guía/evidencia/OT). Los servicios de un solo día conservan la regla previa.
    if (req.user.rol_codigo === 'tecnico' && servicio.duracion_dias > 1) {
      const faltantes = await diasSinEvidencia(prisma, id);
      if (faltantes.length > 0) {
        const lista = faltantes.map(dd => `Día ${dd.orden}`).join(', ');
        return res.status(400).json({ error: `Cada día debe tener al menos una evidencia antes de la OT. Faltan: ${lista}.` });
      }
    }
    // Si no hay guía: solo Admin/Super Admin puede cerrar marcándolo como observado
    if (sinGuia && !finalizar_observado) {
      // permitir si hay observación técnica (regla original)
    } else if (sinGuia && finalizar_observado && !['super_admin', 'admin'].includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'Solo Admin o Super Admin pueden finalizar como observado sin guía' });
    }

    // Permiso: técnico responsable documental o admin
    if (req.user.rol_codigo === 'tecnico') {
      const esResponsable = servicio.asignaciones.find(a => a.id_tecnico === req.user.id_tecnico && a.responsable_documentacion === 1);
      const cantidad = servicio.asignaciones.length;
      const unicoTec = cantidad === 1 && servicio.asignaciones[0].id_tecnico === req.user.id_tecnico;
      if (!esResponsable && !unicoTec) {
        return res.status(403).json({ error: 'Solo el responsable documental puede finalizar' });
      }
    }

    const responsableDoc = servicio.asignaciones.find(a => a.responsable_documentacion === 1) || servicio.asignaciones[0];
    const responsablePrincipal = servicio.asignaciones.find(a => a.responsable_principal === 1) || responsableDoc;

    // Crear guía si llegó id_archivo o se está marcando observado
    if (id_archivo_guia || codigo_guia || (sinGuia && finalizar_observado)) {
      await prisma.tbl_servicios_guias.create({
        data: {
          id_servicio: id,
          id_tecnico: responsableDoc ? responsableDoc.id_tecnico : null,
          codigo_guia: codigo_guia || null,
          id_archivo: id_archivo_guia || null,
          observaciones_tecnicas: observaciones_tecnicas || null,
          estado_guia: (sinGuia && finalizar_observado) ? ESTADO_GUIA_OBSERVADA : ESTADO_GUIA_ADJUNTA,
          user_id_registration: req.user.id
        }
      });
    }

    // Registrar evidencias del trabajo terminado. Cada id corresponde a un tbl_archivos
    // subido previamente vía POST /archivos con tipo=evidencias.
    if (evidenciasIds.length > 0) {
      const idTecnicoEvidencia = req.user.id_tecnico || (responsableDoc ? responsableDoc.id_tecnico : null);
      if (idTecnicoEvidencia) {
        for (const idArchivo of evidenciasIds) {
          await prisma.tbl_servicios_evidencias.create({
            data: {
              id_servicio: id,
              id_tecnico: idTecnicoEvidencia,
              id_archivo: idArchivo,
              tipo_evidencia: 'Foto',
              descripcion: null,
              user_id_registration: req.user.id
            }
          });
        }
      }
    }

    // Actualizar estado servicio (cambiarEstadoServicio registra historial,
    // recordatorios y sincroniza estado_global de cotización).
    const estadoFinal = (sinGuia && finalizar_observado) ? ESTADO_SERVICIO_FINALIZADO_OBSERVADO : ESTADO_SERVICIO_FINALIZADO_TECNICO;
    await cambiarEstadoServicio(
      id, estadoFinal, req.user.id,
      (sinGuia && finalizar_observado) ? 'Finalización observada por admin' : null
    );

    // Si el cobro ya existe (servicio aprobado desde cotización), heredamos
    // su estado para no pisar pagos/facturas que ya pudieron haberse
    // registrado contra el adelanto antes de finalizar la ejecución.
    const cobroPrevio = await prisma.tbl_cobros.findUnique({
      where: { id_servicio: id },
      include: {
        cuotas: { where: { estado: 1 } },
        facturas: { where: { estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA } } }
      }
    });
    // Servicios de un plan de mantenimiento: la facturación es ÚNICA a nivel de
    // plan (un solo cobro por el total del plan, creado al crear el plan), nunca
    // por servicio. Por eso estos servicios no llevan cobro propio ni alerta de
    // "facturar"; su folder contable queda 'Sin cobro' / 'Sin factura'.
    const esServicioDePlan = !!servicio.id_mantenimiento_plan;
    // Mantenimiento gratuito / cobertura: nunca debe ir a "Pendiente de iniciar"
    // porque no se le crea cobro (ver fallback más abajo). Si por error legacy
    // existiera un cobroPrevio para este servicio, su estado tampoco aplica.
    const esGratuito = servicio.sin_cobro === 1;
    const estadoCobroInicial = (esServicioDePlan || esGratuito)
      ? 'Sin cobro'
      : (cobroPrevio?.estado_cobro || 'Pendiente de iniciar');
    const estadoFacturacionInicial = esServicioDePlan
      ? ESTADO_FACTURACION_SIN
      : calcularEstadoFacturacion({
          facturas: cobroPrevio?.facturas || [],
          cuotas: cobroPrevio?.cuotas || []
        });

    // Crear/actualizar folder contable. Caso típico: el folder ya fue creado
    // al aprobar la cotización (estado 'En ejecución'); aquí transicionamos a
    // 'Pendiente revisión', completamos datos técnicos y registramos la fecha
    // REAL de realización. Caso legacy (servicio sin cotización aprobada o sin
    // folder previo): se crea desde cero con los defaults históricos.
    await prisma.tbl_servicios_realizados.upsert({
      where: { id_servicio: id },
      update: {
        id_tecnico_principal: responsablePrincipal?.id_tecnico || null,
        id_responsable_documentacion: responsableDoc?.id_tecnico || null,
        observaciones_tecnicas: observaciones_tecnicas || null,
        descargo_tecnico: descargo_tecnico || null,
        numero_ot: numeroOtNormalizado || null,
        id_archivo_ot: idArchivoOtNormalizado,
        // Salir de 'En ejecución' (creado al aprobar) → 'Pendiente revisión'.
        // No pisamos estados ya avanzados (Revisado/Cerrado/etc.) al finalizar.
        estado_administrativo: 'Pendiente revisión',
        // Sobrescribir con la fecha REAL de finalización para que reportes y
        // dashboards muestren la fecha de ejecución, no la de aprobación.
        fecha_realizacion: new Date(),
        // Heredar estados financieros del cobro vigente al finalizar.
        estado_cobro: estadoCobroInicial,
        estado_facturacion: estadoFacturacionInicial,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      },
      create: {
        id_servicio: id,
        id_cliente: servicio.id_cliente,
        id_tecnico_principal: responsablePrincipal?.id_tecnico || null,
        id_responsable_documentacion: responsableDoc?.id_tecnico || null,
        observaciones_tecnicas: observaciones_tecnicas || null,
        descargo_tecnico: descargo_tecnico || null,
        numero_ot: numeroOtNormalizado || null,
        id_archivo_ot: idArchivoOtNormalizado,
        estado_administrativo: 'Pendiente revisión',
        estado_cobro: estadoCobroInicial,
        estado_facturacion: estadoFacturacionInicial,
        user_id_registration: req.user.id
      }
    });

    // Fallback: crear cobro si el servicio no viene de cotización aprobada
    // (servicios directos). Los aprobados desde cotización ya tienen su cobro.
    // Los servicios de un PLAN de mantenimiento NUNCA crean cobro propio: la
    // facturación es única a nivel de plan.
    if (!cobroPrevio && servicio.sin_cobro !== 1 && !esServicioDePlan) {
      await crearCobroInicial(prisma, {
        idServicio: id,
        idCliente: servicio.id_cliente,
        monto: servicio.precio_interno,
        moneda: servicio.moneda,
        fechaCuotaUnica: servicio.fecha_programada,
        idUsuario: req.user.id
      });
    }
    // Transición a "En revisión administrativa" (gate previo al envío a cobros)
    if (estadoFinal === ESTADO_SERVICIO_FINALIZADO_TECNICO) {
      await cambiarEstadoServicio(id, 'En revisión administrativa', req.user.id, 'Servicio pendiente de revisión administrativa');
    }

    // Liberar técnicos
    for (const a of servicio.asignaciones) {
      await prisma.tbl_tecnicos.update({ where: { id: a.id_tecnico }, data: { estado_operativo: 'Disponible' } });
    }

    // Para planes continuos: auto-materializa el siguiente evento del plan
    // como servicio (queda listo para asignar técnico, checklist y cobro)
    // y actualiza `proximo_mantenimiento` de todos los ascensores del plan.
    if (servicio.id_mantenimiento_plan) {
      try {
        const siguienteServicio = await materializarSiguienteEventoDelPlan({
          idPlan: servicio.id_mantenimiento_plan,
          fechaServicioFinalizado: servicio.fecha_programada,
          userId: req.user.id
        });
        if (siguienteServicio) {
          const plan = await prisma.tbl_mantenimientos_planes.findUnique({
            where: { id: servicio.id_mantenimiento_plan },
            select: { ascensores: { where: { estado: 1 }, select: { id_ascensor: true } } }
          });
          const idsAsc = (plan?.ascensores || []).map(a => a.id_ascensor);
          if (idsAsc.length > 0) {
            await prisma.tbl_ascensores.updateMany({
              where: { id: { in: idsAsc } },
              data: { proximo_mantenimiento: siguienteServicio.fecha_programada }
            });
          }
        }
      } catch (err) {
        // No bloqueamos la finalización si la materialización falla;
        // queda el botón manual "+ Crear servicio" en el calendario.
        console.error('Auto-materializar siguiente mantenimiento falló:', err);
      }
    }

    // Historial: una entrada por cliente y una por cada ascensor del servicio
    await prisma.tbl_clientes_historial.create({
      data: {
        id_cliente: servicio.id_cliente, id_servicio: id,
        tipo_evento: 'servicio_finalizado',
        descripcion: `Servicio ${servicio.codigo} finalizado`,
        creado_por: req.user.id
      }
    });
    for (const sa of servicio.ascensores) {
      await prisma.tbl_ascensores_historial.create({
        data: {
          id_ascensor: sa.id_ascensor, id_servicio: id,
          tipo_evento: 'servicio_finalizado',
          descripcion: `Servicio ${servicio.codigo} finalizado`,
          creado_por: req.user.id
        }
      });
    }

    // Evento calendario
    await prisma.tbl_calendario_eventos.updateMany({
      where: { id_servicio: id }, data: { estado_evento: ESTADO_EVENTO_FINALIZADO }
    });

    // Alertas de "servicio finalizado" para el calendario. Se sincronizan AQUÍ
    // (no al generar el informe) porque recién en este punto el servicio está en
    // estado post-finalización; antes el gate de `sincronizarAlertaServicioFinalizado`
    // las descartaba. Idempotentes y no bloqueantes:
    //   · servicio_finalizado_revisar  → coordinador (revisar y corregir)
    //   · servicio_finalizado_facturar → contabilidad (emitir factura)
    //   · servicio_finalizado_aviso    → admin (aviso informativo)
    // La alerta "facturar" se OMITE para servicios de plan: la facturación es
    // única a nivel de plan, no por servicio.
    Promise.allSettled([
      sincronizarRecordatorioRevisarServicio(id),
      esServicioDePlan ? Promise.resolve() : sincronizarRecordatorioFacturarServicio(id),
      sincronizarRecordatorioAvisoFinalizacion(id)
    ]).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`Sync alerta finalización [#${i}]:`, r.reason);
      });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al finalizar: ' + err.message });
  }
};

const cancelar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { motivo } = req.body;
    const previo = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      include: { asignaciones: { where: { estado: 1 } } }
    });
    if (!previo) return res.status(404).json({ error: 'Servicio no encontrado' });
    // Anota el motivo en observaciones del servicio + cambia estado vía helper
    // (registra historial, sincroniza recordatorio y sincroniza estado_global
    // de la cotización origen).
    await prisma.tbl_servicios_proyectos.update({
      where: { id },
      data: {
        observaciones: previo.observaciones ? `${previo.observaciones}\n[Cancelado] ${motivo || ''}` : `[Cancelado] ${motivo || ''}`,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    await cambiarEstadoServicio(id, 'Cancelado', req.user.id, motivo || null);
    await prisma.tbl_calendario_eventos.updateMany({
      where: { id_servicio: id }, data: { estado_evento: ESTADO_EVENTO_CANCELADO }
    });

    // Si existía folder contable (creado al aprobar la cotización), darlo de
    // baja lógica para que Contabilidad no siga viendo el caso como activo.
    await prisma.tbl_servicios_realizados.updateMany({
      where: { id_servicio: id },
      data: {
        estado: 0,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });

    // Liberar técnicos: volver a Disponible si no quedan otros servicios activos
    for (const a of previo.asignaciones) {
      const otrasActivas = await prisma.tbl_servicios_asignaciones.count({
        where: {
          id_tecnico: a.id_tecnico,
          estado: 1,
          id_servicio: { not: id },
          servicio: { estado_servicio: { in: ['En camino', 'En curso'] }, estado: 1 }
        }
      });
      if (otrasActivas === 0) {
        await prisma.tbl_tecnicos.update({
          where: { id: a.id_tecnico },
          data: { estado_operativo: 'Disponible' }
        });
      }
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'CANCEL', valor_anterior: { estado: previo.estado_servicio }, valor_nuevo: { estado: 'Cancelado', motivo }, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar' });
  }
};

const realizados = async (req, res) => {
  try {
    const { id_cliente, estado_cobro, estado_facturacion, desde, hasta, q, tipo_categoria, situacion } = req.query;
    const where = { estado: 1 };
    if (req.user.rol_codigo === 'tecnico') {
      where.OR = [
        { id_tecnico_principal: req.user.id_tecnico || -1 },
        { id_responsable_documentacion: req.user.id_tecnico || -1 }
      ];
    }
    if (estado_cobro) where.estado_cobro = estado_cobro;
    if (estado_facturacion) where.estado_facturacion = estado_facturacion;
    if (desde || hasta) {
      where.fecha_realizacion = {};
      if (desde) where.fecha_realizacion.gte = parseYMDLima(desde);
      if (hasta) where.fecha_realizacion.lte = parseYMDFinDiaLima(hasta);
    }
    // Filtros sobre el servicio relacionado (cliente y búsqueda por código/cliente).
    const servicioWhere = {};
    if (id_cliente) servicioWhere.id_cliente = Number(id_cliente);
    if (q) {
      // Buscador amplio: código de servicio, razón social (nombre del cliente),
      // documento (RUC/DNI) y código del edificio/ascensor.
      servicioWhere.OR = [
        { codigo: { contains: q, mode: 'insensitive' } },
        { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
        { cliente: { numero_documento: { contains: q, mode: 'insensitive' } } },
        { ascensores: { some: { estado: 1, ascensor: { codigo: { contains: q, mode: 'insensitive' } } } } }
      ];
    }
    // Filtro por tipo de servicio: correctivo | preventivo (mantenimiento) |
    // proyecto. Se aplica vía AND para no pisar el filtro de ámbito por tipo_registro.
    const filtrosCategoria = [];
    if (tipo_categoria === 'proyecto') filtrosCategoria.push({ tipo_registro: 'proyecto' });
    else if (tipo_categoria === 'correctivo') filtrosCategoria.push({ tipo_servicio: { modulo_asociado: 'correctivo' } });
    else if (tipo_categoria === 'preventivo') filtrosCategoria.push({ tipo_servicio: { modulo_asociado: 'mantenimiento' } });
    if (filtrosCategoria.length) servicioWhere.AND = filtrosCategoria;
    // Los servicios marcados "Sin factura" (requiere_factura = 0) no son
    // "pendientes por facturar": se excluyen al filtrar por ese estado.
    if (estado_facturacion === ESTADO_FACTURACION_SIN) servicioWhere.requiere_factura = 1;
    // Filtro por situación de pago (columna "Situación"):
    //   sin_cobro → servicios gratuitos.
    //   cancelado → cobro pagado (Pagado/Cerrado), excluyendo gratuitos.
    //   pendiente → cobro no pagado, excluyendo gratuitos.
    if (situacion === 'sin_cobro') {
      servicioWhere.sin_cobro = 1;
    } else if (situacion === 'cancelado') {
      servicioWhere.sin_cobro = { not: 1 };
      where.estado_cobro = { in: ['Pagado', 'Cerrado'] };
    } else if (situacion === 'pendiente') {
      servicioWhere.sin_cobro = { not: 1 };
      where.estado_cobro = { notIn: ['Pagado', 'Cerrado'] };
    }
    // Ámbito del usuario: solo realizados de servicios/proyectos del ámbito.
    const tiposRealizados = tiposRegistroPermitidos(req.user);
    if (tiposRealizados) servicioWhere.tipo_registro = { in: tiposRealizados.length ? tiposRealizados : ['__sin_ambito__'] };
    if (Object.keys(servicioWhere).length) where.servicio = servicioWhere;
    const result = await paginar(
      prisma.tbl_servicios_realizados,
      {
        where, orderBy: { id: 'desc' },
        include: {
          archivo_ot: true,
          servicio: {
            include: {
              cliente: true,
              ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: true } } } },
              tipo_servicio: true,
              asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
              guias: { where: { estado: 1 }, include: { archivo: true } },
              evidencias: { where: { estado: 1 } },
              checklists: { include: { items: { where: { estado: 1 } } } },
              cobro: { include: { facturas: true } }
            }
          }
        }
      },
      req.query
    );
    res.json({ ...result, data: result.data.map(r => ({ ...r, servicio: sanitizarPrecio(r.servicio, req.user.rol_codigo) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar servicios realizados' });
  }
};

/**
 * Verifica si el usuario puede gestionar guías (crear/editar) sobre un servicio.
 * super_admin/admin/coordinador: siempre.
 * tecnico: solo si es responsable_documentacion del servicio o es el único técnico asignado.
 */
function puedeUsuarioGestionarGuia(user, asignaciones) {
  if (['super_admin', 'admin', 'coordinador'].includes(user.rol_codigo)) return true;
  if (user.rol_codigo !== 'tecnico') return false;
  const list = asignaciones || [];
  const esResponsable = list.find(a => a.id_tecnico === user.id_tecnico && a.responsable_documentacion === 1);
  const unicoTec = list.length === 1 && list[0].id_tecnico === user.id_tecnico;
  return !!(esResponsable || unicoTec);
}

/**
 * Si el servicio está finalizado observado y la guía resultante tiene archivo,
 * regulariza el servicio pasándolo a finalizado por técnico.
 */
async function regularizarSiObservado(servicio, idArchivo, idUsuario) {
  if (!idArchivo) return;
  if (servicio.estado_servicio !== ESTADO_SERVICIO_FINALIZADO_OBSERVADO) return;
  await cambiarEstadoServicio(
    servicio.id,
    ESTADO_SERVICIO_FINALIZADO_TECNICO,
    idUsuario,
    'Guía regularizada por coordinador/admin'
  );
}

const crearGuia = async (req, res) => {
  try {
    const id_servicio = Number(req.params.id);
    const { codigo_guia, id_archivo, observaciones_tecnicas, estado_guia } = req.body || {};

    const codigoNormalizado = typeof codigo_guia === 'string' ? codigo_guia.trim() : '';
    const observNormalizado = typeof observaciones_tecnicas === 'string' ? observaciones_tecnicas.trim() : '';
    const archivoNormalizado = Number.isFinite(Number(id_archivo)) && Number(id_archivo) > 0
      ? Number(id_archivo)
      : null;

    if (!archivoNormalizado && !codigoNormalizado && !observNormalizado) {
      return res.status(400).json({ error: 'Debe ingresar al menos código, archivo u observaciones' });
    }

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: id_servicio },
      include: { asignaciones: { where: { estado: 1 } } }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });

    if (!puedeUsuarioGestionarGuia(req.user, servicio.asignaciones)) {
      return res.status(403).json({ error: 'No tiene permisos para gestionar guías de este servicio' });
    }
    if (esServicioPostRevision(servicio.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${servicio.estado_servicio}: no se pueden registrar guías de salida` });
    }

    const responsableDoc = servicio.asignaciones.find(a => a.responsable_documentacion === 1) || servicio.asignaciones[0];
    const id_tecnico = req.user.id_tecnico || responsableDoc?.id_tecnico || null;
    if (!id_tecnico) {
      return res.status(400).json({ error: 'No hay técnico asignado al servicio para asociar la guía' });
    }

    const estadoNormalizado = esEstadoGuiaValido(estado_guia)
      ? estado_guia
      : estadoGuiaSegunArchivo(archivoNormalizado);

    const guia = await prisma.tbl_servicios_guias.create({
      data: {
        id_servicio,
        id_tecnico,
        codigo_guia: codigoNormalizado || null,
        id_archivo: archivoNormalizado,
        observaciones_tecnicas: observNormalizado || null,
        estado_guia: estadoNormalizado,
        user_id_registration: req.user.id
      },
      include: { archivo: true, tecnico: true }
    });

    await regularizarSiObservado(servicio, archivoNormalizado, req.user.id);

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_guias', id_entidad: guia.id,
      accion: 'CREATE', valor_nuevo: guia, ip: req.ip
    });
    res.status(201).json({ data: guia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear guía: ' + err.message });
  }
};

const actualizarGuia = async (req, res) => {
  try {
    const id_servicio = Number(req.params.id);
    const id_guia = Number(req.params.guiaId);
    const { codigo_guia, id_archivo, observaciones_tecnicas, estado_guia } = req.body || {};

    const guiaPrevia = await prisma.tbl_servicios_guias.findUnique({
      where: { id: id_guia },
      include: { servicio: { include: { asignaciones: { where: { estado: 1 } } } } }
    });
    if (!guiaPrevia) return res.status(404).json({ error: 'Guía no encontrada' });
    if (guiaPrevia.estado === 0) return res.status(400).json({ error: 'La guía está eliminada' });
    if (guiaPrevia.id_servicio !== id_servicio) {
      return res.status(400).json({ error: 'La guía no pertenece a este servicio' });
    }

    if (!puedeUsuarioGestionarGuia(req.user, guiaPrevia.servicio.asignaciones)) {
      return res.status(403).json({ error: 'No tiene permisos para gestionar guías de este servicio' });
    }
    if (esServicioPostRevision(guiaPrevia.servicio.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${guiaPrevia.servicio.estado_servicio}: no se pueden modificar guías de salida` });
    }

    const data = {
      user_id_modification: req.user.id,
      date_time_modification: new Date()
    };
    if (codigo_guia !== undefined) {
      const c = typeof codigo_guia === 'string' ? codigo_guia.trim() : '';
      data.codigo_guia = c || null;
    }
    if (observaciones_tecnicas !== undefined) {
      const o = typeof observaciones_tecnicas === 'string' ? observaciones_tecnicas.trim() : '';
      data.observaciones_tecnicas = o || null;
    }
    if (id_archivo !== undefined) {
      data.id_archivo = Number.isFinite(Number(id_archivo)) && Number(id_archivo) > 0
        ? Number(id_archivo)
        : null;
    }
    if (estado_guia !== undefined) {
      if (!esEstadoGuiaValido(estado_guia)) {
        return res.status(400).json({ error: 'Estado de guía inválido' });
      }
      data.estado_guia = estado_guia;
    }

    const guia = await prisma.tbl_servicios_guias.update({
      where: { id: id_guia },
      data,
      include: { archivo: true, tecnico: true }
    });

    const archivoResultante = guia.id_archivo;
    await regularizarSiObservado(guiaPrevia.servicio, archivoResultante, req.user.id);

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_guias', id_entidad: id_guia,
      accion: 'UPDATE', valor_anterior: guiaPrevia, valor_nuevo: guia, ip: req.ip
    });
    res.json({ data: guia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar guía: ' + err.message });
  }
};

const eliminarGuia = async (req, res) => {
  try {
    const id_servicio = Number(req.params.id);
    const id_guia = Number(req.params.guiaId);

    const previa = await prisma.tbl_servicios_guias.findUnique({
      where: { id: id_guia },
      include: { archivo: true, servicio: { select: { estado_servicio: true } } }
    });
    if (!previa) return res.status(404).json({ error: 'Guía no encontrada' });
    if (previa.estado === 0) return res.status(400).json({ error: 'Guía ya eliminada' });
    if (previa.id_servicio !== id_servicio) {
      return res.status(400).json({ error: 'La guía no pertenece a este servicio' });
    }
    if (esServicioPostRevision(previa.servicio?.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${previa.servicio.estado_servicio}: no se pueden eliminar guías de salida` });
    }

    await prisma.tbl_servicios_guias.update({
      where: { id: id_guia },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_guias', id_entidad: id_guia,
      accion: 'DELETE', valor_anterior: previa, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar guía: ' + err.message });
  }
};

/**
 * Soft-delete de un servicio/proyecto: estado = 0. Da de baja también los
 * artefactos visibles en otros módulos (evento de calendario, folder contable
 * de servicios realizados, recordatorios) y libera a los técnicos asignados que
 * no tengan otros servicios activos. No borra físicamente: el historial queda
 * auditado y las relaciones se preservan.
 */
const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      include: { asignaciones: { where: { estado: 1 } } }
    });
    if (!previo) return res.status(404).json({ error: 'Servicio no encontrado' });

    const servicio = await prisma.tbl_servicios_proyectos.update({
      where: { id },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    // Evento de calendario: baja lógica para que deje de listarse (filtra estado=1).
    await prisma.tbl_calendario_eventos.updateMany({
      where: { id_servicio: id, estado: 1 },
      data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    // Folder contable (servicios realizados): baja lógica si existía.
    await prisma.tbl_servicios_realizados.updateMany({
      where: { id_servicio: id, estado: 1 },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    // Recordatorios automáticos vinculados al servicio: baja lógica.
    await prisma.tbl_recordatorios.updateMany({
      where: { id_servicio: id, estado: 1 },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    // Liberar técnicos: volver a Disponible si no quedan otros servicios activos.
    for (const a of previo.asignaciones) {
      const otrasActivas = await prisma.tbl_servicios_asignaciones.count({
        where: {
          id_tecnico: a.id_tecnico, estado: 1, id_servicio: { not: id },
          servicio: { estado_servicio: { in: ['En camino', 'En curso'] }, estado: 1 }
        }
      });
      if (otrasActivas === 0) {
        await prisma.tbl_tecnicos.update({ where: { id: a.id_tecnico }, data: { estado_operativo: 'Disponible' } });
      }
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'DELETE', valor_anterior: previo, valor_nuevo: servicio, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar servicio' });
  }
};

/**
 * Cambia la bandera persistida `requiere_factura` del servicio de forma
 * independiente al candado operativo: es una decisión administrativa/contable
 * que no altera el historial de ejecución, así que se puede cambiar en cualquier
 * momento MIENTRAS no exista una factura emitida (activa, no anulada). Una vez
 * emitida, la marca queda fija para no quedar inconsistente con el comprobante.
 */
const cambiarRequiereFactura = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const nuevo = (req.body.requiere_factura === true || req.body.requiere_factura === 1 || req.body.requiere_factura === '1') ? 1 : 0;
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      include: { facturas: { where: { estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA } } } }
    });
    if (!servicio || servicio.estado === 0) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (servicio.facturas.length > 0) {
      return res.status(409).json({ error: 'El servicio ya tiene una factura emitida; no se puede cambiar la marca de facturación.' });
    }
    if (servicio.requiere_factura !== nuevo) {
      await prisma.tbl_servicios_proyectos.update({
        where: { id },
        data: { requiere_factura: nuevo, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
        accion: 'UPDATE',
        valor_anterior: { requiere_factura: servicio.requiere_factura },
        valor_nuevo: { requiere_factura: nuevo }, ip: req.ip
      });
    }
    res.json({ data: { id, requiere_factura: nuevo } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar la marca de facturación' });
  }
};

/**
 * Cambia la duración (días) de un servicio ya programado y regenera su grilla de
 * días + eventos de calendario. A diferencia de `actualizar` (gated a estados
 * pre-campo), esto opera también con el servicio En camino/En curso, conservando
 * los días ya trabajados con su evidencia.
 *
 * Si reducir la duración dejaría fuera días que YA tienen evidencia, responde 409
 * con `requiere_confirmacion: true`; el cliente debe reenviar con `confirmar: true`.
 */
const cambiarDuracion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const confirmar = req.body.confirmar === true || req.body.confirmar === 1;
    const nuevaDuracion = Math.max(1, parseInt(req.body.duracion_dias, 10) || 0);
    if (!nuevaDuracion) return res.status(400).json({ error: 'Duración inválida (mínimo 1 día)' });

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      select: { id: true, estado_servicio: true, duracion_dias: true, fecha_programada: true }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (!servicio.fecha_programada) {
      return res.status(400).json({ error: 'El servicio no tiene fecha programada: prográmela antes de definir la duración' });
    }
    // Editable desde que está programado hasta que está En curso (no en borrador
    // ni una vez finalizado/cancelado).
    const editables = ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso'];
    if (!editables.includes(servicio.estado_servicio)) {
      return res.status(409).json({ error: `No se puede cambiar la duración de un servicio en estado "${servicio.estado_servicio}"` });
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.tbl_servicios_proyectos.update({
          where: { id },
          data: { duracion_dias: nuevaDuracion, user_id_modification: req.user.id, date_time_modification: new Date() }
        });
        await sincronizarDiasYEventos(tx, id, { userId: req.user.id, confirmar });
      });
    } catch (e) {
      if (e instanceof ConfirmacionRequeridaError || e.code === 'REQUIERE_CONFIRMACION') {
        return res.status(409).json({
          error: 'Reducir la duración eliminaría días que ya tienen evidencia',
          requiere_confirmacion: true,
          dias_con_evidencia: e.diasConEvidencia || []
        });
      }
      throw e;
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'UPDATE',
      valor_anterior: { duracion_dias: servicio.duracion_dias },
      valor_nuevo: { duracion_dias: nuevaDuracion }, ip: req.ip
    });
    sincronizarRecordatorioServicio(id).catch(err => console.error('Sync recordatorio:', err));
    res.json({ ok: true, duracion_dias: nuevaDuracion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar la duración: ' + err.message });
  }
};

module.exports = {
  listar, obtener, crear, actualizar, cambiarEstado,
  asignarTecnicos, iniciarServicio, finalizarServicio, cancelar, eliminar, realizados,
  promoverBorrador, revisarServicio, cambiarRequiereFactura, cambiarDuracion,
  crearGuia, actualizarGuia, eliminarGuia
};

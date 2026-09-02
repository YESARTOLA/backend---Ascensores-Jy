const prisma = require('../config/prisma');
const { ESTADO_EVENTO_FINALIZADO, ESTADO_EVENTO_CANCELADO } = require('../utils/estadoEvento');
const { registrarAuditoria } = require('../utils/auditoria');
// Roles con visibilidad de datos económicos (SSoT compartido con el resto del backend).
const { ROLES_FINANZAS: ROLES_PRECIO } = require('../utils/visibilidadFinanzas');
const { esRolGestion, motivoBloqueo } = require('../utils/registrosTecnico');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const {
  cambiarEstadoServicio,
  cambiarEstadoServicioSiEstaEn,
  esServicioEditable,
  esServicioPostRevision,
  estaServicioFinalizado,
  ESTADO_SERVICIO_PENDIENTE,
  ESTADO_SERVICIO_ASIGNADO,
  ESTADO_SERVICIO_EN_CURSO,
  ESTADO_SERVICIO_FINALIZADO,
  ESTADOS_SERVICIO,
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
  calcularEstadoFacturacion,
  whereGrupoFacturacion,
  esPorFacturar,
  esFacturado
} = require('../utils/estadoFactura');
const { MONEDA_POR_DEFECTO } = require('../utils/catalogosBancarios');
const { combinarFechaHoraLima, parseYMDLima, parseYMDFinDiaLima, parseYMDUTC, ymdDeFecha, addDiasYMD } = require('../utils/tiempo');
const { crearCobroInicial } = require('../utils/crearCobroInicial');
const {
  sincronizarRecordatorioServicio,
  sincronizarRecordatorioRevisarServicio,
  sincronizarRecordatorioFacturarServicio,
  sincronizarRecordatorioAvisoFinalizacion
} = require('../utils/recordatoriosAuto');
const {
  sincronizarDiasYEventos,
  fechasProgramadas,
  reprogramarConservandoForma,
  ConfirmacionRequeridaError
} = require('../utils/diasServicio');
const {
  normalizarProgramacion,
  agruparEnTramos,
  ProgramacionInvalidaError
} = require('../utils/programacionDias');
const { paginar } = require('../utils/paginacion');
const { registrarActividadTecnico } = require('../utils/actividadTecnico');
const { validarConsistenciaAsignaciones } = require('../utils/asignacionesValidaciones');
const { replicarEnModulo } = require('../utils/replicarEnModulo');
const { clasificarTipoServicio } = require('../utils/clasificacionServicio');
const { aplicaAlcance, aplicaAlcanceEdificio, tiposRegistroPermitidos, puedeVerTipoRegistro, tiposEdificioPermitidos, porJunctionAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');
const { visibilidadPorJunctionWhere, aplicarVisibilidadWhere, servicioVisiblePorEdificio } = require('../utils/visibilidadEdificio');
const { materializarSiguienteEventoDelPlan } = require('./mantenimientosController');
const { liberarVisitasDeServicio } = require('../utils/planMantenimientoMensual');
const { validarAscensores, repartirParejo } = require('../utils/ascensoresMonto');
const { datosSitioParaServicio, normalizarCuartoMaquinas } = require('../utils/datosSitioAscensor');
const configuracion = require('../utils/configuracion');
const { estadoPlazoCierre } = require('../utils/plazoCierre');

/**
 * Estado del plazo que tiene el técnico para cerrar el servicio, leyendo el
 * parámetro configurable SERVICIO_CIERRE_PLAZO_DIAS.
 */
async function plazoCierreDeServicio(servicio) {
  const dias = await configuracion.obtener('SERVICIO_CIERRE_PLAZO_DIAS');
  return estadoPlazoCierre(servicio, dias);
}

/**
 * N días corridos desde una fecha, en 'YYYY-MM-DD'. Es la semántica del campo
 * legacy `duracion_dias` cuando el formulario no manda una programación por
 * tramos: el trabajo ocupa N días seguidos desde la fecha programada.
 */
function diasCorridos(fechaInicio, n) {
  const inicio = ymdDeFecha(fechaInicio);
  if (!inicio) return null;
  return Array.from({ length: Math.max(1, Number(n) || 1) }, (_, i) => addDiasYMD(inicio, i));
}

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
 * Retira del detalle todo bloque económico (cobros y facturas, con sus montos,
 * pagos y cuotas) para los roles sin visibilidad financiera. Complementa a
 * `sanitizarPrecio` (que solo anula precio_interno/monto): el técnico y el
 * coordinador únicamente ven la información operativa del servicio.
 *
 * De la cotización de origen les llega SOLO el alcance del trabajo: los ítems y
 * las fotos de esos ítems. Los archivos ADJUNTOS de la cotización no viajan —ni
 * siquiera las imágenes—: son el expediente comercial del acuerdo (cotización
 * firmada, orden de compra, presupuestos, capturas de conversaciones) y no hacen
 * falta para ejecutar el trabajo.
 *
 * Diferencia entre ambos respecto a la cotización de origen:
 *  - técnico: no ve ni el código ni el enlace (solo ítems y fotos, más abajo).
 *  - coordinador: sí ve el código y puede abrir la cotización, que el módulo de
 *    cotizaciones le entrega igualmente sin adjuntos ni datos financieros.
 */
function sanitizarEconomico(servicio, rolCodigo) {
  if (!servicio || ROLES_PRECIO.includes(rolCodigo)) return servicio;
  const clon = { ...servicio };
  delete clon.cobro;
  delete clon.facturas;
  if (clon.cotizacion) {
    // Ningún adjunto de la cotización viaja al servicio: lo operativo son los
    // ítems y sus fotos, que van dentro de cada versión.
    clon.cotizacion = { ...clon.cotizacion, archivos: [] };
    if (rolCodigo === 'tecnico') {
      const { id, codigo, estado_global, ...restoCot } = clon.cotizacion;
      clon.cotizacion = restoCot;
    }
  }
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
          // lat/lng del edificio: el panel del técnico ofrece "Cómo llegar" sobre
          // la propia tarjeta del servicio. Sin estos dos campos el botón no se
          // pintaba nunca, porque `coordsDe` no encontraba coordenadas.
          ascensores: { where: { estado: 1 }, include: { ascensor: { select: { id: true, codigo: true, ubicacion: true, contacto_nombre: true, contacto_telefono: true, edificio: { select: { id: true, nombre: true, tipo: true, distrito: true, direccion: true, latitud: true, longitud: true } } } } } },
          tipo_servicio: true,
          asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
          // Días programados: el panel del técnico agrupa por ellos ("hoy",
          // "próximos 7 días"). Con días no corridos, `fecha_programada` solo
          // marca el primero y no basta para saber si se trabaja hoy.
          dias: { where: { estado: 1 }, orderBy: { fecha: 'asc' }, select: { id: true, orden: true, fecha: true } }
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

/**
 * Correctivos anteriores del MISMO ascensor, para mostrarlos como antecedentes
 * en el detalle de un correctivo. Excluye el que se está viendo.
 *
 * Devuelve la falla reportada y, cuando el servicio ya se ejecutó, lo que el
 * técnico dejó escrito (observaciones y descargo): sin eso el historial diría
 * qué se rompió pero no qué se hizo, que es la mitad útil.
 *
 * No lleva ningún dato económico, así que sirve igual para el técnico —que no
 * ve precios— sin pasar por los sanitizadores.
 */
async function correctivosDelAscensor(idAscensor, idCorrectivoActual) {
  const previos = await prisma.tbl_correctivos.findMany({
    where: {
      estado: 1,
      id_ascensor: idAscensor,
      id: { not: idCorrectivoActual }
    },
    orderBy: { fecha_reporte: 'desc' },
    take: 50,
    select: {
      id: true,
      falla: true,
      nivel_urgencia: true,
      estado_correctivo: true,
      fecha_reporte: true,
      servicio: {
        select: {
          id: true,
          codigo: true,
          estado_servicio: true,
          fecha_programada: true,
          asignaciones: {
            where: { estado: 1 },
            select: { tecnico: { select: { id: true, nombre: true } } }
          },
          servicio_realizado: {
            select: { fecha_realizacion: true, observaciones_tecnicas: true, descargo_tecnico: true }
          }
        }
      }
    }
  });
  // Se aplana lo que la UI necesita para pintar una fila, en vez de obligarla a
  // navegar tres niveles de relación por cada ítem.
  return previos.map(c => ({
    id: c.id,
    id_servicio: c.servicio?.id || null,
    codigo: c.servicio?.codigo || null,
    falla: c.falla,
    nivel_urgencia: c.nivel_urgencia,
    estado_correctivo: c.estado_correctivo,
    estado_servicio: c.servicio?.estado_servicio || null,
    fecha_reporte: c.fecha_reporte,
    fecha_realizacion: c.servicio?.servicio_realizado?.fecha_realizacion || null,
    observaciones_tecnicas: c.servicio?.servicio_realizado?.observaciones_tecnicas || null,
    descargo_tecnico: c.servicio?.servicio_realizado?.descargo_tecnico || null,
    tecnicos: (c.servicio?.asignaciones || []).map(a => a.tecnico?.nombre).filter(Boolean)
  }));
}

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
            // Adjuntos de la cotización (fotos de referencia del trabajo). El
            // técnico no ve la cotización, pero sí estas imágenes en el servicio.
            archivos: {
              where: { estado: 1 },
              orderBy: { orden: 'asc' },
              select: {
                id: true,
                archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } }
              }
            },
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
        guias: { include: { archivo: true, tecnico: true } },
        evidencias: { where: { estado: 1 }, include: { archivo: true, tecnico: true } },
        entregas: { include: { archivo: true } },
        cobro: { include: { pagos: { where: { estado: 1 }, include: { archivo: true } }, cuotas: { where: { estado: 1 } } } },
        facturas: { include: { archivo: true } },
        historial_estados: { orderBy: { fecha_cambio: 'desc' } },
        // La OT es del servicio, no del folder contable (relación "ServicioOt").
        archivo_ot: true,
        servicio_realizado: true,
        finalizacion_checklist: { include: { archivo_pdf: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } } } }
      }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    // Ámbito: un servicio/proyecto fuera del ámbito no es accesible ni por URL.
    // Vía `puedeVerTipoRegistro`, que ya contempla el caso "rol acotado pero con
    // TODOS los ámbitos habilitados" — ahí `tiposRegistroPermitidos` devuelve
    // null (sin restricción) y llamar a .includes() sobre él reventaba con un 500.
    if (!puedeVerTipoRegistro(req.user, servicio.tipo_registro)) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
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
    const data = sanitizarEconomico(
      sanitizarPrecio(servicio, req.user.rol_codigo),
      req.user.rol_codigo
    );
    // Plazo que tiene el técnico para registrar el cierre (y si el super admin ya
    // lo habilitó fuera de plazo). Lo consume el panel del técnico para explicar
    // el bloqueo y el detalle del servicio para ofrecer la habilitación.
    data.plazo_cierre = await plazoCierreDeServicio(servicio);
    // Antecedentes del EQUIPO: si esto es un correctivo, qué otros correctivos
    // se le hicieron al mismo ascensor. El técnico llega a la máquina sabiendo
    // qué se le reportó y qué se hizo antes, que es lo que evita repetir un
    // diagnóstico ya descartado. Se calcula solo para correctivos.
    if (servicio.correctivo?.id_ascensor) {
      data.historial_correctivos_ascensor = await correctivosDelAscensor(
        servicio.correctivo.id_ascensor,
        servicio.correctivo.id
      );
    }
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

    // Programación de los días de trabajo. `dias` admite rangos y/o fechas
    // sueltas en cualquier combinación (ver utils/programacionDias); si no viene,
    // se conserva el formato clásico fecha_programada + duracion_dias corridos.
    let fechasProgramacion;
    try { fechasProgramacion = normalizarProgramacion(d.dias ?? null); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const duracionDias = fechasProgramacion
      ? fechasProgramacion.length
      : Math.max(1, parseInt(d.duracion_dias, 10) || 1);
    // La fecha programada es SIEMPRE el primer día del trabajo: con programación
    // por tramos se deriva de ella, no del campo suelto del formulario.
    const fechaProgramadaInicial = fechasProgramacion
      ? parseYMDLima(fechasProgramacion[0])
      : parseYMDLima(d.fecha_programada);

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
        // Contacto en sitio y cuarto de máquinas: se heredan de la ficha del
        // ascensor para que el técnico los tenga sin recargarlos a mano.
        const datosSitio = await datosSitioParaServicio(tx, idsAscensores, d);
        const s = await tx.tbl_servicios_proyectos.create({
          data: {
            codigo,
            tipo_registro: tipoRegistro,
            id_tipo_servicio: Number(d.id_tipo_servicio),
            id_cliente: Number(d.id_cliente),
            origen: origenDerivado,
            titulo: d.titulo || `Servicio ${codigo}`,
            descripcion: d.descripcion || null,
            fecha_programada: fechaProgramadaInicial,
            hora_programada: d.hora_programada || null,
            duracion_dias: duracionDias,
            fecha_estimada_entrega: d.fecha_estimada_entrega ? parseYMDLima(d.fecha_estimada_entrega) : null,
            prioridad: d.prioridad || 'media',
            estado_servicio: estadoInicial,
            precio_interno: precioProyecto,
            moneda: monedaProyecto,
            sin_cobro: d.sin_cobro ? 1 : 0,
            observaciones: d.observaciones || null,
            ...datosSitio,
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
          fechaProgramada: fechaProgramadaInicial,
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
      // Genera la grilla de días programados y un evento de calendario por día.
      await sincronizarDiasYEventos(prisma, servicio.id, {
        userId: req.user.id, fechas: fechasProgramacion
      });
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
    } else if (fechasProgramacion) {
      // Borrador con programación por tramos: se guarda la grilla de días para no
      // perder las fechas cargadas, pero SIN eventos de calendario (el borrador
      // sigue invisible en la agenda). Al promoverlo se crean sus eventos.
      await sincronizarDiasYEventos(prisma, servicio.id, {
        userId: req.user.id, fechas: fechasProgramacion, sinEventos: true
      });
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
    // servicio sale a campo (En curso / Finalizado...) la edición
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

    // Programación de los días de trabajo. `dias` (rangos y/o fechas sueltas)
    // manda sobre fecha_programada/duracion_dias: la fecha programada pasa a ser
    // el primer día del tramo y la duración, la cantidad de días programados.
    let fechasProgramacion;
    try { fechasProgramacion = normalizarProgramacion(d.dias ?? null); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const nuevaFechaProgramada = fechasProgramacion
      ? parseYMDLima(fechasProgramacion[0])
      : (d.fecha_programada ? parseYMDLima(d.fecha_programada) : previo.fecha_programada);
    const nuevaHoraProgramada = d.hora_programada ?? previo.hora_programada;
    const nuevaDuracionDias = fechasProgramacion
      ? fechasProgramacion.length
      : (d.duracion_dias !== undefined
        ? Math.max(1, parseInt(d.duracion_dias, 10) || 1)
        : previo.duracion_dias);
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
      if ((cambiaFechaHora || cambiaTitulo || cambiaDuracion || fechasProgramacion) && nuevaFechaProgramada) {
        // Qué fechas materializar:
        //  - `dias` explícitos: mandan tal cual;
        //  - cambió la duración sin `dias`: días corridos desde la fecha (clásico);
        //  - solo se movió la fecha: se desplaza la programación vigente
        //    conservando su forma (10/15/20 movido una semana → 17/22/27);
        //  - nada de lo anterior: null, se conserva la grilla y solo se
        //    re-etiquetan los eventos (cambio de título/hora).
        let fechas = fechasProgramacion;
        if (!fechas && !cambiaDuracion && cambiaFechaHora && d.fecha_programada !== undefined) {
          fechas = await reprogramarConservandoForma(prisma, id, {
            nuevoInicio: String(d.fecha_programada).substring(0, 10)
          });
        }
        if (!fechas && cambiaDuracion) {
          fechas = diasCorridos(nuevaFechaProgramada, nuevaDuracionDias);
        }
        // `actualizar` solo opera en estados pre-campo (esServicioEditable), donde
        // aún no hay evidencia: regenerar es seguro sin pedir confirmación.
        await sincronizarDiasYEventos(prisma, id, { userId: req.user.id, confirmar: true, fechas });
      }
    } else if (fechasProgramacion || cambiaDuracion) {
      // El borrador conserva su programación en la grilla, todavía sin llevarla al
      // calendario (ver `crear`). Los eventos se crean al promoverlo.
      await sincronizarDiasYEventos(prisma, id, {
        userId: req.user.id, confirmar: true, sinEventos: true,
        fechas: fechasProgramacion || diasCorridos(nuevaFechaProgramada, nuevaDuracionDias)
      });
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
    if (!ESTADOS_SERVICIO.includes(estado_servicio)) {
      return res.status(400).json({ error: `Estado inválido. Use: ${ESTADOS_SERVICIO.join(', ')}` });
    }
    // Este endpoint genérico no puede usarse para cerrar ni para reabrir:
    //  - marcar "Finalizado …" a mano se saltaría la guía, las evidencias, la
    //    OT, el folder de revisión y el cobro que crea POST /:id/finalizar;
    //  - devolver a un estado operativo un servicio ya finalizado volvería a
    //    mostrar el botón "Finalizar" (doble finalización). Para devolverlo a
    //    corrección está la revisión administrativa (observar / rechazar).
    if (estado_servicio.startsWith('Finalizado')) {
      return res.status(400).json({ error: 'Para finalizar un servicio use la acción Finalizar (registra guía, evidencias y OT)' });
    }
    if (estaServicioFinalizado(previo.estado_servicio) && !estaServicioFinalizado(estado_servicio)) {
      return res.status(400).json({
        error: `El servicio está ${previo.estado_servicio}: no se puede devolver a ${estado_servicio}. Use la revisión administrativa para observarlo o rechazarlo.`
      });
    }

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

/**
 * Asigna los técnicos de un servicio y, con ellos, su fecha de programación.
 *
 * "Asignado" significa que el trabajo YA se puede ejecutar, y eso exige las dos
 * cosas a la vez: alguien que lo haga y un día en que hacerlo. Por eso la fecha
 * viaja en el mismo formulario que los técnicos: sin días programados el
 * servicio se queda en "Pendiente" aunque tenga técnico, porque no habría nada
 * en la agenda de nadie.
 *
 * Body: { tecnicos: [...], dias?: [...], fecha_programada?, hora_programada? }
 * `dias` admite rangos y fechas sueltas (ver utils/programacionDias); si no
 * viene, se conserva la programación que ya tuviera el servicio.
 */
const asignarTecnicos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { tecnicos = [] } = req.body;
    if (!Array.isArray(tecnicos) || tecnicos.length === 0) {
      return res.status(400).json({ error: 'Debe asignar al menos un técnico' });
    }

    const servicioActual = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      select: { estado_servicio: true, fecha_programada: true, hora_programada: true }
    });
    if (!servicioActual) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (servicioActual.estado_servicio === 'Borrador') {
      return res.status(400).json({ error: 'Debe promover el borrador antes de asignar técnicos' });
    }
    if (estaServicioFinalizado(servicioActual.estado_servicio)) {
      return res.status(400).json({
        error: `El servicio está ${servicioActual.estado_servicio}: ya no se pueden modificar sus técnicos`
      });
    }

    const consistencia = validarConsistenciaAsignaciones(tecnicos);
    if (!consistencia.ok) return res.status(400).json({ error: consistencia.error });

    // Programación enviada junto con los técnicos (o la que ya tuviera).
    let fechasProgramacion;
    try { fechasProgramacion = normalizarProgramacion(req.body.dias ?? null); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const horaPedida = typeof req.body.hora_programada === 'string' ? req.body.hora_programada.trim() : null;

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
          asignado_por: req.user.id,
          user_id_registration: req.user.id
        }
      });
    }

    // Programar: genera la grilla de días y sus eventos de calendario. Solo si
    // llegan días nuevos o si el servicio aún no tenía ninguno.
    if (horaPedida && horaPedida !== servicioActual.hora_programada) {
      await prisma.tbl_servicios_proyectos.update({
        where: { id },
        data: { hora_programada: horaPedida, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
    }
    if (fechasProgramacion) {
      await sincronizarDiasYEventos(prisma, id, {
        userId: req.user.id, confirmar: true, fechas: fechasProgramacion
      });
    }

    // "Asignado" exige técnico Y fecha: si el servicio sigue sin programar, se
    // queda en Pendiente para que el hueco quede a la vista en la agenda.
    const yaProgramado = !!(fechasProgramacion || servicioActual.fecha_programada);
    const estadoActual = servicioActual.estado_servicio;
    // Solo se mueve el estado en la fase previa a la ejecución: si el técnico ya
    // empezó (En curso), una reasignación administrativa no debe hacerlo retroceder.
    const enFasePrevia = [ESTADO_SERVICIO_PENDIENTE, ESTADO_SERVICIO_ASIGNADO].includes(estadoActual);
    const nuevoEstadoServicio = enFasePrevia
      ? (yaProgramado ? ESTADO_SERVICIO_ASIGNADO : ESTADO_SERVICIO_PENDIENTE)
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

    res.json({
      ok: true,
      estado: nuevoEstadoServicio,
      // El cliente avisa cuando falta la fecha: es lo único que separa el
      // servicio de quedar realmente asignado.
      falta_programar: !yaProgramado
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al asignar técnicos: ' + err.message });
  }
};

const finalizarServicio = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { observaciones_tecnicas, descargo_tecnico, codigo_guia, id_archivo_guia, finalizar_observado, id_archivos_evidencias } = req.body;
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      include: {
        asignaciones: { where: { estado: 1 } },
        guias: { where: { estado: 1 } },
        ascensores: { where: { estado: 1 } },
        // La grilla de días alimenta el cálculo del plazo de cierre: con días no
        // corridos el último día programado no es fecha_programada + duración.
        dias: { where: { estado: 1 }, orderBy: { fecha: 'asc' } }
      }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    // Un servicio solo se finaliza UNA vez. Si ya lo cerró el técnico (o ya
    // avanzó a revisión / cobro / facturación) se corta aquí con 409 para que la
    // UI recargue y deje de ofrecer el botón. El chequeo definitivo, a prueba de
    // peticiones simultáneas, es el "claim" atómico de más abajo.
    if (estaServicioFinalizado(servicio.estado_servicio)) {
      return res.status(409).json({
        error: `El servicio ya fue finalizado (${servicio.estado_servicio}): no se puede volver a finalizar`,
        estado: servicio.estado_servicio
      });
    }
    if (servicio.estado_servicio !== ESTADO_SERVICIO_EN_CURSO) {
      return res.status(400).json({ error: 'El servicio debe estar en curso para finalizarlo' });
    }
    // El cierre no vuelve a pedir documentación: la guía, las fotos y la OT se
    // registran DURANTE el servicio, cada una en su sección. Aquí todos los
    // campos son opcionales; lo único que se sigue exigiendo al técnico es tener
    // la OT cargada (más abajo), porque de ella tira el circuito administrativo.
    const sinGuia = !id_archivo_guia && servicio.guias.length === 0;
    // Checklist de finalización: OPCIONAL. La configuración de plantillas es
    // opcional y un checklist incompleto (o inexistente) no impide cerrar el
    // servicio. Si existe informe generado se conserva enlazado; si no, se cierra
    // igual. Por eso ya no se valida su existencia aquí.

    // Compatibilidad: si algún cliente todavía manda fotos en el cierre se
    // vinculan igual, pero ya no se exigen — las evidencias se suben durante el
    // servicio, no al cerrarlo.
    const evidenciasIds = Array.isArray(id_archivos_evidencias)
      ? id_archivos_evidencias.map(Number).filter(Number.isFinite)
      : [];
    // OT (Orden de Trabajo): obligatoria para técnicos al finalizar. Ya no se
    // adjunta aquí — se sube desde su propia sección del servicio, junto a la
    // guía de salida —, así que el cierre solo comprueba que esté cargada.
    // Admin/SuperAdmin pueden cerrar sin ella (destraban el caso).
    if (req.user.rol_codigo === 'tecnico' && (!servicio.numero_ot || !servicio.id_archivo_ot)) {
      return res.status(400).json({
        error: 'Debe registrar la OT (número y documento) en la sección "Orden de trabajo" antes de finalizar',
        falta_ot: true
      });
    }
    // Cerrar SIN guía marcándolo como observado sigue siendo cosa de admin: deja
    // la guía en estado "Observada" y el servicio con el distintivo "Sin guía".
    if (sinGuia && finalizar_observado && !['super_admin', 'admin'].includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'Solo Admin o Super Admin pueden finalizar como observado sin guía' });
    }

    // Plazo de cierre: el técnico dispone de SERVICIO_CIERRE_PLAZO_DIAS días
    // calendario desde el último día programado. Vencido el plazo, solo puede
    // cerrar si el super administrador habilitó ESTE servicio. Admin y super
    // admin cierran siempre (son quienes destraban el caso).
    if (req.user.rol_codigo === 'tecnico') {
      const plazo = await plazoCierreDeServicio(servicio);
      if (!plazo.puede_cerrar_tecnico) {
        return res.status(403).json({
          error: `El plazo para registrar el cierre venció el ${plazo.fecha_limite} (${plazo.plazo_dias} día(s) desde la fecha programada). Solicita al super administrador que habilite el cierre de este servicio.`,
          plazo_cierre: plazo
        });
      }
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

    // CLAIM de la finalización. Pasa el servicio a su estado final ANTES de
    // escribir guía, evidencias, folder y cobro, y solo si sigue 'En curso'.
    // Dos peticiones simultáneas (doble clic, dos pestañas, reintento de red,
    // dos usuarios a la vez) leerían ambas 'En curso' en las validaciones de
    // arriba; aquí solo una gana el UPDATE condicional y la otra se corta con
    // 409, sin duplicar guías, evidencias, historial ni cobro.
    // (cambiarEstadoServicioSiEstaEn registra el historial, sincroniza el
    // recordatorio y el estado_global de la cotización origen.)
    // Estado final ÚNICO. Un cierre sin guía no es otro estado: la guía queda en
    // "Observada" y el detalle lo muestra con su distintivo, de modo que se
    // reconoce y se puede completar después sin duplicar estados de servicio.
    const claim = await cambiarEstadoServicioSiEstaEn(
      id, [ESTADO_SERVICIO_EN_CURSO], ESTADO_SERVICIO_FINALIZADO, req.user.id,
      (sinGuia && finalizar_observado) ? 'Finalizado sin guía de salida (autorizado por admin)' : null
    );
    if (!claim) {
      const actual = await prisma.tbl_servicios_proyectos.findUnique({
        where: { id }, select: { estado_servicio: true }
      });
      return res.status(409).json({
        error: `El servicio ya fue finalizado (${actual?.estado_servicio}): no se puede volver a finalizar`,
        estado: actual?.estado_servicio
      });
    }

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

    // El estado final ya se fijó arriba, en el claim.

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
    // Transición a "En revisión administrativa" (gate previo al envío a cobros).
    // Condicionada al estado que dejó el claim: si algo movió el servicio entre
    // medias, no lo pisamos.
    await cambiarEstadoServicioSiEstaEn(
      id, [ESTADO_SERVICIO_FINALIZADO], 'En revisión administrativa',
      req.user.id, 'Servicio pendiente de revisión administrativa'
    );

    // Liberar técnicos
    for (const a of servicio.asignaciones) {
      await prisma.tbl_tecnicos.update({ where: { id: a.id_tecnico }, data: { estado_operativo: 'Disponible' } });
    }

    // Para planes continuos: auto-materializa el siguiente evento del plan
    // como servicio (queda listo para asignar técnico y cobro)
    // y actualiza `proximo_mantenimiento` de todos los ascensores del plan.
    if (servicio.id_mantenimiento_plan) {
      try {
        // La cadena avanza dentro de la serie del ASCENSOR que se acaba de
        // atender: con frecuencias distintas por ascensor, "el siguiente evento
        // del plan" pertenecería a otro ascensor y lo adelantaría.
        const siguienteServicio = await materializarSiguienteEventoDelPlan({
          idPlan: servicio.id_mantenimiento_plan,
          idServicioFinalizado: id,
          fechaServicioFinalizado: servicio.fecha_programada,
          userId: req.user.id
        });
        if (siguienteServicio) {
          // `proximo_mantenimiento` es por ascensor: solo se mueve el del
          // ascensor que cubre el servicio recién creado, no el de todo el plan.
          const idsAsc = (await prisma.tbl_servicios_ascensores.findMany({
            where: { id_servicio: siguienteServicio.id, estado: 1 },
            select: { id_ascensor: true }
          })).map(a => a.id_ascensor);
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

    // La habilitación de cierre fuera de plazo es un permiso PUNTUAL: se consume
    // al cerrarse el servicio (si se reabre, hay que volver a habilitarlo).
    if (servicio.cierre_fuera_plazo_habilitado) {
      await prisma.tbl_servicios_proyectos.update({
        where: { id },
        data: { cierre_fuera_plazo_habilitado: false, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
    }

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
    // Servicio de un plan de mantenimiento: la visita del cronograma vuelve a
    // quedar pendiente (con evento programado nuevo) — un mantenimiento
    // cancelado no se hizo y la fecha debe poder programarse de nuevo.
    if (previo.id_mantenimiento_plan) {
      await liberarVisitasDeServicio(prisma, id, req.user.id);
    }

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
          servicio: { estado_servicio: 'En curso', estado: 1 }
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

/**
 * Resumen de facturación sobre el conjunto de servicios realizados que cumple
 * `where` — el MISMO filtro que la tabla, sin paginar, para que los indicadores
 * cuadren con lo que el usuario está viendo.
 *
 * Dos grupos, los que pide Contabilidad:
 *   · por_facturar → emisión pendiente de verdad (ver `esPorFacturar`: excluye
 *     los marcados "no requiere factura" y los gratuitos).
 *   · facturado    → emisión completa ('Facturado' / 'Enviada').
 *
 * El importe de cada servicio es su total cobrable: el monto del cobro si ya
 * existe y, si no, el precio del servicio (mismo criterio que la columna
 * "Total" de la tabla y que el tope del modal de emisión). Los montos se
 * agrupan POR MONEDA: la cartera tiene servicios en PEN y en USD, y sumarlos
 * en un único número daría un total falso.
 */
async function resumenFacturacion(where) {
  const filas = await prisma.tbl_servicios_realizados.findMany({
    where,
    select: {
      estado_facturacion: true,
      servicio: {
        select: {
          moneda: true, precio_interno: true, sin_cobro: true, requiere_factura: true,
          cobro: { select: { monto_total: true } }
        }
      }
    }
  });

  const grupos = {
    por_facturar: { cantidad: 0, montos: new Map() },
    facturado: { cantidad: 0, montos: new Map() }
  };
  for (const f of filas) {
    const destino = esPorFacturar(f) ? 'por_facturar'
      : esFacturado(f.estado_facturacion) ? 'facturado'
      : null;
    if (!destino) continue;
    const g = grupos[destino];
    g.cantidad++;
    const moneda = f.servicio?.moneda || MONEDA_POR_DEFECTO;
    const total = Number(f.servicio?.cobro?.monto_total ?? f.servicio?.precio_interno ?? 0);
    g.montos.set(moneda, (g.montos.get(moneda) || 0) + (Number.isFinite(total) ? total : 0));
  }

  // El Map se serializa como array ordenado por importe descendente: la moneda
  // principal queda primero y la UI puede pintarlas todas sin adivinar.
  const aSalida = (g) => ({
    cantidad: g.cantidad,
    montos: [...g.montos.entries()]
      .map(([moneda, total]) => ({ moneda, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total)
  });
  return { por_facturar: aSalida(grupos.por_facturar), facturado: aSalida(grupos.facturado) };
}

const realizados = async (req, res) => {
  try {
    const { id_cliente, estado_cobro, estado_facturacion, desde, hasta, q, tipo_categoria, situacion, grupo_facturacion } = req.query;
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
      // documento (RUC/DNI), y del sitio tanto el CÓDIGO del ascensor como el
      // NOMBRE del edificio/obra — contabilidad busca por el nombre que conoce
      // ("Las Gardenias"), no por el código interno.
      servicioWhere.OR = [
        { codigo: { contains: q, mode: 'insensitive' } },
        { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
        { cliente: { numero_documento: { contains: q, mode: 'insensitive' } } },
        { ascensores: { some: { estado: 1, ascensor: { codigo: { contains: q, mode: 'insensitive' } } } } },
        { ascensores: { some: { estado: 1, ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } } } }
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
    // Filtro por grupo de facturación ("Por facturar" / "Facturado"): usa el
    // MISMO predicado con el que se cuentan las tarjetas del resumen, así que la
    // tabla filtrada contiene exactamente los servicios que el indicador suma.
    // Va dentro de AND para no pisar los filtros ya construidos.
    const whereGrupo = whereGrupoFacturacion(grupo_facturacion);
    if (whereGrupo) where.AND = [...(where.AND || []), whereGrupo];
    // Ámbito del usuario: solo realizados de servicios/proyectos del ámbito.
    const tiposRealizados = tiposRegistroPermitidos(req.user);
    if (tiposRealizados) servicioWhere.tipo_registro = { in: tiposRealizados.length ? tiposRealizados : ['__sin_ambito__'] };
    if (Object.keys(servicioWhere).length) where.servicio = servicioWhere;
    const result = await paginar(
      prisma.tbl_servicios_realizados,
      {
        where, orderBy: { id: 'desc' },
        include: {
          servicio: {
            include: {
              // La OT es del servicio, no de su folder contable.
              archivo_ot: true,
              cliente: true,
              ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: true } } } },
              tipo_servicio: true,
              asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
              guias: { where: { estado: 1 }, include: { archivo: true } },
              evidencias: { where: { estado: 1 } },
                    cobro: { include: { facturas: true } }
            }
          }
        }
      },
      req.query
    );
    // Resumen de facturación de TODO el conjunto filtrado (no solo de la página
    // visible): alimenta los dos indicadores de Contabilidad. Es dato económico,
    // así que solo se calcula y envía a los roles que pueden verlo.
    const resumen_facturacion = ROLES_PRECIO.includes(req.user.rol_codigo)
      ? await resumenFacturacion(where)
      : undefined;

    // El bloque de cobro/facturas del servicio solo viaja a los roles con
    // visibilidad financiera; al resto se le quita entero (no basta con anular
    // el precio: el cobro trae monto_total, saldo y las facturas sus importes).
    res.json({
      ...result,
      ...(resumen_facturacion ? { resumen_facturacion } : {}),
      data: result.data.map(r => ({
        ...r,
        servicio: sanitizarEconomico(sanitizarPrecio(r.servicio, req.user.rol_codigo), req.user.rol_codigo)
      }))
    });
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
 * Registra (o reemplaza) la ORDEN DE TRABAJO del servicio.
 *
 * La OT se sube durante la ejecución, junto a la guía de salida, no al cerrar:
 * es el documento que el técnico trae firmado de la obra. Vive en el servicio,
 * así que de aquí la leen el cierre, Contabilidad, Gestión de cobros y los
 * reportes — una sola fuente, sin copias que se desincronicen.
 *
 * Body: { numero_ot, id_archivo }
 */
const guardarOt = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { numero_ot, id_archivo } = req.body || {};
    const numero = typeof numero_ot === 'string' ? numero_ot.trim() : '';
    const idArchivo = Number.isFinite(Number(id_archivo)) && Number(id_archivo) > 0
      ? Number(id_archivo)
      : null;
    if (!numero) return res.status(400).json({ error: 'El número de OT es obligatorio' });
    if (!idArchivo) return res.status(400).json({ error: 'Debe adjuntar el documento de la OT' });

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      select: {
        id: true, estado: true, estado_servicio: true, numero_ot: true, id_archivo_ot: true,
        asignaciones: { where: { estado: 1 }, select: { id_tecnico: true, responsable_documentacion: true } }
      }
    });
    if (!servicio || servicio.estado !== 1) return res.status(404).json({ error: 'Servicio no encontrado' });
    // Una vez que el servicio pasó a revisión/cobro su documentación queda
    // congelada: corregir la OT ahí cambiaría lo que contabilidad ya revisó.
    if (esServicioPostRevision(servicio.estado_servicio)) {
      return res.status(409).json({
        error: `El servicio está en "${servicio.estado_servicio}": la OT ya no se puede modificar`
      });
    }
    // El técnico solo toca la OT de un servicio suyo (mismo criterio que la guía).
    if (req.user.rol_codigo === 'tecnico'
        && !puedeUsuarioGestionarGuia(req.user, servicio.asignaciones)) {
      return res.status(403).json({ error: 'Solo el responsable documental puede registrar la OT' });
    }

    const actualizado = await prisma.tbl_servicios_proyectos.update({
      where: { id },
      data: {
        numero_ot: numero,
        id_archivo_ot: idArchivo,
        ot_subida_por: req.user.id,
        ot_subida_en: new Date(),
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      },
      include: { archivo_ot: true }
    });

    // Subir la OT es trabajo del técnico: enciende "En curso" si hacía falta.
    await registrarActividadTecnico(id, req.user.id, 'Orden de trabajo registrada');

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'UPDATE',
      valor_anterior: { numero_ot: servicio.numero_ot, id_archivo_ot: servicio.id_archivo_ot },
      valor_nuevo: { numero_ot: numero, id_archivo_ot: idArchivo }, ip: req.ip
    });
    res.json({
      data: {
        numero_ot: actualizado.numero_ot,
        id_archivo_ot: actualizado.id_archivo_ot,
        archivo_ot: actualizado.archivo_ot,
        ot_subida_en: actualizado.ot_subida_en
      }
    });
  } catch (err) {
    console.error('[servicios.guardarOt]', err);
    res.status(500).json({ error: 'Error al registrar la OT: ' + err.message });
  }
};

/**
 * Quita la OT del servicio (para volver a subirla corregida). El archivo se da
 * de baja para que no quede huérfano en el almacén.
 */
const eliminarOt = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      select: { id: true, estado: true, estado_servicio: true, numero_ot: true, id_archivo_ot: true }
    });
    if (!servicio || servicio.estado !== 1) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (esServicioPostRevision(servicio.estado_servicio)) {
      return res.status(409).json({
        error: `El servicio está en "${servicio.estado_servicio}": la OT ya no se puede modificar`
      });
    }
    if (!servicio.numero_ot && !servicio.id_archivo_ot) {
      return res.status(400).json({ error: 'El servicio no tiene OT registrada' });
    }

    await prisma.tbl_servicios_proyectos.update({
      where: { id },
      data: {
        numero_ot: null, id_archivo_ot: null, ot_subida_por: null, ot_subida_en: null,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    if (servicio.id_archivo_ot) {
      await prisma.tbl_archivos.updateMany({
        where: { id: servicio.id_archivo_ot, estado: 1 },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'UPDATE',
      valor_anterior: { numero_ot: servicio.numero_ot, id_archivo_ot: servicio.id_archivo_ot },
      valor_nuevo: { numero_ot: null, id_archivo_ot: null }, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[servicios.eliminarOt]', err);
    res.status(500).json({ error: 'Error al eliminar la OT: ' + err.message });
  }
};

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

    // La guía es trabajo del técnico: si el servicio seguía en Pendiente/Asignado,
    // este registro es lo que lo pone En curso.
    await registrarActividadTecnico(id_servicio, req.user.id, 'Guía de salida registrada');

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

    await registrarActividadTecnico(guiaPrevia.id_servicio, req.user.id, 'Guía de salida actualizada');

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

/**
 * Corrige el INFORME DE CIERRE que dejó el técnico: sus observaciones técnicas
 * y el descargo. Vive en tbl_servicios_realizados y hasta ahora no lo podía
 * editar nadie — si el técnico se equivocaba al finalizar, el texto quedaba así
 * para siempre en el expediente y en el informe.
 *
 * El N° de OT y su documento tienen sus propios endpoints (PUT/DELETE
 * /:id/ot), que ya contemplan a coordinación con el mismo corte.
 */
const actualizarInformeTecnico = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const realizado = await prisma.tbl_servicios_realizados.findFirst({
      where: { id_servicio: id, estado: 1 },
      include: { servicio: { select: { id: true, codigo: true, estado_servicio: true } } }
    });
    if (!realizado) {
      return res.status(404).json({ error: 'Este servicio todavía no tiene informe de cierre' });
    }
    const bloqueo = motivoBloqueo(req.user, realizado.servicio, 'editar el informe del técnico');
    if (bloqueo) {
      return res.status(esRolGestion(req.user) ? 400 : 403).json({ error: bloqueo });
    }

    const data = { user_id_modification: req.user.id, date_time_modification: new Date() };
    // Solo se tocan los campos presentes: así corregir el descargo no borra las
    // observaciones por venir ausentes en el payload.
    for (const campo of ['observaciones_tecnicas', 'descargo_tecnico']) {
      if (req.body?.[campo] !== undefined) {
        const v = String(req.body[campo] ?? '').trim();
        data[campo] = v || null;
      }
    }
    if (Object.keys(data).length === 2) {
      return res.status(400).json({ error: 'No hay cambios que guardar' });
    }

    const actualizado = await prisma.tbl_servicios_realizados.update({ where: { id: realizado.id }, data });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_realizados', id_entidad: realizado.id,
      accion: 'UPDATE', valor_anterior: realizado, valor_nuevo: actualizado, ip: req.ip
    });
    res.json({ data: actualizado });
  } catch (err) {
    console.error('[servicios.actualizarInformeTecnico]', err);
    res.status(500).json({ error: 'Error al actualizar el informe del técnico' });
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
    // Servicio de un plan de mantenimiento: liberar su visita del cronograma
    // (vuelve a pendiente, con evento programado nuevo) para que la fecha
    // pueda materializarse otra vez.
    if (previo.id_mantenimiento_plan) {
      await liberarVisitasDeServicio(prisma, id, req.user.id);
    }
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
          servicio: { estado_servicio: 'En curso', estado: 1 }
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
    // Gratuito ⇒ sin factura (utils/gratuidadServicio): no se factura lo que no
    // se cobra. Para facturarlo hay que quitarle antes la marca de sin costo.
    if (nuevo === 1 && servicio.sin_cobro === 1) {
      return res.status(409).json({ error: 'El servicio está marcado sin costo: no se puede facturar. Quítele la gratuidad primero si debe cobrarse.' });
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
 * Guarda los datos operativos que el coordinador carga desde el card "Datos"
 * del detalle de servicio: contacto en sitio (nombre + teléfono) y si el
 * edificio tiene cuarto de máquinas.
 *
 * A diferencia de `actualizar` (super_admin/admin y solo en estados pre-campo),
 * esto lo puede hacer el coordinador y también con el servicio ya en curso: es
 * información de apoyo para el técnico, no toca precios, fechas ni estados.
 * Solo se bloquea con el servicio cancelado.
 */
const actualizarDatosContacto = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body || {};
    const previo = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      select: {
        id: true, estado: true, estado_servicio: true,
        contacto_nombre: true, contacto_telefono: true, cuarto_maquinas: true
      }
    });
    if (!previo || previo.estado === 0) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (previo.estado_servicio === 'Cancelado') {
      return res.status(409).json({ error: 'El servicio está cancelado: no se pueden editar sus datos.' });
    }

    // Cada campo solo se toca si viene en el body (edición parcial). Cadena
    // vacía = limpiar el dato.
    const limpiar = (v, max) => {
      const t = String(v ?? '').trim();
      return t === '' ? null : t.slice(0, max);
    };
    const data = { user_id_modification: req.user.id, date_time_modification: new Date() };
    if (d.contacto_nombre !== undefined) data.contacto_nombre = limpiar(d.contacto_nombre, 150);
    if (d.contacto_telefono !== undefined) data.contacto_telefono = limpiar(d.contacto_telefono, 30);
    if (d.cuarto_maquinas !== undefined) {
      const cm = normalizarCuartoMaquinas(d.cuarto_maquinas);
      if (cm.error) return res.status(400).json({ error: cm.error });
      data.cuarto_maquinas = cm.valor;
    }

    const servicio = await prisma.tbl_servicios_proyectos.update({ where: { id }, data });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'UPDATE',
      valor_anterior: {
        contacto_nombre: previo.contacto_nombre,
        contacto_telefono: previo.contacto_telefono,
        cuarto_maquinas: previo.cuarto_maquinas
      },
      valor_nuevo: {
        contacto_nombre: servicio.contacto_nombre,
        contacto_telefono: servicio.contacto_telefono,
        cuarto_maquinas: servicio.cuarto_maquinas
      },
      ip: req.ip
    });
    res.json({
      data: {
        id,
        contacto_nombre: servicio.contacto_nombre,
        contacto_telefono: servicio.contacto_telefono,
        cuarto_maquinas: servicio.cuarto_maquinas
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar los datos del servicio' });
  }
};

/**
 * Reprograma los DÍAS DE TRABAJO de un servicio ya programado y regenera su
 * grilla de días + eventos de calendario. A diferencia de `actualizar` (gated a
 * estados pre-campo), esto opera también con el servicio En curso,
 * conservando los días ya trabajados con su evidencia.
 *
 * Body (una de las dos formas):
 *   - `dias`: programación por tramos — rangos { desde, hasta } y/o fechas
 *     sueltas 'YYYY-MM-DD', en cualquier combinación. Es la forma completa: sirve
 *     para "del 10 al 14", para "el 10, el 15 y el 20" y para mezclas de ambas.
 *   - `duracion_dias`: atajo clásico de N días CORRIDOS desde la fecha programada.
 * Opcionalmente `hora_programada` mueve la hora de todos los días.
 *
 * Si la nueva programación dejaría fuera días que YA tienen evidencia, responde
 * 409 con `requiere_confirmacion: true`; el cliente reenvía con `confirmar: true`.
 */
const cambiarProgramacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const confirmar = req.body.confirmar === true || req.body.confirmar === 1;

    let fechas;
    try { fechas = normalizarProgramacion(req.body.dias ?? null); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      select: {
        id: true, estado_servicio: true, duracion_dias: true,
        fecha_programada: true, hora_programada: true
      }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });

    // Sin `dias` se usa el atajo por duración: N días corridos desde la fecha
    // programada (que en ese caso tiene que existir).
    if (!fechas) {
      const nuevaDuracion = Math.max(1, parseInt(req.body.duracion_dias, 10) || 0);
      if (!nuevaDuracion) {
        return res.status(400).json({ error: 'Indique los días de trabajo o una duración (mínimo 1 día)' });
      }
      if (!servicio.fecha_programada) {
        return res.status(400).json({ error: 'El servicio no tiene fecha programada: prográmela antes de definir la duración' });
      }
      fechas = diasCorridos(servicio.fecha_programada, nuevaDuracion);
    }

    // Reprogramable desde el borrador hasta que está En curso (no una vez
    // finalizado/cancelado). El borrador guarda sus días pero NO los lleva al
    // calendario: sigue invisible en la agenda hasta que se promueve.
    const editables = ['Borrador', ESTADO_SERVICIO_PENDIENTE, ESTADO_SERVICIO_ASIGNADO, ESTADO_SERVICIO_EN_CURSO];
    if (!editables.includes(servicio.estado_servicio)) {
      return res.status(409).json({ error: `No se puede reprogramar un servicio en estado "${servicio.estado_servicio}"` });
    }
    const esBorrador = servicio.estado_servicio === 'Borrador';

    const horaPedida = typeof req.body.hora_programada === 'string' ? req.body.hora_programada.trim() : null;
    const programacionAnterior = await fechasProgramadas(prisma, id);

    try {
      await prisma.$transaction(async (tx) => {
        if (horaPedida && horaPedida !== servicio.hora_programada) {
          await tx.tbl_servicios_proyectos.update({
            where: { id },
            data: { hora_programada: horaPedida, user_id_modification: req.user.id, date_time_modification: new Date() }
          });
        }
        // sincronizarDiasYEventos deriva fecha_programada y duracion_dias de la
        // grilla, así que no hay que tocarlos aquí.
        await sincronizarDiasYEventos(tx, id, { userId: req.user.id, confirmar, fechas, sinEventos: esBorrador });
      }, { timeout: 20000 });
    } catch (e) {
      if (e instanceof ConfirmacionRequeridaError || e.code === 'REQUIERE_CONFIRMACION') {
        return res.status(409).json({
          error: 'La nueva programación dejaría fuera días que ya tienen evidencia',
          requiere_confirmacion: true,
          dias_con_evidencia: e.diasConEvidencia || []
        });
      }
      if (e instanceof ProgramacionInvalidaError || e.code === 'PROGRAMACION_INVALIDA') {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'UPDATE',
      valor_anterior: { duracion_dias: servicio.duracion_dias, dias: programacionAnterior },
      valor_nuevo: { duracion_dias: fechas.length, dias: fechas }, ip: req.ip
    });
    sincronizarRecordatorioServicio(id).catch(err => console.error('Sync recordatorio:', err));
    res.json({
      ok: true,
      duracion_dias: fechas.length,
      fecha_programada: fechas[0],
      dias: fechas,
      tramos: agruparEnTramos(fechas)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al reprogramar el servicio: ' + err.message });
  }
};

/**
 * Habilita (o revoca) el cierre fuera de plazo de UN servicio. Solo super admin.
 *
 * El técnico tiene SERVICIO_CIERRE_PLAZO_DIAS días desde el último día programado
 * para registrar el cierre; vencido el plazo queda bloqueado y necesita esta
 * habilitación puntual, que se consume cuando el servicio se finaliza.
 *
 * Body: { habilitar: true | false }  (default true)
 */
const habilitarCierreFueraPlazo = async (req, res) => {
  try {
    if (req.user.rol_codigo !== 'super_admin') {
      return res.status(403).json({ error: 'Solo el super administrador puede habilitar un cierre fuera de plazo' });
    }
    const id = Number(req.params.id);
    const habilitar = req.body?.habilitar === undefined ? true : Boolean(req.body.habilitar);

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      select: {
        id: true, codigo: true, estado: true, estado_servicio: true,
        fecha_programada: true, duracion_dias: true,
        cierre_fuera_plazo_habilitado: true,
        dias: { where: { estado: 1 }, orderBy: { fecha: 'asc' }, select: { fecha: true, estado: true } }
      }
    });
    if (!servicio || servicio.estado !== 1) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (estaServicioFinalizado(servicio.estado_servicio)) {
      return res.status(409).json({ error: `El servicio ya fue finalizado (${servicio.estado_servicio})` });
    }

    await prisma.tbl_servicios_proyectos.update({
      where: { id },
      data: {
        cierre_fuera_plazo_habilitado: habilitar,
        cierre_habilitado_por: habilitar ? req.user.id : null,
        cierre_habilitado_en: habilitar ? new Date() : null,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: id,
      accion: 'UPDATE',
      valor_anterior: { cierre_fuera_plazo_habilitado: servicio.cierre_fuera_plazo_habilitado },
      valor_nuevo: { cierre_fuera_plazo_habilitado: habilitar }, ip: req.ip
    });

    const plazo = await plazoCierreDeServicio({ ...servicio, cierre_fuera_plazo_habilitado: habilitar });
    res.json({ ok: true, plazo_cierre: plazo });
  } catch (err) {
    console.error('[servicios.habilitarCierreFueraPlazo]', err);
    res.status(500).json({ error: 'Error al habilitar el cierre: ' + err.message });
  }
};

module.exports = {
  listar, obtener, crear, actualizar, cambiarEstado,
  asignarTecnicos, finalizarServicio, cancelar, eliminar, realizados,
  promoverBorrador, revisarServicio, cambiarRequiereFactura, cambiarProgramacion,
  actualizarDatosContacto, habilitarCierreFueraPlazo,
  crearGuia, actualizarGuia, eliminarGuia, actualizarInformeTecnico,
  guardarOt, eliminarOt
};

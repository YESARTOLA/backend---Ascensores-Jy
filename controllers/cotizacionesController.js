const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima, parseYMDFinDiaLima, inicioDelDiaLima, ymdLima } = require('../utils/tiempo');
const { generarCodigoCotizacion } = require('../utils/codigoCotizacion');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { datosSitioParaServicio } = require('../utils/datosSitioAscensor');
const { calcularTotalesVersion, normalizarPlanCuotas } = require('../utils/cotizacionCalculos');
const { crearCobroInicial } = require('../utils/crearCobroInicial');
const { sincronizarRecordatorioServicio } = require('../utils/recordatoriosAuto');
const { replicarEnModulo } = require('../utils/replicarEnModulo');
const { clasificarTipoServicio } = require('../utils/clasificacionServicio');
const { estaServicioFinalizado } = require('../utils/estadoServicio');
const configuracion = require('../utils/configuracion');
const { ESTADO_FACTURACION_SIN } = require('../utils/estadoFactura');
const { ESTADO_LEAD_COTIZADO, ESTADO_LEAD_INGRESADO, ESTADO_LEAD_DESCARTADO } = require('../utils/estadoLead');
const { bajaArchivoEnTx, purgarObjetosWasabi, bajaServicioCascadaEnTx, liberarTecnicos } = require('../utils/reversionEliminacion');
const { tiposRegistroPermitidos, cotizacionAlcanceWhere, puedeVerTipoRegistro, conAlcance } = require('../utils/alcanceUsuario');
const { mapaUsuariosPorId } = require('../utils/resolverUsuarios');

// Categoría funcional (del tipo padre) que corresponde a cada ámbito. Se usa para
// acotar las cotizaciones que ve un usuario de área (servicios / proyectos).
function categoriasFuncionalesDeAmbito(user) {
  const tipos = tiposRegistroPermitidos(user); // null = sin restricción
  if (!tipos) return null;
  return tipos.map(t => (t === 'proyecto' ? 'PROYECTOS' : 'SERVICIOS'));
}

// El listado y el acceso por id se filtran por ámbito (un usuario acotado a un
// área solo ve/gestiona las cotizaciones de esa área).
const ROLES_VER = ['super_admin', 'admin', 'contabilidad'];
const ROLES_EDIT = ['super_admin', 'admin'];

// Catálogos de estado: viven en utils/estadoCotizacion.js para que el listado
// (y su filtro) los consuman del backend en vez de repetirlos a mano.
//   - estado_version: crear (Cotizado) → decidir (Aprobado | Rechazado).
//   - estado_global: derivado del servicio asociado; nunca se setea a mano.
const {
  ESTADOS_VERSION,
  ESTADO_GLOBAL,
  ESTADOS_GLOBALES,
  ESTADOS_VERSION_LISTA,
  FILTROS_GLOBALES,
  resolverFiltroGlobal,
  rangoEsPorFechaAceptacion
} = require('../utils/estadoCotizacion');

function puedeVer(req) {
  return ROLES_VER.includes(req.user?.rol_codigo);
}

function puedeEditar(req) {
  return ROLES_EDIT.includes(req.user?.rol_codigo);
}

function hoyDate() {
  // Inicio del día actual en Lima TZ — evita corrimiento de día cuando el
  // servidor corre en UTC (Railway) y el reloj de Lima va atrás 5 h.
  return inicioDelDiaLima();
}

// Texto opcional: '' / '   ' se guardan como NULL (así el PDF omite el bloque).
function trimOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * Normaliza el payload `ascensores: [...]` que envía el frontend.
 * Cada item debe describir UN ascensor: existente (id_ascensor) o nuevo (ascensor_nuevo).
 * Devuelve un arreglo limpio listo para persistir; lanza Error con el mensaje
 * apropiado si la entrada no es válida.
 */
function normalizarAscensores(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Debe registrar al menos un ascensor');
  }
  const limpios = [];
  for (let i = 0; i < input.length; i++) {
    const it = input[i] || {};
    const idAscensor = it.id_ascensor ? Number(it.id_ascensor) : null;
    const ascensorNuevo = it.ascensor_nuevo || null;
    if (!idAscensor && !ascensorNuevo) {
      throw new Error(`Ascensor #${i + 1}: seleccione uno existente o describa uno nuevo`);
    }
    if (idAscensor && ascensorNuevo) {
      throw new Error(`Ascensor #${i + 1}: no puede ser existente y nuevo a la vez`);
    }
    limpios.push({
      id_ascensor: idAscensor,
      ascensor_nuevo: idAscensor ? null : ascensorNuevo,
      orden: Number.isFinite(Number(it.orden)) ? Number(it.orden) : i + 1
    });
  }
  return limpios;
}

const INCLUDE_ASCENSORES = {
  where: { estado: 1 },
  orderBy: { orden: 'asc' },
  include: { ascensor: { include: { edificio: { select: { id: true, nombre: true, tipo: true, distrito: true, direccion: true } } } } }
};

// Transiciones permitidas: Cotizado → Aprobado | Rechazado. No hay regreso.
function transicionPermitida(actual, destino) {
  if (actual !== ESTADOS_VERSION.COTIZADO) return false;
  return destino === ESTADOS_VERSION.APROBADO || destino === ESTADOS_VERSION.RECHAZADO;
}

// Conjuntos de estados de servicio que mapean a cada estado_global de la
// cotización. Se mantienen aquí para que el cálculo sea una sola fuente de
// verdad — no se duplican en frontend.
const ESTADOS_SERVICIO_EJECUCION = [
  'Asignado', 'Checklist de salida pendiente', 'Listo para salida',
  'En camino', 'En curso'
];
const ESTADOS_SERVICIO_PENDIENTE = [
  'Finalizado por técnico', 'Finalizado observado',
  'En revisión administrativa', 'A gestión de cobro', 'En cobro',
  'Cobrado parcial', 'Facturado'
];
const ESTADOS_SERVICIO_TERMINADO = ['Cobrado total', 'Cerrado'];

/**
 * Calcula el estado_global derivado del servicio asociado a la cotización.
 *
 *  - Cotizado  → no hay servicio (ninguna versión Aprobada todavía)
 *  - Aceptado  → servicio creado, aún en Pendiente
 *  - Ejecución → servicio asignado / en camino / en curso
 *  - Pendiente → servicio finalizado pero con cobro/facturación abierta
 *  - Terminado → servicio cerrado o cobro totalmente liquidado
 */
function calcularEstadoGlobal(servicio, cobro) {
  if (!servicio) return ESTADO_GLOBAL.COTIZADO;
  const es = servicio.estado_servicio;
  if (es === 'Cancelado') return ESTADO_GLOBAL.COTIZADO;
  if (ESTADOS_SERVICIO_TERMINADO.includes(es)) return ESTADO_GLOBAL.TERMINADO;
  if (cobro && cobro.estado_cobro === 'Cerrado') return ESTADO_GLOBAL.TERMINADO;
  if (es === 'Pendiente') return ESTADO_GLOBAL.ACEPTADO;
  if (ESTADOS_SERVICIO_EJECUCION.includes(es)) return ESTADO_GLOBAL.EJECUCION;
  if (ESTADOS_SERVICIO_PENDIENTE.includes(es)) return ESTADO_GLOBAL.PENDIENTE;
  return ESTADO_GLOBAL.ACEPTADO;
}

/**
 * Sincroniza el estado_global de la cotización a partir del estado actual del
 * servicio + cobro. Idempotente: si no cambia, no escribe. Llamado desde
 * controllers de servicios/cobros/facturas cada vez que cambia algo relevante.
 *
 * Acepta un cliente Prisma o transaccional (`tx`).
 */
async function sincronizarEstadoGlobal(idCotizacion, tx = prisma) {
  if (!idCotizacion) return null;
  const cot = await tx.tbl_cotizaciones.findUnique({
    where: { id: Number(idCotizacion) },
    select: { id: true, estado_global: true, estado: true }
  });
  if (!cot || cot.estado !== 1) return null;
  // 'Anulado' es terminal: no se recalcula (la cotización fue eliminada).
  if (cot.estado_global === ESTADO_GLOBAL.ANULADO) return cot.estado_global;
  const servicio = await tx.tbl_servicios_proyectos.findFirst({
    where: { id_cotizacion: Number(idCotizacion), estado: 1 },
    select: { id: true, estado_servicio: true }
  });
  const cobro = servicio
    ? await tx.tbl_cobros.findFirst({
        where: { id_servicio: servicio.id, estado: 1 },
        select: { estado_cobro: true }
      })
    : null;
  const destino = calcularEstadoGlobal(servicio, cobro);
  if (destino === cot.estado_global) return cot.estado_global;
  await tx.tbl_cotizaciones.update({
    where: { id: cot.id },
    data: { estado_global: destino, date_time_modification: new Date() }
  });
  return destino;
}

async function cargarVersionActiva(idCotizacion) {
  const cot = await prisma.tbl_cotizaciones.findUnique({ where: { id: idCotizacion } });
  if (!cot) return null;
  const ver = await prisma.tbl_cotizaciones_versiones.findUnique({
    where: { id_cotizacion_numero_version: { id_cotizacion: idCotizacion, numero_version: cot.version_activa } }
  });
  return { cotizacion: cot, version: ver };
}

// Condición de rango de fechas del listado / exportación.
//
// Devuelve null si no se pidió rango. Sobre qué fecha se aplica depende del
// filtro de estado (ver `rangoEsPorFechaAceptacion`):
//   - filtros del embudo aceptado ('Aceptado', 'Ejecución', 'Pendiente',
//     'Terminado' y el virtual 'Aprobadas') → FECHA DE ACEPTACIÓN, es decir
//     `fecha_aprobacion` de la versión aprobada. Un rango 01/08–31/08 devuelve
//     todas las que se aceptaron en agosto, sin importar cuándo se cotizaron ni
//     en qué etapa estén hoy.
//   - resto de filtros (o sin filtro) → fecha de creación de la cotización.
function condicionRangoFechas({ estado_global, desde, hasta }) {
  if (!desde && !hasta) return null;
  const rango = {};
  if (desde) rango.gte = parseYMDLima(desde);
  if (hasta) rango.lte = parseYMDFinDiaLima(hasta);
  if (!rangoEsPorFechaAceptacion(estado_global)) return { date_time_registration: rango };
  return {
    versiones: {
      some: {
        estado: 1,
        estado_version: ESTADOS_VERSION.APROBADO,
        fecha_aprobacion: rango
      }
    }
  };
}

const listar = async (req, res) => {
  try {
    if (!puedeVer(req)) return res.status(403).json({ error: 'No autorizado' });
    const { q, estado_global, id_cliente, id_ascensor, id_tipo_servicio, desde, hasta, incluir_anuladas } = req.query;
    const mostrarAnuladas = incluir_anuladas === '1' || incluir_anuladas === 'true';

    const and = [];
    // Visibilidad: activas (estado=1) siempre; anuladas (estado=0 + 'Anulado')
    // solo si se pide explícitamente. Otros estado=0 (legacy) nunca se muestran.
    and.push(mostrarAnuladas
      ? { OR: [{ estado: 1 }, { estado: 0, estado_global: ESTADO_GLOBAL.ANULADO }] }
      : { estado: 1 });
    if (q) and.push({ OR: [
      // Código de la cotización
      { codigo: { contains: q, mode: 'insensitive' } },
      // Nombre del cliente
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      // Tipo de ascensor (Pasajeros / Camillero / Carga / …) en cualquiera de
      // los ascensores existentes vinculados a la cotización
      { ascensores: { some: { estado: 1, ascensor: { tipo: { contains: q, mode: 'insensitive' } } } } },
      // Nombre del edificio / obra donde están los ascensores de la cotización
      { ascensores: { some: { estado: 1, ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } } } },
      // Código de servicio generado por la cotización (cuando ya fue aprobada)
      { servicios: { some: { estado: 1, codigo: { contains: q, mode: 'insensitive' } } } }
    ] });
    // El filtro acepta un estado_global exacto o un filtro virtual ('Aprobadas')
    // que agrupa todas las etapas posteriores a la aceptación. Sin esto, una
    // cotización aceptada desaparecía del filtro 'Aceptado' apenas su servicio
    // pasaba a ejecución (estado_global → 'Ejecución').
    if (estado_global) {
      const estadosVirtual = resolverFiltroGlobal(estado_global);
      and.push(estadosVirtual ? { estado_global: { in: estadosVirtual } } : { estado_global });
    }
    if (id_cliente) and.push({ id_cliente: Number(id_cliente) });
    // Filtro por ascensor: cotizaciones que incluyen ese ascensor existente.
    // (Los ascensores "nuevos a instalar" no tienen id y quedan fuera del filtro.)
    if (id_ascensor) and.push({ ascensores: { some: { estado: 1, id_ascensor: Number(id_ascensor) } } });
    if (id_tipo_servicio) and.push({ id_tipo_servicio: Number(id_tipo_servicio) });
    const rangoFechas = condicionRangoFechas({ estado_global, desde, hasta });
    if (rangoFechas) and.push(rangoFechas);
    // Ámbito: un usuario de área (servicios/proyectos) solo ve las cotizaciones
    // cuyo tipo de servicio pertenece a su categoría funcional.
    const catsAmbito = categoriasFuncionalesDeAmbito(req.user);
    if (catsAmbito) and.push({ tipo_servicio: { categoria_funcional: { in: catsAmbito.length ? catsAmbito : ['__sin_ambito__'] } } });
    const where = { AND: and };

    const result = await paginar(
      prisma.tbl_cotizaciones,
      {
        where,
        orderBy: { id: 'desc' },
        include: {
          cliente: { select: { id: true, nombre: true, telefono: true } },
          ascensores: {
            where: { estado: 1 },
            orderBy: { orden: 'asc' },
            include: { ascensor: { select: { id: true, codigo: true, ubicacion: true, edificio: { select: { id: true, nombre: true, tipo: true } } } } }
          },
          tipo_servicio: { select: { id: true, nombre: true, categoria_funcional: true } },
          subtipo_servicio: { select: { id: true, nombre: true, modulo_asociado: true } },
          versiones: {
            where: { estado: 1 },
            orderBy: { numero_version: 'desc' },
            take: 1,
            select: {
              id: true, numero_version: true, estado_version: true,
              monto_total: true, moneda: true
            }
          },
          servicios: {
            where: { estado: 1 },
            orderBy: { id: 'asc' },
            select: { id: true, codigo: true, estado_servicio: true }
          }
        }
      },
      req.query
    );

    res.json(result);
  } catch (err) {
    console.error('[cotizaciones.listar]', err);
    res.status(500).json({ error: 'Error al listar cotizaciones' });
  }
};

const obtener = async (req, res) => {
  try {
    if (!puedeVer(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const cotizacion = await prisma.tbl_cotizaciones.findUnique({
      where: { id },
      include: {
        cliente: true,
        ascensores: INCLUDE_ASCENSORES,
        lead: true,
        tipo_servicio: { select: { id: true, nombre: true, categoria_funcional: true } },
        subtipo_servicio: { select: { id: true, nombre: true, modulo_asociado: true } },
        versiones: {
          where: { estado: 1 },
          orderBy: { numero_version: 'asc' },
          include: {
            items: { where: { estado: 1 }, orderBy: { orden: 'asc' }, include: { archivo: true } },
            archivo_pdf: true,
            archivo_respaldo: true
          }
        },
        servicios: {
          where: { estado: 1 },
          select: { id: true, codigo: true, estado_servicio: true, fecha_programada: true }
        },
        archivos: {
          where: { estado: 1 },
          orderBy: { orden: 'asc' },
          include: { archivo: true }
        }
      }
    });
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    // Ámbito: un usuario de área no accede (ni por URL) a cotizaciones de la otra.
    const catsAmbito = categoriasFuncionalesDeAmbito(req.user);
    if (catsAmbito && !catsAmbito.includes(cotizacion.tipo_servicio?.categoria_funcional)) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }

    res.json({ data: cotizacion });
  } catch (err) {
    console.error('[cotizaciones.obtener]', err);
    res.status(500).json({ error: 'Error al obtener cotización' });
  }
};

// Valida la selección de cuentas bancarias para el PDF: devuelve el array de
// ids ACTIVOS recibido (preservando el orden, sin duplicados). Si el payload no
// es un array, devuelve null = "sin selección explícita" (el PDF mostrará todas
// las cuentas activas, como antes de esta feature).
async function normalizarCuentasPdf(payload) {
  if (!Array.isArray(payload)) return null;
  const ids = [...new Set(payload.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return [];
  const activas = await prisma.tbl_cuentas_bancarias.findMany({
    where: { id: { in: ids }, estado: 1 }, select: { id: true }
  });
  const validos = new Set(activas.map(c => c.id));
  return ids.filter(id => validos.has(id));
}

/**
 * Normaliza y valida un lote de ids de observación técnica que se quieren jalar
 * a una cotización. Punto único de la verdad usado tanto por el prellenado
 * (`desdeObservaciones`) como por `crear`, para que lo que se ofrece al admin y
 * lo que se acepta al guardar no puedan divergir.
 *
 * Exige que todas: existan, estén activas, pertenezcan al MISMO servicio y no
 * estén ya vinculadas a otra cotización.
 *
 * @param tx  cliente Prisma (o transacción) sobre el que consultar.
 * @returns {{ error: string }} o {{ observaciones, servicio }}
 */
async function _resolverObservacionesCotizables(tx, idsCrudos) {
  const ids = [...new Set(
    (Array.isArray(idsCrudos) ? idsCrudos : String(idsCrudos || '').split(','))
      .map(Number).filter(n => Number.isInteger(n) && n > 0)
  )];
  if (ids.length === 0) return { error: 'Debe indicar al menos una observación' };

  const observaciones = await tx.tbl_servicios_observaciones.findMany({
    where: { id: { in: ids }, estado: 1 },
    include: {
      archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } },
      cotizacion: { select: { codigo: true } }
    },
    orderBy: { id: 'asc' }
  });
  if (observaciones.length !== ids.length) {
    return { error: 'Una o más observaciones no existen o fueron eliminadas' };
  }
  const yaCotizada = observaciones.find(o => o.id_cotizacion);
  if (yaCotizada) {
    return { error: `La observación ya fue cotizada en ${yaCotizada.cotizacion?.codigo || 'otra cotización'}` };
  }
  const idsServicio = [...new Set(observaciones.map(o => o.id_servicio))];
  if (idsServicio.length > 1) {
    return { error: 'Las observaciones deben pertenecer al mismo servicio' };
  }

  const servicio = await tx.tbl_servicios_proyectos.findUnique({
    where: { id: idsServicio[0] },
    include: {
      ascensores: {
        where: { estado: 1 },
        include: { ascensor: { select: { id: true, codigo: true, tipo: true } } }
      }
    }
  });
  if (!servicio || servicio.estado !== 1) return { error: 'El servicio de origen no existe o fue eliminado' };

  return { observaciones, servicio };
}

/**
 * Prellenado de una cotización a partir de observaciones técnicas.
 *
 * Devuelve lo que SÍ se puede deducir de las observaciones (cliente, un ítem por
 * observación con su texto y su foto) más los ascensores del servicio origen.
 * El subtipo de servicio y, si el servicio cubre varios ascensores, cuál se
 * cotiza, los elige el administrador en el formulario: la observación no guarda
 * esa información y adivinarla clasificaría mal la cotización.
 *
 * NO marca las observaciones: eso ocurre recién al guardar (ver `crear`), para
 * que cancelar el formulario las deje libres.
 */
const desdeObservaciones = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const resultado = await _resolverObservacionesCotizables(prisma, req.query.ids);
    if (resultado.error) return res.status(400).json({ error: resultado.error });
    const { observaciones, servicio } = resultado;

    res.json({
      data: {
        id_cliente: servicio.id_cliente,
        id_servicio: servicio.id,
        codigo_servicio: servicio.codigo,
        ascensores: servicio.ascensores.map(sa => sa.ascensor).filter(Boolean),
        items: observaciones.map((o, i) => ({
          id_observacion: o.id,
          orden: i + 1,
          descripcion: o.texto,
          id_archivo: o.id_archivo,
          archivo: o.archivo
        }))
      }
    });
  } catch (err) {
    console.error('[cotizaciones.desdeObservaciones]', err);
    res.status(500).json({ error: 'Error al preparar la cotización: ' + err.message });
  }
};

/**
 * Valida que el servicio de una emergencia YA ATENDIDA pueda recibir un cobro vía
 * cotización de "cobro sobre servicio existente" (sin crear servicio nuevo).
 * Punto único usado por el prellenado (`desdeEmergencia`), por `crear` (al fijar
 * id_servicio_cobro) y por `aprobar` (al generar el cobro).
 *
 * Exige: emergencia activa; su servicio activo, finalizado y no cancelado; sin un
 * cobro con movimiento (nada abonado ni facturado); y que el servicio no esté ya
 * ligado a otra cotización (ni tenga una cotización de cobro activa en curso).
 *
 * @returns {{ error: string }} o {{ emergencia, servicio, cobro }}
 */
async function _resolverEmergenciaCobrable(tx, idEmergenciaCrudo) {
  const idEmergencia = Number(idEmergenciaCrudo);
  if (!Number.isInteger(idEmergencia) || idEmergencia <= 0) {
    return { error: 'Emergencia inválida' };
  }
  const emergencia = await tx.tbl_emergencias.findUnique({
    where: { id: idEmergencia },
    include: {
      cliente: { select: { id: true, nombre: true } },
      ascensor: { select: { id: true, codigo: true, tipo: true, ubicacion: true } },
      archivos: {
        where: { estado: 1 },
        orderBy: { orden: 'asc' },
        include: { archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } } }
      }
    }
  });
  if (!emergencia || emergencia.estado !== 1) return { error: 'La emergencia no existe o fue eliminada' };
  if (!emergencia.id_servicio) return { error: 'La emergencia no tiene un servicio asociado' };

  const servicio = await tx.tbl_servicios_proyectos.findUnique({
    where: { id: emergencia.id_servicio },
    include: { tipo_servicio: { include: { padre: true } } }
  });
  if (!servicio || servicio.estado !== 1) return { error: 'El servicio de la emergencia no existe o fue eliminado' };
  if (servicio.estado_servicio === 'Cancelado') return { error: 'El servicio de la emergencia está cancelado' };
  if (!estaServicioFinalizado(servicio.estado_servicio)) {
    return { error: 'Solo se puede cotizar una emergencia cuyo servicio ya fue finalizado por el técnico' };
  }

  // No debe estar ya cotizada: ni el servicio ligado a una cotización, ni una
  // cotización de cobro activa (no anulada) apuntando a este servicio.
  if (servicio.id_cotizacion) {
    const cotLigada = await tx.tbl_cotizaciones.findFirst({
      where: { id: servicio.id_cotizacion }, select: { codigo: true }
    });
    return { error: `El servicio ya está ligado a la cotización ${cotLigada?.codigo || ''}`.trim() };
  }
  const cobroCotActiva = await tx.tbl_cotizaciones.findFirst({
    where: { id_servicio_cobro: servicio.id, estado: 1, estado_global: { not: ESTADO_GLOBAL.ANULADO } },
    select: { codigo: true }
  });
  if (cobroCotActiva) {
    return { error: `Ya existe una cotización de cobro (${cobroCotActiva.codigo}) para esta emergencia` };
  }

  // Un cobro con movimiento (abonos o facturas) bloquea: no se puede regenerar.
  const cobro = await tx.tbl_cobros.findFirst({
    where: { id_servicio: servicio.id, estado: 1 },
    include: { cuotas: { where: { estado: 1 }, include: { facturas: { where: { estado: 1 } } } } }
  });
  if (cobro) {
    const conMovimiento = Number(cobro.total_abonado || 0) > 0
      || (cobro.cuotas || []).some(c => Number(c.monto_pagado || 0) > 0 || (c.facturas || []).length > 0);
    if (conMovimiento) {
      return { error: 'El servicio de la emergencia ya tiene un cobro con abonos o facturas — no se puede regenerar' };
    }
  }

  return { emergencia, servicio, cobro };
}

/**
 * Prellenado de una cotización a partir de una emergencia ya atendida. Devuelve el
 * cliente, el ascensor, el subtipo del servicio de la emergencia y un ítem con el
 * motivo (y, si hay, la primera foto adjunta de la emergencia). El front lo usa
 * para abrir el modal de nueva cotización en modo "cobro de servicio existente".
 */
const desdeEmergencia = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const resultado = await _resolverEmergenciaCobrable(prisma, req.query.id);
    if (resultado.error) return res.status(400).json({ error: resultado.error });
    const { emergencia, servicio } = resultado;

    // Foto sugerida para el ítem: primer adjunto de imagen de la emergencia.
    const fotoAdjunta = emergencia.archivos
      .map(a => a.archivo)
      .find(a => a && (a.mime_type || '').startsWith('image/')) || null;

    res.json({
      data: {
        id_emergencia: emergencia.id,
        id_cliente: servicio.id_cliente,
        id_servicio_cobro: servicio.id,
        codigo_servicio: servicio.codigo,
        // El servicio referencia el SUBTIPO; su padre es la categoría funcional.
        id_subtipo_servicio: servicio.id_tipo_servicio,
        id_tipo_servicio: servicio.tipo_servicio?.id_padre || null,
        ascensor: emergencia.ascensor,
        moneda: servicio.moneda,
        item: {
          descripcion: emergencia.motivo,
          id_archivo: fotoAdjunta?.id || null,
          archivo: fotoAdjunta
        }
      }
    });
  } catch (err) {
    console.error('[cotizaciones.desdeEmergencia]', err);
    res.status(500).json({ error: 'Error al preparar la cotización: ' + err.message });
  }
};

const crear = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const d = req.body || {};

    if (!d.id_cliente) return res.status(400).json({ error: 'Cliente obligatorio' });
    if (!d.id_subtipo_servicio) return res.status(400).json({ error: 'Subtipo de servicio obligatorio' });

    // Resolver y validar la coherencia padre ↔ subtipo. El subtipo determina la
    // clasificación; el padre se deriva de él (o se valida si vino en el body).
    const subtipoCot = await prisma.tbl_tipos_servicio.findUnique({
      where: { id: Number(d.id_subtipo_servicio) }, include: { padre: true }
    });
    if (!subtipoCot || subtipoCot.estado !== 1 || subtipoCot.id_padre == null) {
      return res.status(400).json({ error: 'Subtipo de servicio inválido' });
    }
    if (d.id_tipo_servicio && Number(d.id_tipo_servicio) !== subtipoCot.id_padre) {
      return res.status(400).json({ error: 'El subtipo no pertenece al tipo de servicio padre seleccionado' });
    }
    // Ámbito: un usuario de área (servicios/proyectos) solo crea cotizaciones de su área.
    const catsAmbitoCrear = categoriasFuncionalesDeAmbito(req.user);
    if (catsAmbitoCrear && !catsAmbitoCrear.includes(subtipoCot.padre?.categoria_funcional)) {
      return res.status(403).json({ error: 'No puede crear cotizaciones fuera de su área asignada.' });
    }
    const idPadreCot = subtipoCot.id_padre;

    let ascensoresLimpios;
    try {
      ascensoresLimpios = normalizarAscensores(d.ascensores);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Los servicios operativos (correctivo, emergencia, mantenimiento, atención
    // rápida) se cotizan para UN solo ascensor: cada uno es de un ascensor por
    // naturaleza (el correctivo/emergencia enlaza un ascensor; el mantenimiento es
    // un plan por ascensor). Solo los Proyectos (sin módulo) admiten multiascensor.
    if (subtipoCot.modulo_asociado && ascensoresLimpios.length > 1) {
      return res.status(400).json({ error: 'Un servicio (correctivo, emergencia o mantenimiento) se cotiza para un solo ascensor. Cree una cotización por cada ascensor.' });
    }

    const items = Array.isArray(d.items) ? d.items : [];
    if (items.length === 0) return res.status(400).json({ error: 'Debe agregar al menos un item' });

    // La foto por ítem NO se exige al cotizar (tampoco en correctivos): es
    // requisito al APROBAR, cuando la cotización se convierte en servicio
    // (ver `aprobarVersion`). Así se puede cotizar sin tener aún las fotos.

    if (d.id_lead) {
      const lead = await prisma.tbl_leads.findUnique({ where: { id: Number(d.id_lead) } });
      if (!lead) return res.status(400).json({ error: 'Lead no encontrado' });
      if (lead.estado_lead === ESTADO_LEAD_DESCARTADO) {
        return res.status(400).json({ error: 'El lead está descartado; reactívalo antes de cotizarlo' });
      }
    }

    const igvTasa = await configuracion.obtener('IGV_RATE');
    const sinIgv = Boolean(d.sin_igv);
    const totales = calcularTotalesVersion(items, igvTasa, sinIgv);
    const cuentasPdf = await normalizarCuentasPdf(d.cuentas_pdf);

    const tieneCuotas = Boolean(d.tiene_cuotas);
    let planCuotas = null;
    if (tieneCuotas) {
      try {
        planCuotas = normalizarPlanCuotas(d.plan_cuotas, totales.monto_total);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
    // Solo aplica cuando existe plan de cuotas (un adelanto + saldo posterior).
    const saldoVariable = tieneCuotas && Boolean(d.saldo_variable);

    const archivosIds = Array.isArray(d.archivos)
      ? d.archivos.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : [];
    if (archivosIds.length > 0) {
      const existentes = await prisma.tbl_archivos.findMany({
        where: { id: { in: archivosIds }, estado: 1 },
        select: { id: true }
      });
      if (existentes.length !== archivosIds.length) {
        return res.status(400).json({ error: 'Uno o más archivos adjuntos no existen' });
      }
    }

    // Observaciones técnicas de origen (opcional). Se validan aquí para fallar
    // con 400 antes de crear nada, y se REVALIDAN dentro de la transacción por
    // si otro admin las cotizó entre el prellenado y este guardado.
    const idsObservaciones = Array.isArray(d.ids_observaciones) ? d.ids_observaciones : [];
    if (idsObservaciones.length > 0) {
      const previa = await _resolverObservacionesCotizables(prisma, idsObservaciones);
      if (previa.error) return res.status(400).json({ error: previa.error });
    }

    // Cotización de "cobro sobre servicio existente" (emergencia ya atendida): se
    // valida contra la emergencia de origen y se fija id_servicio_cobro. Al aprobar
    // NO se creará servicio nuevo, solo el cobro sobre ese servicio.
    let idServicioCobro = null;
    if (d.id_emergencia) {
      const prevEm = await _resolverEmergenciaCobrable(prisma, d.id_emergencia);
      if (prevEm.error) return res.status(400).json({ error: prevEm.error });
      if (prevEm.servicio.id_cliente !== Number(d.id_cliente)) {
        return res.status(400).json({ error: 'El cliente de la cotización no coincide con el de la emergencia' });
      }
      idServicioCobro = prevEm.servicio.id;
    }

    const codigo = await generarCodigoCotizacion();

    const creada = await prisma.$transaction(async (tx) => {
      const cot = await tx.tbl_cotizaciones.create({
        data: {
          codigo,
          id_cliente: Number(d.id_cliente),
          id_lead: d.id_lead ? Number(d.id_lead) : null,
          id_tipo_servicio: idPadreCot,
          id_subtipo_servicio: subtipoCot.id,
          descripcion: d.descripcion || null,
          id_servicio_cobro: idServicioCobro,
          estado_global: ESTADO_GLOBAL.COTIZADO,
          version_activa: 1,
          user_id_registration: req.user.id,
          ascensores: {
            create: ascensoresLimpios.map(a => ({
              id_ascensor: a.id_ascensor,
              ascensor_nuevo: a.ascensor_nuevo,
              orden: a.orden,
              user_id_registration: req.user.id
            }))
          }
        }
      });

      const ver = await tx.tbl_cotizaciones_versiones.create({
        data: {
          id_cotizacion: cot.id,
          numero_version: 1,
          moneda: d.moneda || 'PEN',
          subtotal: totales.subtotal,
          igv: totales.igv,
          igv_tasa: totales.igv_tasa,
          monto_total: totales.monto_total,
          estado_version: ESTADOS_VERSION.COTIZADO,
          motivo_cambio: null,
          observaciones: d.observaciones || null,
          terminos: d.terminos || (await configuracion.obtener('COTIZACION_TERMINOS')),
          garantia: trimOrNull(d.garantia),
          tiene_cuotas: tieneCuotas,
          plan_cuotas: planCuotas,
          saldo_variable: saldoVariable,
          sin_igv: sinIgv,
          cuentas_pdf: cuentasPdf,
          user_id_registration: req.user.id
        }
      });

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        await tx.tbl_cotizaciones_items.create({
          data: {
            id_version: ver.id,
            orden: Number.isFinite(Number(it.orden)) ? Number(it.orden) : i + 1,
            descripcion: it.descripcion || '',
            cantidad: it.cantidad || 1,
            unidad: it.unidad || 'Unidad',
            precio_unitario: it.precio_unitario || 0,
            descuento_porcentaje: it.descuento_porcentaje || 0,
            importe: require('../utils/cotizacionCalculos').calcularImporteLinea(it),
            id_archivo: it.id_archivo ? Number(it.id_archivo) : null,
            user_id_registration: req.user.id
          }
        });
      }

      for (let i = 0; i < archivosIds.length; i++) {
        await tx.tbl_cotizaciones_archivos.create({
          data: {
            id_cotizacion: cot.id,
            id_archivo: archivosIds[i],
            orden: i + 1,
            user_id_registration: req.user.id
          }
        });
      }

      // Vincular las observaciones de origen a la cotización recién creada. El
      // updateMany exige id_cotizacion todavía null: si otro admin las cotizó
      // entre el prellenado y este guardado, el conteo no cuadra y se aborta la
      // transacción entera en vez de pisar el vínculo existente.
      if (idsObservaciones.length > 0) {
        const vinculadas = await tx.tbl_servicios_observaciones.updateMany({
          where: { id: { in: idsObservaciones.map(Number) }, estado: 1, id_cotizacion: null },
          data: { id_cotizacion: cot.id, user_id_modification: req.user.id, date_time_modification: new Date() }
        });
        if (vinculadas.count !== idsObservaciones.length) {
          throw new Error('Alguna observación fue cotizada por otro usuario mientras se creaba esta cotización');
        }
      }

      // Si la cotización nace de un lead, marcarlo como 'Cotizado' (salvo que ya
      // esté 'Ingresado', para no degradar un lead ya convertido en servicio).
      if (cot.id_lead) {
        await tx.tbl_leads.updateMany({
          where: { id: cot.id_lead, estado_lead: { not: ESTADO_LEAD_INGRESADO } },
          data: { estado_lead: ESTADO_LEAD_COTIZADO, user_id_modification: req.user.id, date_time_modification: new Date() }
        });
      }

      return cot;
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cotizaciones', id_entidad: creada.id,
      accion: 'CREATE', valor_nuevo: creada, ip: req.ip
    });

    res.status(201).json({ data: creada });
  } catch (err) {
    console.error('[cotizaciones.crear]', err);
    res.status(500).json({ error: 'Error al crear cotización: ' + err.message });
  }
};

const actualizarCabecera = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const d = req.body || {};

    const prev = await cargarVersionActiva(id);
    if (!prev || !prev.cotizacion) return res.status(404).json({ error: 'Cotización no encontrada' });
    if (prev.cotizacion.estado_global !== ESTADO_GLOBAL.COTIZADO) {
      return res.status(400).json({ error: 'Solo se puede editar una cotización en Cotizado' });
    }
    if (!prev.version || prev.version.estado_version !== ESTADOS_VERSION.COTIZADO) {
      return res.status(400).json({ error: 'La cabecera solo se edita con versión activa en Cotizado' });
    }

    let ascensoresLimpios = null;
    if (Array.isArray(d.ascensores)) {
      try {
        ascensoresLimpios = normalizarAscensores(d.ascensores);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // Si se cambia el subtipo, revalidar coherencia padre ↔ subtipo y derivar el padre.
    let idPadreUpd = prev.cotizacion.id_tipo_servicio;
    let idSubtipoUpd = prev.cotizacion.id_subtipo_servicio;
    if (d.id_subtipo_servicio) {
      const subtipoUpd = await prisma.tbl_tipos_servicio.findUnique({
        where: { id: Number(d.id_subtipo_servicio) }, include: { padre: true }
      });
      if (!subtipoUpd || subtipoUpd.estado !== 1 || subtipoUpd.id_padre == null) {
        return res.status(400).json({ error: 'Subtipo de servicio inválido' });
      }
      if (d.id_tipo_servicio && Number(d.id_tipo_servicio) !== subtipoUpd.id_padre) {
        return res.status(400).json({ error: 'El subtipo no pertenece al tipo de servicio padre seleccionado' });
      }
      idPadreUpd = subtipoUpd.id_padre;
      idSubtipoUpd = subtipoUpd.id;
    }

    const cot = await prisma.$transaction(async (tx) => {
      const actualizado = await tx.tbl_cotizaciones.update({
        where: { id },
        data: {
          id_cliente: d.id_cliente ? Number(d.id_cliente) : prev.cotizacion.id_cliente,
          id_tipo_servicio: idPadreUpd,
          id_subtipo_servicio: idSubtipoUpd,
          descripcion: d.descripcion ?? prev.cotizacion.descripcion,
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });
      if (ascensoresLimpios) {
        await tx.tbl_cotizaciones_ascensores.deleteMany({ where: { id_cotizacion: id } });
        for (const a of ascensoresLimpios) {
          await tx.tbl_cotizaciones_ascensores.create({
            data: {
              id_cotizacion: id,
              id_ascensor: a.id_ascensor,
              ascensor_nuevo: a.ascensor_nuevo,
              orden: a.orden,
              user_id_registration: req.user.id
            }
          });
        }
      }
      return actualizado;
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cotizaciones', id_entidad: id,
      accion: 'UPDATE', valor_anterior: prev.cotizacion, valor_nuevo: cot, ip: req.ip
    });
    res.json({ data: cot });
  } catch (err) {
    console.error('[cotizaciones.actualizarCabecera]', err);
    res.status(500).json({ error: 'Error al actualizar cotización' });
  }
};

const actualizarVersion = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const numero = Number(req.params.v);
    const d = req.body || {};

    const version = await prisma.tbl_cotizaciones_versiones.findUnique({
      where: { id_cotizacion_numero_version: { id_cotizacion: id, numero_version: numero } }
    });
    if (!version) return res.status(404).json({ error: 'Versión no encontrada' });
    if (version.estado_version !== ESTADOS_VERSION.COTIZADO) {
      return res.status(400).json({ error: 'Solo se editan versiones en Cotizado' });
    }

    const items = Array.isArray(d.items) ? d.items : null;
    const igvTasa = await configuracion.obtener('IGV_RATE');
    const { calcularImporteLinea } = require('../utils/cotizacionCalculos');

    // Editar los ítems no exige foto: se pide al aprobar (ver `aprobarVersion`).

    const nuevoSinIgv = Object.prototype.hasOwnProperty.call(d, 'sin_igv')
      ? Boolean(d.sin_igv) : version.sin_igv;
    // Los totales se recalculan si cambian los items o si cambia la condición de
    // IGV (afecto/sin IGV). Si solo cambia el IGV, se recomputan sobre los items
    // vigentes en la BD.
    const recalcTotales = !!items || (nuevoSinIgv !== version.sin_igv);
    let totalesNuevos = null;
    if (recalcTotales) {
      const itemsParaCalc = items || (await prisma.tbl_cotizaciones_items.findMany({
        where: { id_version: version.id, estado: 1 }
      }));
      totalesNuevos = calcularTotalesVersion(itemsParaCalc, igvTasa, nuevoSinIgv);
    }
    // Total efectivo después de la actualización (recalculado o el vigente).
    const totalNuevo = totalesNuevos ? totalesNuevos.monto_total : Number(version.monto_total);

    let nuevasCuentasPdf;
    const enviaCuentas = Object.prototype.hasOwnProperty.call(d, 'cuentas_pdf');
    if (enviaCuentas) nuevasCuentasPdf = await normalizarCuentasPdf(d.cuentas_pdf);

    // Manejo del plan de cuotas: opcional. Solo se toca si el cliente envía el campo.
    let nuevoTieneCuotas = version.tiene_cuotas;
    let nuevoPlanCuotas = version.plan_cuotas;
    let nuevoSaldoVariable = version.saldo_variable;
    const enviaCuotas = Object.prototype.hasOwnProperty.call(d, 'tiene_cuotas')
      || Object.prototype.hasOwnProperty.call(d, 'plan_cuotas');
    if (enviaCuotas) {
      nuevoTieneCuotas = Boolean(d.tiene_cuotas);
      if (nuevoTieneCuotas) {
        try {
          nuevoPlanCuotas = normalizarPlanCuotas(d.plan_cuotas, totalNuevo);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
      } else {
        nuevoPlanCuotas = null;
      }
    } else if (items && version.tiene_cuotas) {
      // Si cambiaron los items pero no se reenvió el plan, hay que revalidar contra el nuevo total.
      try {
        nuevoPlanCuotas = normalizarPlanCuotas(version.plan_cuotas, totalNuevo);
      } catch (e) {
        return res.status(400).json({ error: `El plan de cuotas existente quedó desfasado: ${e.message}` });
      }
    }
    if (Object.prototype.hasOwnProperty.call(d, 'saldo_variable')) {
      nuevoSaldoVariable = Boolean(d.saldo_variable);
    }
    // Sin plan de cuotas no aplica el concepto.
    if (!nuevoTieneCuotas) nuevoSaldoVariable = false;

    const actualizada = await prisma.$transaction(async (tx) => {
      const dataUpdate = {
        moneda: d.moneda ?? version.moneda,
        observaciones: d.observaciones ?? version.observaciones,
        terminos: d.terminos ?? version.terminos,
        // Solo se toca si el cliente la envía; vaciarla ('') la borra.
        ...(Object.prototype.hasOwnProperty.call(d, 'garantia') ? { garantia: trimOrNull(d.garantia) } : {}),
        tiene_cuotas: nuevoTieneCuotas,
        plan_cuotas: nuevoPlanCuotas,
        saldo_variable: nuevoSaldoVariable,
        sin_igv: nuevoSinIgv,
        ...(enviaCuentas ? { cuentas_pdf: nuevasCuentasPdf } : {}),
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      };

      if (items) {
        await tx.tbl_cotizaciones_items.deleteMany({ where: { id_version: version.id } });
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await tx.tbl_cotizaciones_items.create({
            data: {
              id_version: version.id,
              orden: Number.isFinite(Number(it.orden)) ? Number(it.orden) : i + 1,
              descripcion: it.descripcion || '',
              cantidad: it.cantidad || 1,
              unidad: it.unidad || 'Unidad',
              precio_unitario: it.precio_unitario || 0,
              descuento_porcentaje: it.descuento_porcentaje || 0,
              importe: calcularImporteLinea(it),
              id_archivo: it.id_archivo ? Number(it.id_archivo) : null,
              user_id_registration: req.user.id
            }
          });
        }
      }
      // Los totales se aplican si se recalcularon (por items o por cambio de IGV).
      if (totalesNuevos) {
        dataUpdate.subtotal = totalesNuevos.subtotal;
        dataUpdate.igv = totalesNuevos.igv;
        dataUpdate.igv_tasa = totalesNuevos.igv_tasa;
        dataUpdate.monto_total = totalesNuevos.monto_total;
      }

      return tx.tbl_cotizaciones_versiones.update({
        where: { id: version.id },
        data: dataUpdate
      });
    });

    res.json({ data: actualizada });
  } catch (err) {
    console.error('[cotizaciones.actualizarVersion]', err);
    res.status(500).json({ error: 'Error al actualizar versión' });
  }
};

const crearNuevaVersion = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const motivo = (req.body?.motivo_cambio || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Motivo del cambio obligatorio' });

    const cot = await prisma.tbl_cotizaciones.findUnique({
      where: { id },
      include: {
        versiones: {
          where: { estado: 1 },
          orderBy: { numero_version: 'desc' },
          take: 1,
          include: { items: { where: { estado: 1 }, orderBy: { orden: 'asc' } } }
        }
      }
    });
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
    // Se permite versionar cuando: la cotización está en proceso (Cotizado) o
    // fue reabierta (estado global != Terminado). Si quedó Terminada o si la
    // última versión sigue en Cotizado sin decidir, no tiene sentido versionar.
    if (cot.estado_global === ESTADO_GLOBAL.ANULADO) {
      return res.status(400).json({ error: 'La cotización está anulada y no admite acciones.' });
    }
    if (cot.estado_global === ESTADO_GLOBAL.TERMINADO) {
      return res.status(400).json({ error: 'No se versiona una cotización Terminada' });
    }
    const ultima = cot.versiones[0];
    if (!ultima) return res.status(400).json({ error: 'No hay versión anterior para clonar' });
    // Solo se versiona desde una decisión tomada (Rechazado o Aprobado tras
    // reapertura). Versionar sobre una versión todavía en Cotizado es
    // redundante: el usuario debe editar la versión existente.
    const estadosOrigenPermitidos = [
      ESTADOS_VERSION.RECHAZADO,
      ESTADOS_VERSION.APROBADO
    ];
    if (!estadosOrigenPermitidos.includes(ultima.estado_version)) {
      return res.status(400).json({ error: 'Solo se versiona desde una versión Rechazado o Aprobado (tras reapertura)' });
    }

    const nueva = await prisma.$transaction(async (tx) => {
      const ver = await tx.tbl_cotizaciones_versiones.create({
        data: {
          id_cotizacion: id,
          numero_version: ultima.numero_version + 1,
          moneda: ultima.moneda,
          subtotal: ultima.subtotal,
          igv: ultima.igv,
          igv_tasa: ultima.igv_tasa,
          monto_total: ultima.monto_total,
          estado_version: ESTADOS_VERSION.COTIZADO,
          motivo_cambio: motivo,
          observaciones: ultima.observaciones,
          terminos: ultima.terminos,
          garantia: ultima.garantia,
          tiene_cuotas: ultima.tiene_cuotas,
          plan_cuotas: ultima.plan_cuotas,
          saldo_variable: ultima.saldo_variable,
          user_id_registration: req.user.id
        }
      });
      for (const it of ultima.items) {
        await tx.tbl_cotizaciones_items.create({
          data: {
            id_version: ver.id,
            orden: it.orden,
            descripcion: it.descripcion,
            cantidad: it.cantidad,
            unidad: it.unidad,
            precio_unitario: it.precio_unitario,
            descuento_porcentaje: it.descuento_porcentaje,
            importe: it.importe,
            id_archivo: it.id_archivo,
            user_id_registration: req.user.id
          }
        });
      }
      await tx.tbl_cotizaciones.update({
        where: { id },
        data: { version_activa: ver.numero_version, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      return ver;
    });

    res.status(201).json({ data: nueva });
  } catch (err) {
    console.error('[cotizaciones.crearNuevaVersion]', err);
    res.status(500).json({ error: 'Error al crear nueva versión' });
  }
};

const rechazar = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const numero = Number(req.params.v);
    const motivo = (req.body?.motivo_rechazo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Motivo de rechazo obligatorio' });

    const version = await prisma.tbl_cotizaciones_versiones.findUnique({
      where: { id_cotizacion_numero_version: { id_cotizacion: id, numero_version: numero } }
    });
    if (!version) return res.status(404).json({ error: 'Versión no encontrada' });
    if (!transicionPermitida(version.estado_version, ESTADOS_VERSION.RECHAZADO)) {
      return res.status(400).json({ error: `No se puede rechazar desde ${version.estado_version}` });
    }
    const actualizada = await prisma.tbl_cotizaciones_versiones.update({
      where: { id: version.id },
      data: {
        estado_version: ESTADOS_VERSION.RECHAZADO,
        motivo_rechazo: motivo,
        fecha_rechazo: new Date(),
        rechazada_por: req.user.id,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cotizaciones_versiones', id_entidad: version.id,
      accion: 'REJECT', valor_nuevo: { estado_version: ESTADOS_VERSION.RECHAZADO, motivo }, ip: req.ip
    });
    res.json({ data: actualizada });
  } catch (err) {
    console.error('[cotizaciones.rechazar]', err);
    res.status(500).json({ error: 'Error al rechazar cotización' });
  }
};

/**
 * Reabre una cotización aprobada para renegociar términos.
 * Validaciones:
 *   - estado_global en Aceptado/Ejecución/Pendiente (hay servicio en marcha)
 *   - existe servicio asociado, no en estado terminal (Cerrado/Cancelado)
 *   - existe cobro asociado, no en estado terminal (Cerrado/Incobrable)
 *   - cobro tiene saldo_pendiente > 0 (al menos una cuota sin cobrar completa)
 *
 * Tras reabrir, el caller puede crear una nueva versión (Cotizado) desde la
 * versión Aprobado y volver a aprobar. La re-aprobación NO crea servicio/cobro
 * nuevos: actualiza los existentes preservando cuotas pagadas/facturadas.
 */
const reabrir = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const motivo = (req.body?.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Motivo de reapertura obligatorio' });

    const cot = await prisma.tbl_cotizaciones.findUnique({ where: { id } });
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
    // Solo tiene sentido reabrir cuando ya hay servicio en marcha y no está
    // totalmente terminada. Si quedó en Cotizado/Aceptado simplemente sigue
    // su flujo natural — no hay nada que reabrir.
    if (cot.estado_global === ESTADO_GLOBAL.TERMINADO || cot.estado_global === ESTADO_GLOBAL.COTIZADO || cot.estado_global === ESTADO_GLOBAL.ANULADO) {
      return res.status(400).json({ error: `No se puede reabrir una cotización ${cot.estado_global}` });
    }

    const servicio = await prisma.tbl_servicios_proyectos.findFirst({
      where: { id_cotizacion: id, estado: 1 }
    });
    if (!servicio) {
      return res.status(400).json({ error: 'La cotización no tiene un servicio activo asociado — no se puede reabrir' });
    }
    if (['Cerrado', 'Cancelado'].includes(servicio.estado_servicio)) {
      return res.status(400).json({ error: `El servicio asociado está ${servicio.estado_servicio} — no se puede reabrir` });
    }

    const cobro = await prisma.tbl_cobros.findFirst({
      where: { id_servicio: servicio.id, estado: 1 },
      include: { cuotas: { where: { estado: 1 } } }
    });
    if (!cobro) {
      return res.status(400).json({ error: 'No se encontró un cobro activo asociado al servicio' });
    }
    if (['Cerrado', 'Incobrable'].includes(cobro.estado_cobro)) {
      return res.status(400).json({ error: `El cobro asociado está ${cobro.estado_cobro} — no se puede reabrir` });
    }
    const hayPendientes = cobro.cuotas.some(c => Number(c.monto_pagado || 0) < Number(c.monto));
    if (!hayPendientes || Number(cobro.saldo_pendiente) <= 0) {
      return res.status(400).json({ error: 'Todas las cuotas están totalmente pagadas — no hay nada que renegociar' });
    }

    // Reapertura: no tocamos estado_global manualmente. La nueva versión nacerá
    // en Cotizado y, al aprobarla, sincronizarEstadoGlobal recalculará el global
    // según el estado del servicio existente.
    const estadoSincronizado = await sincronizarEstadoGlobal(id);
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cotizaciones', id_entidad: id,
      accion: 'REOPEN',
      valor_anterior: { estado_global: cot.estado_global },
      valor_nuevo: { estado_global: estadoSincronizado, motivo },
      ip: req.ip
    });

    res.json({
      data: {
        id_cotizacion: id,
        estado_global: estadoSincronizado,
        cuotas_pendientes: cobro.cuotas.filter(c => Number(c.monto_pagado || 0) < Number(c.monto)).length,
        saldo_pendiente: Number(cobro.saldo_pendiente)
      }
    });
  } catch (err) {
    console.error('[cotizaciones.reabrir]', err);
    res.status(500).json({ error: 'Error al reabrir cotización: ' + err.message });
  }
};

/**
 * Lógica transaccional de re-aprobación: actualiza el servicio existente y
 * sincroniza el cobro respetando cuotas blindadas (pagadas/facturadas).
 * Las cuotas no blindadas se reemplazan según `version.plan_cuotas`.
 *
 * Lanza Error si:
 *   - El nuevo monto es menor que la suma de cuotas blindadas.
 *   - La suma del nuevo plan_cuotas ≠ (nuevo_monto - sumaBlindadas) ± 1 céntimo.
 */
async function _reAprobarTx({ tx, cot, version, servicioExistente, fechaProgramada, userId, idArchivoRespaldo, cuentasPdf }) {
  return await tx.$transaction(async (trx) => {
    // 1. Actualizar precio del servicio existente
    await trx.tbl_servicios_proyectos.update({
      where: { id: servicioExistente.id },
      data: {
        precio_interno: version.monto_total,
        moneda: version.moneda,
        user_id_modification: userId,
        date_time_modification: new Date()
      }
    });

    // 2. Cargar cobro con cuotas y facturas para identificar blindadas
    const cobro = await trx.tbl_cobros.findFirst({
      where: { id_servicio: servicioExistente.id, estado: 1 },
      include: {
        cuotas: {
          where: { estado: 1 },
          include: { facturas: { where: { estado: 1 } } }
        }
      }
    });
    if (!cobro) throw new Error('No se encontró el cobro asociado para sincronizar');

    const blindadas = cobro.cuotas.filter(c =>
      Number(c.monto_pagado || 0) > 0 ||
      (Array.isArray(c.facturas) && c.facturas.length > 0)
    );
    const sumaBlindadas = blindadas.reduce((s, c) => s + Number(c.monto), 0);
    const nuevoMontoTotal = Number(version.monto_total);

    if (nuevoMontoTotal < sumaBlindadas - 0.01) {
      throw new Error(
        `El nuevo monto (S/ ${nuevoMontoTotal.toFixed(2)}) no puede ser menor a lo ya comprometido en cuotas pagadas/facturadas (S/ ${sumaBlindadas.toFixed(2)})`
      );
    }

    const restante = Number((nuevoMontoTotal - sumaBlindadas).toFixed(2));

    // 3. Construir nuevas cuotas a partir de version.plan_cuotas o una sola por defecto
    let cuotasNuevas = [];
    if (Array.isArray(version.plan_cuotas) && version.plan_cuotas.length > 0) {
      const sumaPlan = version.plan_cuotas.reduce((s, c) => s + Number(c.monto || 0), 0);
      if (Math.abs(sumaPlan - nuevoMontoTotal) > 0.01) {
        throw new Error(
          `La suma del plan de cuotas (S/ ${sumaPlan.toFixed(2)}) no coincide con el monto total de la nueva versión (S/ ${nuevoMontoTotal.toFixed(2)})`
        );
      }
      // De plan_cuotas tomamos solo las que NO mapean a una cuota blindada por orden.
      // El plan en la versión es declarativo; aquí lo materializamos respetando blindadas.
      // Estrategia: tomar las últimas `cuotasNuevasCount` cuotas del plan como nuevas,
      // donde cuotasNuevasCount = plan.length - blindadas.length, y validar que la
      // suma de esas coincida con `restante`.
      const cuotasNuevasCount = Math.max(0, version.plan_cuotas.length - blindadas.length);
      const planParaNuevas = version.plan_cuotas.slice(version.plan_cuotas.length - cuotasNuevasCount);
      const sumaParaNuevas = planParaNuevas.reduce((s, c) => s + Number(c.monto || 0), 0);
      if (Math.abs(sumaParaNuevas - restante) > 0.01) {
        throw new Error(
          `La suma de las cuotas nuevas (S/ ${sumaParaNuevas.toFixed(2)}) debe ser ${restante.toFixed(2)} (total ${nuevoMontoTotal.toFixed(2)} − comprometido ${sumaBlindadas.toFixed(2)})`
        );
      }
      cuotasNuevas = planParaNuevas.map(c => ({
        fecha_vencimiento: typeof c.fecha_vencimiento === 'string'
          ? parseYMDLima(c.fecha_vencimiento)
          : c.fecha_vencimiento,
        monto: Number(c.monto)
      }));
    } else if (restante > 0.01) {
      // Sin plan declarado, una cuota única con el restante con vencimiento a la
      // fecha de re-aprobación (hoy); contabilidad puede reprogramarla luego.
      cuotasNuevas = [{ fecha_vencimiento: fechaProgramada, monto: restante }];
    }

    // 4. Reemplazar cuotas NO blindadas
    const idsBlindadas = blindadas.map(c => c.id);
    await trx.tbl_cobros_cuotas.deleteMany({
      where: { id_cobro: cobro.id, id: { notIn: idsBlindadas.length ? idsBlindadas : [-1] } }
    });

    // 5. Renumerar todas las cuotas (blindadas + nuevas) por fecha de vencimiento
    const todas = [
      ...blindadas.map(b => ({
        id: b.id,
        fecha_vencimiento: b.fecha_vencimiento,
        monto: Number(b.monto)
      })),
      ...cuotasNuevas.map(c => ({ id: null, ...c }))
    ];
    todas.sort((a, b) => new Date(a.fecha_vencimiento) - new Date(b.fecha_vencimiento));
    todas.forEach((c, i) => { c.numero_cuota = i + 1; });

    for (const c of todas) {
      if (c.id) {
        await trx.tbl_cobros_cuotas.update({
          where: { id: c.id },
          data: { numero_cuota: c.numero_cuota, user_id_modification: userId, date_time_modification: new Date() }
        });
      } else {
        await trx.tbl_cobros_cuotas.create({
          data: {
            id_cobro: cobro.id,
            numero_cuota: c.numero_cuota,
            fecha_vencimiento: c.fecha_vencimiento,
            monto: c.monto,
            user_id_registration: userId
          }
        });
      }
    }

    // 6. Actualizar agregados del cobro
    const totalAbonado = Number(cobro.total_abonado);
    const nuevoSaldo = Math.max(0, Number((nuevoMontoTotal - totalAbonado).toFixed(2)));
    const proximaPendiente = todas.find(c => {
      if (!c.id) return true;
      const orig = cobro.cuotas.find(x => x.id === c.id);
      return !orig || Number(orig.monto_pagado || 0) < Number(orig.monto);
    });

    const cobroActualizado = await trx.tbl_cobros.update({
      where: { id: cobro.id },
      data: {
        monto_total: nuevoMontoTotal,
        moneda: version.moneda,
        saldo_pendiente: nuevoSaldo,
        numero_cuotas: todas.length,
        cuotas_faltantes: Math.max(0, todas.length - cobro.cuotas_pagadas),
        saldo_variable: Boolean(version.saldo_variable),
        fecha_proximo_abono: proximaPendiente?.fecha_vencimiento || null,
        user_id_modification: userId,
        date_time_modification: new Date()
      }
    });

    // 6.b Sincronizar folder contable. Si el servicio ya tenía folder (caso
    // normal post-aprobación) se actualiza estado_cobro y date_time_modification.
    // Si no existía (caso legacy pre-implementación de option A) se crea.
    // Esto garantiza que la pantalla Contabilidad refleje los cambios de
    // monto y cuotas inmediatamente tras la re-aprobación.
    await trx.tbl_servicios_realizados.upsert({
      where: { id_servicio: servicioExistente.id },
      update: {
        estado_cobro: cobroActualizado.estado_cobro,
        user_id_modification: userId,
        date_time_modification: new Date()
      },
      create: {
        id_servicio: servicioExistente.id,
        id_cliente: cot.id_cliente,
        estado_administrativo: 'En ejecución',
        estado_cobro: cobroActualizado.estado_cobro || 'Pendiente de iniciar',
        estado_facturacion: ESTADO_FACTURACION_SIN,
        user_id_registration: userId
      }
    });

    // 7. Marcar versión aprobada y recalcular estado_global desde el servicio
    const versionApro = await trx.tbl_cotizaciones_versiones.update({
      where: { id: version.id },
      data: {
        estado_version: ESTADOS_VERSION.APROBADO,
        fecha_aprobacion: new Date(),
        aprobada_por: userId,
        id_archivo_respaldo: idArchivoRespaldo,
        ...(cuentasPdf !== undefined ? { cuentas_pdf: cuentasPdf } : {}),
        user_id_modification: userId,
        date_time_modification: new Date()
      }
    });
    await sincronizarEstadoGlobal(cot.id, trx);

    // 8. Historial
    await trx.tbl_clientes_historial.create({
      data: {
        id_cliente: cot.id_cliente,
        id_servicio: servicioExistente.id,
        tipo_evento: 'cotizacion_re_aprobada',
        descripcion: `Cotización ${cot.codigo} v${version.numero_version} re-aprobada (renegociación) — nuevo monto ${version.moneda} ${nuevoMontoTotal.toFixed(2)} · ${blindadas.length} cuota(s) blindada(s) preservada(s)`,
        creado_por: userId
      }
    });

    return {
      version: versionApro,
      blindadas: blindadas.length,
      creadas: cuotasNuevas.length,
      nuevo_monto: nuevoMontoTotal
    };
  });
}

/**
 * Aprobación de cotización: transición atómica.
 *   1. Marca versión Aprobado
 *   2. Si no hay ascensor pero hay ascensor_nuevo, crea tbl_ascensores
 *   3. Crea tbl_servicios_proyectos con id_cotizacion y monto = monto_total
 *   4. Crea tbl_cobros (+ cuotas si hay plan_cuotas) heredando saldo_variable
 *   5. Sincroniza estado_global (servicio en Pendiente → Aceptado)
 *   6. Registra historial en cliente
 *
 * Si ya existe un servicio para esta cotización (caso re-aprobación tras
 * reapertura), delega en `_reAprobarTx` — no crea servicio/cobro nuevos.
 */
// Título del servicio creado al aprobar una cotización. La cotización ya no
// tiene campo `titulo`: se deriva del SUBTIPO de servicio + el nombre del edificio
// u obra (tomado de los ascensores de la cotización). El servicio exige título
// (NOT NULL); como último recurso usa el código.
function tituloServicioDesdeCotizacion(cot, edificioNombre, codigoServicio) {
  const nombreTipo = cot.subtipo_servicio?.nombre || cot.tipo_servicio?.nombre;
  return [nombreTipo, edificioNombre || ''].filter(Boolean).join(' – ') || codigoServicio;
}

const aprobar = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const numero = Number(req.params.v);
    const d = req.body || {};

    const cot = await prisma.tbl_cotizaciones.findUnique({
      where: { id },
      include: {
        cliente: true,
        tipo_servicio: true,
        subtipo_servicio: { include: { padre: true } },
        ascensores: INCLUDE_ASCENSORES
      }
    });
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
    if (cot.estado_global === ESTADO_GLOBAL.ANULADO) {
      return res.status(400).json({ error: 'La cotización está anulada y no admite acciones.' });
    }
    if (cot.estado_global === ESTADO_GLOBAL.TERMINADO) {
      return res.status(400).json({ error: 'La cotización ya está Terminada' });
    }
    // Clasificación (SSoT): el subtipo + su padre determinan si la conversión
    // produce un Proyecto o un Servicio y, en este último caso, el módulo destino.
    const clasificacionCot = clasificarTipoServicio(cot.subtipo_servicio);

    const version = await prisma.tbl_cotizaciones_versiones.findUnique({
      where: { id_cotizacion_numero_version: { id_cotizacion: id, numero_version: numero } }
    });
    if (!version) return res.status(404).json({ error: 'Versión no encontrada' });
    if (!transicionPermitida(version.estado_version, ESTADOS_VERSION.APROBADO)) {
      return res.status(400).json({ error: `No se puede aprobar desde ${version.estado_version}` });
    }

    // Selección de cuentas bancarias al aprobar: OPCIONAL. Si el modal de
    // aprobación envía `cuentas_pdf`, se persiste en la versión (permite ajustar
    // las cuentas a utilizar en ese momento, precargadas desde lo ya guardado).
    // Si no se envía el campo, se conserva la selección guardada de la versión.
    const enviaCuentasApro = Object.prototype.hasOwnProperty.call(d, 'cuentas_pdf');
    const cuentasPdfAprob = enviaCuentasApro ? await normalizarCuentasPdf(d.cuentas_pdf) : undefined;

    // Foto obligatoria por ítem AL APROBAR. En la creación de la cotización la
    // foto es opcional (salvo correctivo), pero al pasar a servicio/proyecto cada
    // ítem debe llevar su foto: el técnico asignado la visualiza en el servicio
    // generado. Aplica a la conversión y a la re-aprobación (ambas usan `version`).
    // Excepción: cobro sobre servicio existente (id_servicio_cobro). Nace de una
    // emergencia ya atendida — el servicio se realizó y no se crea uno nuevo, así
    // que la foto por ítem deja de ser requisito.
    const itemsVersion = await prisma.tbl_cotizaciones_items.findMany({
      where: { id_version: version.id, estado: 1 },
      select: { id: true, id_archivo: true }
    });
    if (itemsVersion.length === 0) {
      return res.status(400).json({ error: 'La versión no tiene ítems para aprobar' });
    }
    if (!cot.id_servicio_cobro) {
      const itemsSinFoto = itemsVersion.filter(it => !it.id_archivo).length;
      if (itemsSinFoto > 0) {
        return res.status(400).json({ error: `Cada ítem debe incluir una foto antes de aprobar (faltan ${itemsSinFoto}). Súbelas desde el modal de aprobación.` });
      }
    }

    // ─── Cobro sobre servicio existente (emergencia ya atendida) ────────────
    // La cotización marca id_servicio_cobro: al aprobar NO se crea servicio nuevo
    // ni se replica en módulo. Se liga la cotización al servicio existente, se lo
    // vuelve facturable con el precio cotizado y se genera el cobro siguiendo el
    // flujo (plan de cuotas de la versión si lo hay).
    if (cot.id_servicio_cobro) {
      try {
        const resultadoCobro = await prisma.$transaction(async (tx) => {
          const servicio = await tx.tbl_servicios_proyectos.findUnique({ where: { id: cot.id_servicio_cobro } });
          if (!servicio || servicio.estado !== 1) throw new Error('El servicio asociado no existe o fue eliminado');
          if (servicio.estado_servicio === 'Cancelado') throw new Error('El servicio asociado está cancelado');
          if (!estaServicioFinalizado(servicio.estado_servicio)) throw new Error('El servicio asociado aún no está finalizado');
          if (servicio.id_cotizacion && servicio.id_cotizacion !== cot.id) {
            throw new Error('El servicio ya está ligado a otra cotización');
          }

          // Cobro existente sin movimiento → se reemplaza; con movimiento → bloquea.
          const cobroExistente = await tx.tbl_cobros.findFirst({
            where: { id_servicio: servicio.id, estado: 1 },
            include: { cuotas: { where: { estado: 1 }, include: { facturas: { where: { estado: 1 } } } } }
          });
          if (cobroExistente) {
            const conMovimiento = Number(cobroExistente.total_abonado || 0) > 0
              || (cobroExistente.cuotas || []).some(c => Number(c.monto_pagado || 0) > 0 || (c.facturas || []).length > 0);
            if (conMovimiento) throw new Error('El servicio ya tiene un cobro con abonos o facturas — no se puede regenerar');
            await tx.tbl_cobros_cuotas.deleteMany({ where: { id_cobro: cobroExistente.id } });
            await tx.tbl_cobros.delete({ where: { id: cobroExistente.id } });
          }

          // Ligar servicio ↔ cotización y volverlo facturable con el precio cotizado.
          await tx.tbl_servicios_proyectos.update({
            where: { id: servicio.id },
            data: {
              id_cotizacion: cot.id,
              precio_interno: version.monto_total,
              moneda: version.moneda,
              sin_cobro: 0,
              requiere_factura: 1,
              user_id_modification: req.user.id,
              date_time_modification: new Date()
            }
          });
          await tx.tbl_servicios_ascensores.updateMany({
            where: { id_servicio: servicio.id, estado: 1 },
            data: { monto: version.monto_total, moneda: version.moneda, user_id_modification: req.user.id, date_time_modification: new Date() }
          });

          // Cobro siguiendo el flujo (una cuota o el plan de la versión).
          await crearCobroInicial(tx, {
            idServicio: servicio.id,
            idCliente: cot.id_cliente,
            monto: version.monto_total,
            moneda: version.moneda,
            fechaCuotaUnica: new Date(),
            planCuotas: Array.isArray(version.plan_cuotas) ? version.plan_cuotas : null,
            saldoVariable: Boolean(version.saldo_variable),
            idUsuario: req.user.id
          });

          // Folder contable: el servicio finalizado suele tenerlo. Se alinea al
          // nuevo cobro (pendiente de iniciar, facturable sin comprobante aún);
          // si no existe, se crea.
          const realizadoPrev = await tx.tbl_servicios_realizados.findFirst({ where: { id_servicio: servicio.id } });
          if (realizadoPrev) {
            await tx.tbl_servicios_realizados.update({
              where: { id: realizadoPrev.id },
              data: {
                estado_cobro: 'Pendiente de iniciar',
                estado_facturacion: ESTADO_FACTURACION_SIN,
                user_id_modification: req.user.id,
                date_time_modification: new Date()
              }
            });
          } else {
            await tx.tbl_servicios_realizados.create({
              data: {
                id_servicio: servicio.id,
                id_cliente: cot.id_cliente,
                estado_administrativo: 'En ejecución',
                estado_cobro: 'Pendiente de iniciar',
                estado_facturacion: ESTADO_FACTURACION_SIN,
                user_id_registration: req.user.id
              }
            });
          }

          const versionApro = await tx.tbl_cotizaciones_versiones.update({
            where: { id: version.id },
            data: {
              estado_version: ESTADOS_VERSION.APROBADO,
              fecha_aprobacion: new Date(),
              aprobada_por: req.user.id,
              id_archivo_respaldo: d.id_archivo_respaldo ? Number(d.id_archivo_respaldo) : null,
              user_id_modification: req.user.id,
              date_time_modification: new Date()
            }
          });

          await sincronizarEstadoGlobal(cot.id, tx);

          await tx.tbl_clientes_historial.create({
            data: {
              id_cliente: cot.id_cliente,
              id_servicio: servicio.id,
              tipo_evento: 'cotizacion_aprobada',
              descripcion: `Cotización ${cot.codigo} v${version.numero_version} aprobada — cobro sobre servicio existente ${servicio.codigo}`,
              creado_por: req.user.id
            }
          });

          return { servicio, version: versionApro };
        }, { maxWait: 15000, timeout: 30000 });

        await registrarAuditoria({
          id_usuario: req.user.id, entidad: 'tbl_cotizaciones', id_entidad: id,
          accion: 'APPROVE',
          valor_nuevo: { id_servicio_cobro: resultadoCobro.servicio.id, monto: Number(version.monto_total), sin_servicio_nuevo: true },
          ip: req.ip
        });
        sincronizarRecordatorioServicio(resultadoCobro.servicio.id).catch(err =>
          console.error('Sync recordatorio servicio (cobro emergencia):', err));

        return res.json({
          data: {
            id_cotizacion: id,
            version: resultadoCobro.version,
            id_servicio_cobro: resultadoCobro.servicio.id,
            codigo_servicio: resultadoCobro.servicio.codigo,
            es_cobro_servicio_existente: true
          }
        });
      } catch (errCobro) {
        return res.status(400).json({ error: errCobro.message });
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    if (!Array.isArray(cot.ascensores) || cot.ascensores.length === 0) {
      return res.status(400).json({ error: 'Cotización sin ascensores asociados' });
    }

    // La fecha de programación ya NO se registra al aprobar: el servicio nace
    // sin fecha/hora y el área correspondiente la define después (detalle del
    // servicio → "Programar fecha"). `fechaAprobacion` (hoy) se usa solo como
    // vencimiento de la cuota inicial del cobro y como fecha de inicio por
    // defecto del plan de mantenimiento.
    const fechaAprobacion = new Date();

    // ─── Detección de re-aprobación ─────────────────────────────────────────
    // Si ya existe un servicio activo vinculado a esta cotización, estamos
    // re-aprobando tras una reapertura. No se crea servicio ni cobro nuevos:
    // se actualiza el servicio existente y se sincroniza el cobro respetando
    // cuotas blindadas (pagadas o facturadas).
    const servicioExistente = await prisma.tbl_servicios_proyectos.findFirst({
      where: { id_cotizacion: id, estado: 1 }
    });

    if (servicioExistente) {
      try {
        const resultadoReAp = await _reAprobarTx({
          tx: prisma,
          cot,
          version,
          servicioExistente,
          fechaProgramada: fechaAprobacion,
          userId: req.user.id,
          idArchivoRespaldo: d.id_archivo_respaldo ? Number(d.id_archivo_respaldo) : null,
          cuentasPdf: cuentasPdfAprob
        });
        await registrarAuditoria({
          id_usuario: req.user.id, entidad: 'tbl_cotizaciones', id_entidad: id,
          accion: 'RE_APPROVE',
          valor_nuevo: {
            version: version.numero_version,
            nuevo_monto: Number(version.monto_total),
            id_servicio: servicioExistente.id
          },
          ip: req.ip
        });
        return res.json({
          data: {
            id_cotizacion: id,
            version: resultadoReAp.version,
            id_servicio_actualizado: servicioExistente.id,
            codigo_servicio: servicioExistente.codigo,
            es_re_aprobacion: true,
            cuotas_blindadas: resultadoReAp.blindadas,
            cuotas_creadas: resultadoReAp.creadas
          }
        });
      } catch (errReAp) {
        return res.status(400).json({ error: errReAp.message });
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Un ascensor nuevo debe indicar a qué edificio del cliente pertenece (el
    // ascensor ya no cuelga directo del cliente). El picker de la cotización lo
    // adjunta en `ascensor_nuevo.id_edificio`.
    for (const fila of cot.ascensores) {
      if (!fila.id_ascensor && !(fila.ascensor_nuevo && fila.ascensor_nuevo.id_edificio)) {
        return res.status(400).json({ error: 'Cada ascensor nuevo debe indicar su edificio' });
      }
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Resolver cada fila de la cotización a un id_ascensor. Las que tengan
      //    ascensor_nuevo crean primero el registro en tbl_ascensores con estado
      //    "Por instalar" y luego se enlazan al servicio.
      let totalAscensoresCliente = await tx.tbl_ascensores.count({ where: { edificio: { is: { id_cliente: cot.id_cliente } } } });
      const idsResueltos = [];
      for (const fila of cot.ascensores) {
        if (fila.id_ascensor) {
          idsResueltos.push(fila.id_ascensor);
          continue;
        }
        const datos = fila.ascensor_nuevo || {};
        totalAscensoresCliente += 1;
        const codigoAsc = `ASC-${cot.id_cliente}-${String(totalAscensoresCliente).padStart(3, '0')}-${Date.now().toString().slice(-4)}`;
        const nuevoAsc = await tx.tbl_ascensores.create({
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
            user_id_registration: req.user.id
          }
        });
        await tx.tbl_cotizaciones_ascensores.update({
          where: { id: fila.id },
          data: { id_ascensor: nuevoAsc.id, ascensor_nuevo: null, user_id_modification: req.user.id, date_time_modification: new Date() }
        });
        idsResueltos.push(nuevoAsc.id);
      }

      // 2. Crear servicio + filas puente para cada ascensor de la cotización.
      //    El monto del servicio se reparte equitativamente entre ascensores
      //    (cents, sin perder redondeo) — los reportes podrán recomponer el total.
      const totalCents = Math.round(Number(version.monto_total) * 100);
      const baseCents = Math.floor(totalCents / idsResueltos.length);
      const codigoSrv = await generarCodigoServicio(clasificacionCot.tipo_registro);
      // El edificio del servicio = el de los ascensores cotizados (mismo edificio).
      const edificioServicio = await tx.tbl_edificios.findFirst({
        where: { ascensores: { some: { id: { in: idsResueltos } } } },
        select: { nombre: true }
      });
      // Contacto en sitio y cuarto de máquinas heredados de la ficha del ascensor.
      const datosSitio = await datosSitioParaServicio(tx, idsResueltos, d);
      const servicio = await tx.tbl_servicios_proyectos.create({
        data: {
          codigo: codigoSrv,
          // tipo_registro derivado del subtipo (SSoT): Proyecto si el padre es
          // PROYECTOS, Servicio si es SERVICIOS. El servicio referencia el SUBTIPO.
          tipo_registro: clasificacionCot.tipo_registro,
          id_tipo_servicio: cot.id_subtipo_servicio,
          id_cliente: cot.id_cliente,
          id_cotizacion: cot.id,
          origen: 'cotizacion',
          titulo: tituloServicioDesdeCotizacion(cot, edificioServicio?.nombre, codigoSrv),
          descripcion: cot.descripcion,
          // Nace SIN fecha/hora de programación: las registra luego el área desde
          // el detalle del servicio. `prioridad` usa el default del esquema.
          fecha_programada: null,
          hora_programada: null,
          estado_servicio: 'Pendiente',
          precio_interno: version.monto_total,
          moneda: version.moneda,
          observaciones: d.observaciones || null,
          ...datosSitio,
          user_id_registration: req.user.id,
          ascensores: {
            create: idsResueltos.map((idAsc, idx) => {
              const cents = idx === idsResueltos.length - 1
                ? totalCents - baseCents * (idsResueltos.length - 1)
                : baseCents;
              return {
                id_ascensor: idAsc,
                monto: Number((cents / 100).toFixed(2)),
                moneda: version.moneda,
                user_id_registration: req.user.id
              };
            })
          }
        }
      });

      // 2.b NO se crea evento de calendario aquí: el servicio nace sin fecha de
      // programación. El evento se crea cuando el área registra la fecha desde el
      // detalle del servicio (serviciosController.actualizar), evitando que
      // aparezcan servicios "sin fecha" en /calendario.

      // 3. Cobro + plan de cuotas (si la versión lo declara). El cobro nace
      // aquí (no al finalizar el servicio) para que aparezca en gestión de
      // cobros desde la aprobación, en paralelo al ciclo de ejecución.
      await crearCobroInicial(tx, {
        idServicio: servicio.id,
        idCliente: cot.id_cliente,
        monto: version.monto_total,
        moneda: version.moneda,
        fechaCuotaUnica: fechaAprobacion,
        planCuotas: Array.isArray(version.plan_cuotas) ? version.plan_cuotas : null,
        saldoVariable: Boolean(version.saldo_variable),
        idUsuario: req.user.id
      });

      // 3.b Folder contable: visible en el módulo Contabilidad desde la
      // aprobación (no se espera a que el técnico finalice). El upsert de
      // finalizarServicio actualizará después fecha_realizacion + datos
      // técnicos sin pisar este registro.
      await tx.tbl_servicios_realizados.create({
        data: {
          id_servicio: servicio.id,
          id_cliente: cot.id_cliente,
          // técnicos quedan null hasta que se asignen y finalicen
          estado_administrativo: 'En ejecución',
          estado_cobro: 'Pendiente de iniciar',
          estado_facturacion: ESTADO_FACTURACION_SIN,
          user_id_registration: req.user.id
        }
      });

      // 3.c Replicación en módulos especializados según `modulo_asociado` del
      // tipo de servicio. Las filas se delegan a `replicarEnModulo` para que la
      // creación directa de servicios (serviciosController.crear) y la aprobación
      // de cotización compartan exactamente la misma lógica.
      //
      // Reglas:
      //   - emergencia/correctivo: 1 fila vinculada al servicio (constraint
      //     @unique). Si la cotización tiene multiascensor, la fila usa el
      //     PRIMER ascensor; los demás siguen vinculados via tbl_servicios_proyectos_ascensores.
      //   - mantenimiento: 1 plan por cada ascensor (planes son independientes).
      //   - atencion_rapida: no aplica al aprobar cotización (es captura inicial).
      await replicarEnModulo(tx, {
        servicio,
        tipoServicio: cot.subtipo_servicio,
        idsAscensores: idsResueltos,
        idCliente: cot.id_cliente,
        // Sin hora de programación al aprobar; el inicio de plan de mantenimiento
        // cae por defecto a la fecha de aprobación (hoy) salvo que el form indique
        // una "Fecha de inicio del plan".
        horaProgramada: null,
        fechaProgramada: fechaAprobacion,
        usuarioId: req.user.id,
        datosModulo: d,
        origenEtiqueta: `aprobación de ${cot.codigo} v${version.numero_version}`
      });

      // 4. marcar versión aprobada
      const versionApro = await tx.tbl_cotizaciones_versiones.update({
        where: { id: version.id },
        data: {
          estado_version: ESTADOS_VERSION.APROBADO,
          fecha_aprobacion: new Date(),
          aprobada_por: req.user.id,
          id_archivo_respaldo: d.id_archivo_respaldo ? Number(d.id_archivo_respaldo) : null,
          ...(enviaCuentasApro ? { cuentas_pdf: cuentasPdfAprob } : {}),
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });

      // 5. sincronizar estado_global: el servicio acaba de nacer en Pendiente,
      // por lo que estado_global pasa automáticamente a Aceptado.
      await sincronizarEstadoGlobal(cot.id, tx);

      // 6. historiales
      await tx.tbl_clientes_historial.create({
        data: {
          id_cliente: cot.id_cliente,
          id_servicio: servicio.id,
          tipo_evento: 'cotizacion_aprobada',
          descripcion: `Cotización ${cot.codigo} v${version.numero_version} aprobada → ${servicio.codigo}`,
          creado_por: req.user.id
        }
      });
      for (const idAsc of idsResueltos) {
        await tx.tbl_ascensores_historial.create({
          data: {
            id_ascensor: idAsc,
            id_servicio: servicio.id,
            tipo_evento: 'servicio_creado',
            descripcion: `Servicio ${servicio.codigo} creado por aprobación de ${cot.codigo}`,
            creado_por: req.user.id
          }
        });
      }
      await tx.tbl_servicios_estados_historial.create({
        data: { id_servicio: servicio.id, estado_anterior: null, estado_nuevo: 'Pendiente', cambiado_por: req.user.id }
      });

      // 7. Si la cotización viene de un lead, marcarlo como 'Ingresado'
      //    (ingresó como servicio) y enlazar el servicio generado. Se limpia
      //    motivo_descarte: si el lead fue descartado tras cotizarse, la
      //    aprobación lo reactiva y el motivo deja de aplicar.
      if (cot.id_lead) {
        await tx.tbl_leads.update({
          where: { id: cot.id_lead },
          data: {
            estado_lead: ESTADO_LEAD_INGRESADO,
            motivo_descarte: null,
            id_servicio_convertido: servicio.id,
            user_id_modification: req.user.id,
            date_time_modification: new Date()
          }
        });
      }

      return { servicio, version: versionApro };
    }, { maxWait: 15000, timeout: 30000 });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cotizaciones', id_entidad: id,
      accion: 'APPROVE', valor_nuevo: { id_servicio: resultado.servicio.id, monto: version.monto_total }, ip: req.ip
    });

    sincronizarRecordatorioServicio(resultado.servicio.id).catch(err =>
      console.error('Sync recordatorio servicio (cotizacion):', err));

    res.json({
      data: {
        id_cotizacion: id,
        version: resultado.version,
        id_servicio_generado: resultado.servicio.id,
        codigo_servicio: resultado.servicio.codigo
      }
    });
  } catch (err) {
    console.error('[cotizaciones.aprobar]', err);
    res.status(500).json({ error: 'Error al aprobar cotización: ' + err.message });
  }
};

const eliminar = async (req, res) => {
  try {
    if (req.user.rol_codigo !== 'super_admin') return res.status(403).json({ error: 'Solo Super Admin' });
    const id = Number(req.params.id);
    const cot = await prisma.tbl_cotizaciones.findUnique({
      where: { id },
      include: {
        versiones: { where: { estado: 1 } },
        ascensores: { where: { estado: 1 } },
        archivos: { where: { estado: 1 } }
      }
    });
    if (!cot) return res.status(404).json({ error: 'No encontrada' });
    if (cot.estado_global === ESTADO_GLOBAL.ANULADO) {
      return res.status(400).json({ error: 'La cotización ya está anulada.' });
    }

    // Eliminación = baja lógica (estado=0) + estado_global 'Anulado'. El estado=0
    // mantiene la coherencia con los demás módulos (deleted = estado 0); el
    // 'Anulado' permite listarla aparte como historial (el listado la oculta por
    // defecto, con un check para mostrarla). Sus servicios generados (p. ej.
    // aprobada por error) se anulan en baja lógica en cascada. No se purgan los
    // archivos de la cotización (se preservan para el historial).
    const serviciosGenerados = await prisma.tbl_servicios_proyectos.findMany({
      where: { id_cotizacion: id, estado: 1 }
    });

    const wasabiKeys = [];
    const tecnicoIds = [];
    await prisma.$transaction(async (tx) => {
      const stamp = { user_id_modification: req.user.id, date_time_modification: new Date() };

      // Anular los servicios generados por la cotización (baja lógica en cascada).
      for (const s of serviciosGenerados) {
        const r = await bajaServicioCascadaEnTx(tx, s.id, req.user.id);
        wasabiKeys.push(...r.wasabiKeys);
        tecnicoIds.push(...r.tecnicoIds);
        await tx.tbl_servicios_proyectos.update({
          where: { id: s.id },
          data: { estado_servicio: 'Cancelado', ...stamp }
        });
      }

      // Baja lógica (estado=0) + marca 'Anulado' para el historial.
      await tx.tbl_cotizaciones.update({
        where: { id },
        data: { estado: 0, estado_global: ESTADO_GLOBAL.ANULADO, ...stamp }
      });
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_cotizaciones', id_entidad: id,
        accion: 'DELETE', valor_anterior: cot,
        valor_nuevo: { estado_global: ESTADO_GLOBAL.ANULADO, servicios_anulados: serviciosGenerados.map(s => s.codigo) }, ip: req.ip
      });
    });

    // Solo se purgan archivos de los servicios anulados; los de la cotización se conservan.
    await purgarObjetosWasabi(wasabiKeys);
    await liberarTecnicos(tecnicoIds, null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[cotizaciones.eliminar]', err);
    res.status(500).json({ error: 'Error al eliminar cotización' });
  }
};

/**
 * Genera (o regenera) el PDF de una versión y lo guarda en Wasabi.
 * Devuelve { url, id_archivo, ruta }.
 */
const generarPdf = async (req, res) => {
  try {
    if (!puedeVer(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const numero = Number(req.params.v);

    const cot = await prisma.tbl_cotizaciones.findUnique({
      where: { id },
      include: { cliente: true, tipo_servicio: true, subtipo_servicio: true, ascensores: INCLUDE_ASCENSORES }
    });
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });

    const version = await prisma.tbl_cotizaciones_versiones.findUnique({
      where: { id_cotizacion_numero_version: { id_cotizacion: id, numero_version: numero } },
      include: { items: { where: { estado: 1 }, orderBy: { orden: 'asc' } } }
    });
    if (!version) return res.status(404).json({ error: 'Versión no encontrada' });

    const { generarPdfCotizacion } = require('../utils/cotizacionPdf');
    const { subirObjeto, rutaDesdeKey, urlPresigned, keyDesdeRuta } = require('../utils/storage');
    const { construirKey } = require('../middleware/uploadMiddleware');

    const buffer = await generarPdfCotizacion({
      cotizacion: cot,
      version,
      items: version.items
    });

    const nombre = `${cot.codigo}-v${version.numero_version}.pdf`;
    const key = construirKey('cotizaciones', nombre);
    await subirObjeto({ key, body: buffer, contentType: 'application/pdf' });

    const archivo = await prisma.tbl_archivos.create({
      data: {
        nombre_original: nombre,
        ruta_almacenamiento: rutaDesdeKey(key),
        mime_type: 'application/pdf',
        tamano_bytes: buffer.length,
        subido_por: req.user.id,
        user_id_registration: req.user.id
      }
    });

    // Setea fecha_envio la primera vez que se emite PDF — semánticamente
    // equivale a "se entrega la cotización al cliente". Si ya estaba marcada,
    // se conserva (re-generar PDF no reinicia la fecha de emisión original).
    await prisma.tbl_cotizaciones_versiones.update({
      where: { id: version.id },
      data: {
        id_archivo_pdf: archivo.id,
        fecha_envio: version.fecha_envio || hoyDate(),
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });

    const url = await urlPresigned(keyDesdeRuta(archivo.ruta_almacenamiento));
    res.json({ data: { id_archivo: archivo.id, ruta: archivo.ruta_almacenamiento, url } });
  } catch (err) {
    console.error('[cotizaciones.generarPdf]', err);
    res.status(500).json({ error: 'Error al generar PDF: ' + err.message });
  }
};

const agregarArchivo = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const idCotizacion = Number(req.params.id);
    const idArchivo = Number(req.body?.id_archivo);
    if (!Number.isInteger(idArchivo) || idArchivo <= 0) {
      return res.status(400).json({ error: 'id_archivo inválido' });
    }
    const cot = await prisma.tbl_cotizaciones.findUnique({ where: { id: idCotizacion } });
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
    const arch = await prisma.tbl_archivos.findFirst({ where: { id: idArchivo, estado: 1 } });
    if (!arch) return res.status(404).json({ error: 'Archivo no encontrado' });

    const ultimo = await prisma.tbl_cotizaciones_archivos.findFirst({
      where: { id_cotizacion: idCotizacion, estado: 1 },
      orderBy: { orden: 'desc' },
      select: { orden: true }
    });
    const creado = await prisma.tbl_cotizaciones_archivos.create({
      data: {
        id_cotizacion: idCotizacion,
        id_archivo: idArchivo,
        orden: (ultimo?.orden || 0) + 1,
        user_id_registration: req.user.id
      },
      include: { archivo: true }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cotizaciones_archivos', id_entidad: creado.id,
      accion: 'CREATE', valor_nuevo: creado, ip: req.ip
    });
    res.status(201).json({ data: creado });
  } catch (err) {
    console.error('[cotizaciones.agregarArchivo]', err);
    res.status(500).json({ error: 'Error al agregar archivo' });
  }
};

const eliminarArchivo = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const idCotizacion = Number(req.params.id);
    const idAdjunto = Number(req.params.idAdjunto);
    const adjunto = await prisma.tbl_cotizaciones_archivos.findFirst({
      where: { id: idAdjunto, id_cotizacion: idCotizacion, estado: 1 }
    });
    if (!adjunto) return res.status(404).json({ error: 'Adjunto no encontrado' });

    const wasabiKeys = [];
    await prisma.$transaction(async (tx) => {
      await tx.tbl_cotizaciones_archivos.update({
        where: { id: idAdjunto },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      const key = await bajaArchivoEnTx(tx, adjunto.id_archivo, req.user.id);
      if (key) wasabiKeys.push(key);
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_cotizaciones_archivos', id_entidad: idAdjunto,
        accion: 'DELETE', valor_anterior: adjunto, ip: req.ip
      });
    });
    await purgarObjetosWasabi(wasabiKeys);
    res.json({ ok: true });
  } catch (err) {
    console.error('[cotizaciones.eliminarArchivo]', err);
    res.status(500).json({ error: 'Error al eliminar archivo' });
  }
};


// ===================================================================
// [MERGE] Infraestructura de listado + endpoints exportar/historial
// traídos del repo remoto (exportación XLSX/PDF e historial de
// cotizaciones). Aditivo: no altera los endpoints locales existentes.
// ===================================================================
const INCLUDE_LISTA = {
  cliente: { select: { id: true, nombre: true, telefono: true } },
  ascensores: {
    where: { estado: 1 },
    orderBy: { orden: 'asc' },
    include: { ascensor: { select: { id: true, codigo: true, ubicacion: true, edificio: { select: { id: true, nombre: true, tipo: true } } } } }
  },
  tipo_servicio: { select: { id: true, nombre: true, categoria_funcional: true } },
  subtipo_servicio: { select: { id: true, nombre: true, modulo_asociado: true } },
  versiones: {
    where: { estado: 1 },
    orderBy: { numero_version: 'desc' },
    take: 1,
    select: {
      id: true, numero_version: true, estado_version: true,
      monto_total: true, moneda: true
    }
  },
  servicios: {
    where: { estado: 1 },
    orderBy: { id: 'asc' },
    select: { id: true, codigo: true, estado_servicio: true }
  }
};

function construirWhereCotizaciones(query) {
  const { q, estado_global, id_cliente, id_ascensor, id_tipo_servicio, desde, hasta } = query;
  const where = { estado: 1 };
  if (q) where.OR = [
    // Código de la cotización
    { codigo: { contains: q, mode: 'insensitive' } },
    // Nombre del cliente
    { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
    // Tipo de ascensor (Pasajeros / Camillero / Carga / …) en cualquiera de
    // los ascensores existentes vinculados a la cotización
    { ascensores: { some: { estado: 1, ascensor: { tipo: { contains: q, mode: 'insensitive' } } } } },
    // Nombre del edificio / obra donde están los ascensores de la cotización
    { ascensores: { some: { estado: 1, ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } } } },
    // Código de servicio generado por la cotización (cuando ya fue aprobada)
    { servicios: { some: { estado: 1, codigo: { contains: q, mode: 'insensitive' } } } }
  ];
  // Igual que el listado: el valor puede ser un estado exacto o el filtro
  // virtual 'Aprobadas' (todas las etapas posteriores a la aceptación). La
  // traducción vive en utils/estadoCotizacion.js para no duplicarla aquí.
  if (estado_global) {
    const estadosVirtual = resolverFiltroGlobal(estado_global);
    where.estado_global = estadosVirtual ? { in: estadosVirtual } : estado_global;
  }
  if (id_cliente) where.id_cliente = Number(id_cliente);
  // Mismo filtro por ascensor que el listado (para exportar lo que se ve).
  if (id_ascensor) where.ascensores = { some: { estado: 1, id_ascensor: Number(id_ascensor) } };
  if (id_tipo_servicio) where.id_tipo_servicio = Number(id_tipo_servicio);
  // Mismo criterio de rango que el listado (creación vs. aceptación según el
  // filtro de estado), para exportar exactamente lo que se ve en pantalla.
  const rangoFechas = condicionRangoFechas({ estado_global, desde, hasta });
  if (rangoFechas) Object.assign(where, rangoFechas);
  return where;
}

// Hidrata cada cotización con `creado_por` (usuario que la registró). La columna
// user_id_registration no tiene relación FK en Prisma, así que se resuelve con
// una consulta por lote. Muta y devuelve el mismo arreglo recibido.
async function adjuntarCreador(cotizaciones) {
  const mapa = await mapaUsuariosPorId(cotizaciones.map(c => c.user_id_registration));
  for (const c of cotizaciones) {
    c.creado_por = c.user_id_registration ? (mapa[c.user_id_registration] || null) : null;
  }
  return cotizaciones;
}


const exportar = async (req, res) => {
  try {
    if (!puedeVer(req)) return res.status(403).json({ error: 'No autorizado' });
    const formato = String(req.query.formato || 'excel').toLowerCase();
    if (!['excel', 'pdf'].includes(formato)) {
      return res.status(400).json({ error: 'Formato debe ser "excel" o "pdf"' });
    }

    const where = construirWhereCotizaciones(req.query);
    conAlcance(where, cotizacionAlcanceWhere(req.user));
    const cotizaciones = await prisma.tbl_cotizaciones.findMany({
      where,
      orderBy: { id: 'desc' },
      include: INCLUDE_LISTA
    });
    await adjuntarCreador(cotizaciones);

    const { generarExcelCotizaciones, generarPdfCotizaciones } = require('../utils/cotizacionesExport');
    const stamp = ymdLima();

    if (formato === 'excel') {
      const buffer = await generarExcelCotizaciones(cotizaciones);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="cotizaciones-${stamp}.xlsx"`);
      return res.end(buffer);
    }

    const buffer = await generarPdfCotizaciones(cotizaciones);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cotizaciones-${stamp}.pdf"`);
    return res.end(buffer);
  } catch (err) {
    console.error('[cotizaciones.exportar]', err);
    res.status(500).json({ error: 'Error al exportar cotizaciones: ' + err.message });
  }
};


const historial = async (req, res) => {
  try {
    if (!puedeVer(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const cot = await prisma.tbl_cotizaciones.findUnique({
      where: { id },
      select: { id: true, versiones: { select: { id: true, numero_version: true } } }
    });
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });

    // numero_version por id de versión, para etiquetar los eventos de versión.
    const numeroVersionPorId = Object.fromEntries(cot.versiones.map(v => [v.id, v.numero_version]));
    const versionIds = cot.versiones.map(v => v.id);

    const filtros = [{ entidad: 'tbl_cotizaciones', id_entidad: id }];
    if (versionIds.length > 0) {
      filtros.push({ entidad: 'tbl_cotizaciones_versiones', id_entidad: { in: versionIds } });
    }
    const eventos = await prisma.tbl_auditoria.findMany({
      where: { OR: filtros },
      orderBy: { fecha_evento: 'asc' }
    });

    const mapa = await mapaUsuariosPorId(eventos.map(e => e.id_usuario));
    const data = eventos.map(e => ({
      id: e.id,
      accion: e.accion,
      fecha_evento: e.fecha_evento,
      ip: e.ip,
      usuario: e.id_usuario ? (mapa[e.id_usuario] || null) : null,
      // Número de versión afectada: directo si el evento es sobre una versión,
      // o derivado del payload auditado (APPROVE/RE_APPROVE guardan `version`).
      numero_version: e.entidad === 'tbl_cotizaciones_versiones'
        ? (numeroVersionPorId[e.id_entidad] ?? null)
        : (e.valor_nuevo?.version ?? e.valor_nuevo?.numero_version ?? null),
      // Motivo asociado (rechazo / cambio / reapertura) cuando exista.
      motivo: e.valor_nuevo?.motivo ?? e.valor_nuevo?.motivo_cambio ?? null
    }));

    res.json({ data });
  } catch (err) {
    console.error('[cotizaciones.historial]', err);
    res.status(500).json({ error: 'Error al obtener historial de la cotización' });
  }
};
// Catálogos de estado que consume el listado (filtro) y la ficha. Se sirven
// desde el backend para que la UI no vuelva a duplicarlos en un array literal
// y no pueda desalinearse de lo que realmente se escribe en la BD.
const catalogos = (_req, res) => {
  res.json({ data: { estados_globales: ESTADOS_GLOBALES, filtros_globales: FILTROS_GLOBALES, estados_version: ESTADOS_VERSION_LISTA } });
};

module.exports = {
  listar,
  catalogos,
  obtener,
  exportar,
  historial,
  desdeObservaciones,
  desdeEmergencia,
  crear,
  actualizarCabecera,
  actualizarVersion,
  crearNuevaVersion,
  rechazar,
  aprobar,
  reabrir,
  eliminar,
  generarPdf,
  agregarArchivo,
  eliminarArchivo,
  sincronizarEstadoGlobal,
  ESTADOS_VERSION,
  ESTADO_GLOBAL
};

const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima, parseYMDFinDiaLima, inicioDelDiaLima, combinarFechaHoraLima } = require('../utils/tiempo');
const { generarCodigoCotizacion } = require('../utils/codigoCotizacion');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { calcularTotalesVersion, normalizarPlanCuotas } = require('../utils/cotizacionCalculos');
const { crearCobroInicial } = require('../utils/crearCobroInicial');
const { sincronizarRecordatorioServicio } = require('../utils/recordatoriosAuto');
const { colorPorTipo } = require('../utils/visibilidadCalendario');
const { replicarEnModulo } = require('../utils/replicarEnModulo');
const configuracion = require('../utils/configuracion');
const { ESTADO_FACTURACION_SIN } = require('../utils/estadoFactura');
const { ESTADO_LEAD_COTIZADO, ESTADO_LEAD_INGRESADO } = require('../utils/estadoLead');

const ROLES_VER = ['super_admin', 'admin', 'contabilidad'];
const ROLES_EDIT = ['super_admin', 'admin'];

// Estado de cada versión de cotización. Reducido a 3 valores: el flujo es
// crear (Cotizado) → decidir (Aprobado | Rechazado). No hay "Enviada" ni
// "Expirada" — la fecha_validez sigue como referencia, pero no muta el estado.
const ESTADOS_VERSION = {
  COTIZADO: 'Cotizado',
  APROBADO: 'Aprobado',
  RECHAZADO: 'Rechazado'
};

// Estado global de la cotización — derivado del ciclo operativo del servicio
// asociado. Se recalcula con `sincronizarEstadoGlobal` siempre que cambie el
// servicio, su cobro o sus facturas. Nunca se setea manualmente.
const ESTADO_GLOBAL = {
  COTIZADO: 'Cotizado',
  ACEPTADO: 'Aceptado',
  EJECUCION: 'Ejecución',
  PENDIENTE: 'Pendiente',
  TERMINADO: 'Terminado'
};

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
  include: { ascensor: true }
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

const listar = async (req, res) => {
  try {
    if (!puedeVer(req)) return res.status(403).json({ error: 'No autorizado' });
    const { q, estado_global, id_cliente, id_tipo_servicio, desde, hasta } = req.query;
    const where = { estado: 1 };
    if (q) where.OR = [
      // Código y título de la cotización
      { codigo: { contains: q, mode: 'insensitive' } },
      { titulo: { contains: q, mode: 'insensitive' } },
      // Nombre del cliente
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      // Tipo de ascensor (Pasajeros / Camillero / Carga / …) en cualquiera de
      // los ascensores existentes vinculados a la cotización
      { ascensores: { some: { estado: 1, ascensor: { tipo: { contains: q, mode: 'insensitive' } } } } },
      // Código de servicio generado por la cotización (cuando ya fue aprobada)
      { servicios: { some: { estado: 1, codigo: { contains: q, mode: 'insensitive' } } } }
    ];
    if (estado_global) where.estado_global = estado_global;
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_tipo_servicio) where.id_tipo_servicio = Number(id_tipo_servicio);
    if (desde || hasta) {
      where.date_time_registration = {};
      if (desde) where.date_time_registration.gte = parseYMDLima(desde);
      if (hasta) where.date_time_registration.lte = parseYMDFinDiaLima(hasta);
    }

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
            include: { ascensor: { select: { id: true, codigo: true, ubicacion: true } } }
          },
          tipo_servicio: { select: { id: true, nombre: true } },
          versiones: {
            where: { estado: 1 },
            orderBy: { numero_version: 'desc' },
            take: 1,
            select: {
              id: true, numero_version: true, estado_version: true,
              monto_total: true, moneda: true, fecha_validez: true
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
        tipo_servicio: true,
        versiones: {
          where: { estado: 1 },
          orderBy: { numero_version: 'asc' },
          include: {
            items: { where: { estado: 1 }, orderBy: { orden: 'asc' } },
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

    res.json({ data: cotizacion });
  } catch (err) {
    console.error('[cotizaciones.obtener]', err);
    res.status(500).json({ error: 'Error al obtener cotización' });
  }
};

const crear = async (req, res) => {
  try {
    if (!puedeEditar(req)) return res.status(403).json({ error: 'No autorizado' });
    const d = req.body || {};

    if (!d.id_cliente) return res.status(400).json({ error: 'Cliente obligatorio' });
    if (!d.id_tipo_servicio) return res.status(400).json({ error: 'Tipo de servicio obligatorio' });
    if (!d.titulo) return res.status(400).json({ error: 'Título obligatorio' });
    if (!d.fecha_validez) return res.status(400).json({ error: 'Fecha de validez obligatoria' });

    let ascensoresLimpios;
    try {
      ascensoresLimpios = normalizarAscensores(d.ascensores);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const items = Array.isArray(d.items) ? d.items : [];
    if (items.length === 0) return res.status(400).json({ error: 'Debe agregar al menos un item' });

    const igvTasa = await configuracion.obtener('IGV_RATE');
    const totales = calcularTotalesVersion(items, igvTasa);

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

    const codigo = await generarCodigoCotizacion();

    const creada = await prisma.$transaction(async (tx) => {
      const cot = await tx.tbl_cotizaciones.create({
        data: {
          codigo,
          id_cliente: Number(d.id_cliente),
          id_lead: d.id_lead ? Number(d.id_lead) : null,
          id_tipo_servicio: Number(d.id_tipo_servicio),
          titulo: d.titulo,
          descripcion: d.descripcion || null,
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
          fecha_validez: parseYMDLima(d.fecha_validez),
          moneda: d.moneda || 'PEN',
          subtotal: totales.subtotal,
          igv: totales.igv,
          igv_tasa: totales.igv_tasa,
          monto_total: totales.monto_total,
          estado_version: ESTADOS_VERSION.COTIZADO,
          motivo_cambio: null,
          observaciones: d.observaciones || null,
          terminos: d.terminos || (await configuracion.obtener('COTIZACION_TERMINOS')),
          tiene_cuotas: tieneCuotas,
          plan_cuotas: planCuotas,
          saldo_variable: saldoVariable,
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

    const cot = await prisma.$transaction(async (tx) => {
      const actualizado = await tx.tbl_cotizaciones.update({
        where: { id },
        data: {
          id_cliente: d.id_cliente ? Number(d.id_cliente) : prev.cotizacion.id_cliente,
          id_tipo_servicio: d.id_tipo_servicio ? Number(d.id_tipo_servicio) : prev.cotizacion.id_tipo_servicio,
          titulo: d.titulo ?? prev.cotizacion.titulo,
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

    // Total efectivo después de la actualización (puede venir de items nuevos o quedarse igual)
    const totalNuevo = items
      ? calcularTotalesVersion(items, igvTasa).monto_total
      : Number(version.monto_total);

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
        fecha_validez: d.fecha_validez ? parseYMDLima(d.fecha_validez) : version.fecha_validez,
        moneda: d.moneda ?? version.moneda,
        observaciones: d.observaciones ?? version.observaciones,
        terminos: d.terminos ?? version.terminos,
        tiene_cuotas: nuevoTieneCuotas,
        plan_cuotas: nuevoPlanCuotas,
        saldo_variable: nuevoSaldoVariable,
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
              user_id_registration: req.user.id
            }
          });
        }
        const totales = calcularTotalesVersion(items, igvTasa);
        dataUpdate.subtotal = totales.subtotal;
        dataUpdate.igv = totales.igv;
        dataUpdate.igv_tasa = totales.igv_tasa;
        dataUpdate.monto_total = totales.monto_total;
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

    const validezDias = await configuracion.obtener('COTIZACION_VALIDEZ_DIAS');
    // Sumar N días en TZ Lima a partir del inicio del día actual en Lima.
    // Lima no observa DST, así que sumar N*86400000 ms es exacto.
    const nuevaValidez = new Date(inicioDelDiaLima().getTime() + Number(validezDias || 15) * 86400000);

    const nueva = await prisma.$transaction(async (tx) => {
      const ver = await tx.tbl_cotizaciones_versiones.create({
        data: {
          id_cotizacion: id,
          numero_version: ultima.numero_version + 1,
          fecha_validez: nuevaValidez,
          moneda: ultima.moneda,
          subtotal: ultima.subtotal,
          igv: ultima.igv,
          igv_tasa: ultima.igv_tasa,
          monto_total: ultima.monto_total,
          estado_version: ESTADOS_VERSION.COTIZADO,
          motivo_cambio: motivo,
          observaciones: ultima.observaciones,
          terminos: ultima.terminos,
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
    if (cot.estado_global === ESTADO_GLOBAL.TERMINADO || cot.estado_global === ESTADO_GLOBAL.COTIZADO) {
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
async function _reAprobarTx({ tx, cot, version, servicioExistente, fechaProgramada, userId, idArchivoRespaldo }) {
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
      // Sin plan declarado, una cuota única con el restante a la fecha programada
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
        estado_contable: 'Pendiente',
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
        ascensores: INCLUDE_ASCENSORES
      }
    });
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
    if (cot.estado_global === ESTADO_GLOBAL.TERMINADO) {
      return res.status(400).json({ error: 'La cotización ya está Terminada' });
    }

    const version = await prisma.tbl_cotizaciones_versiones.findUnique({
      where: { id_cotizacion_numero_version: { id_cotizacion: id, numero_version: numero } }
    });
    if (!version) return res.status(404).json({ error: 'Versión no encontrada' });
    if (!transicionPermitida(version.estado_version, ESTADOS_VERSION.APROBADO)) {
      return res.status(400).json({ error: `No se puede aprobar desde ${version.estado_version}` });
    }

    if (!Array.isArray(cot.ascensores) || cot.ascensores.length === 0) {
      return res.status(400).json({ error: 'Cotización sin ascensores asociados' });
    }

    const fechaProgramada = d.fecha_programada ? parseYMDLima(d.fecha_programada) : new Date();
    const horaProgramada = d.hora_programada || '09:00';

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
          fechaProgramada,
          userId: req.user.id,
          idArchivoRespaldo: d.id_archivo_respaldo ? Number(d.id_archivo_respaldo) : null
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

    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Resolver cada fila de la cotización a un id_ascensor. Las que tengan
      //    ascensor_nuevo crean primero el registro en tbl_ascensores con estado
      //    "Por instalar" y luego se enlazan al servicio.
      let totalAscensoresCliente = await tx.tbl_ascensores.count({ where: { id_cliente: cot.id_cliente } });
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
            id_cliente: cot.id_cliente,
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
      const codigoSrv = await generarCodigoServicio();
      const servicio = await tx.tbl_servicios_proyectos.create({
        data: {
          codigo: codigoSrv,
          tipo_registro: d.tipo_registro || 'servicio',
          id_tipo_servicio: cot.id_tipo_servicio,
          id_cliente: cot.id_cliente,
          id_cotizacion: cot.id,
          origen: 'cotizacion',
          titulo: cot.titulo,
          descripcion: cot.descripcion,
          fecha_programada: fechaProgramada,
          hora_programada: horaProgramada,
          prioridad: d.prioridad || 'media',
          estado_servicio: 'Pendiente',
          precio_interno: version.monto_total,
          moneda: version.moneda,
          observaciones: d.observaciones || null,
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

      // 2.b Evento en el calendario operativo. Sin esta fila el servicio NO
      // aparece en /calendario (incluyendo la vista del técnico filtrada por
      // asignación), aunque exista la fila en tbl_servicios_proyectos. Espeja
      // lo que hace serviciosController.crear para el alta directa.
      const fechaInicioEvento = combinarFechaHoraLima(d.fecha_programada, horaProgramada);
      const tipoEventoCotizacion = servicio.tipo_registro === 'proyecto' ? 'proyecto' : 'servicio';
      await tx.tbl_calendario_eventos.create({
        data: {
          id_servicio: servicio.id,
          titulo: `${servicio.codigo} – ${servicio.titulo}`,
          tipo_evento: tipoEventoCotizacion,
          fecha_inicio: fechaInicioEvento,
          estado_evento: 'programado',
          color: colorPorTipo(tipoEventoCotizacion)
        }
      });

      // 3. Cobro + plan de cuotas (si la versión lo declara). El cobro nace
      // aquí (no al finalizar el servicio) para que aparezca en gestión de
      // cobros desde la aprobación, en paralelo al ciclo de ejecución.
      await crearCobroInicial(tx, {
        idServicio: servicio.id,
        idCliente: cot.id_cliente,
        monto: version.monto_total,
        moneda: version.moneda,
        fechaCuotaUnica: fechaProgramada,
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
          estado_contable: 'Pendiente',
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
        tipoServicio: cot.tipo_servicio,
        idsAscensores: idsResueltos,
        idCliente: cot.id_cliente,
        horaProgramada,
        fechaProgramada,
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
      //    (ingresó como servicio) y enlazar el servicio generado.
      if (cot.id_lead) {
        await tx.tbl_leads.update({
          where: { id: cot.id_lead },
          data: {
            estado_lead: ESTADO_LEAD_INGRESADO,
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
    const cot = await prisma.tbl_cotizaciones.findUnique({ where: { id } });
    if (!cot) return res.status(404).json({ error: 'No encontrada' });
    // No se permite eliminar cotizaciones que ya generaron servicio en curso o
    // terminado: cualquier estado_global diferente de Cotizado tiene servicio
    // vivo, y eliminar la cotización dejaría a ese servicio huérfano.
    if (cot.estado_global !== ESTADO_GLOBAL.COTIZADO) {
      return res.status(400).json({ error: 'No se puede eliminar una cotización con servicio asociado' });
    }
    await prisma.tbl_cotizaciones.update({
      where: { id },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cotizaciones', id_entidad: id,
      accion: 'DELETE', valor_anterior: cot, ip: req.ip
    });
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
      include: { cliente: true, tipo_servicio: true, ascensores: INCLUDE_ASCENSORES }
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

    await prisma.tbl_cotizaciones_archivos.update({
      where: { id: idAdjunto },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cotizaciones_archivos', id_entidad: idAdjunto,
      accion: 'DELETE', valor_anterior: adjunto, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[cotizaciones.eliminarArchivo]', err);
    res.status(500).json({ error: 'Error al eliminar archivo' });
  }
};

module.exports = {
  listar,
  obtener,
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

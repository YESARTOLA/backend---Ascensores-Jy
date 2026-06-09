const prisma = require('../config/prisma');
const { inicioDelDiaLima, parseYMDLima, parseYMDFinDiaLima } = require('../utils/tiempo');
const {
  ESTADO_FACTURACION_SIN,
  ESTADO_FACTURACION_PENDIENTE,
  ESTADOS_FACTURACION_COMPLETA
} = require('../utils/estadoFactura');
const { ESTADO_LEAD_INGRESADO, ESTADO_LEAD_DESCARTADO } = require('../utils/estadoLead');

const ROLES_PRECIO = ['super_admin', 'admin', 'contabilidad'];

const operativos = async (req, res) => {
  try {
    const { desde, hasta, id_cliente, id_tecnico, estado_servicio, id_ascensor, id_tipo_servicio } = req.query;
    const where = { estado: 1 };
    if (desde || hasta) {
      where.fecha_programada = {};
      if (desde) where.fecha_programada.gte = parseYMDLima(desde);
      if (hasta) where.fecha_programada.lte = parseYMDFinDiaLima(hasta);
    }
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_ascensor) where.ascensores = { some: { id_ascensor: Number(id_ascensor), estado: 1 } };
    if (id_tipo_servicio) where.id_tipo_servicio = Number(id_tipo_servicio);
    if (estado_servicio) where.estado_servicio = estado_servicio;
    if (id_tecnico) where.asignaciones = { some: { id_tecnico: Number(id_tecnico), estado: 1 } };

    const servicios = await prisma.tbl_servicios_proyectos.findMany({
      where, orderBy: { id: 'desc' },
      include: {
        cliente: { select: { nombre: true } },
        ascensores: { where: { estado: 1 }, include: { ascensor: { select: { codigo: true } } } },
        tipo_servicio: true,
        asignaciones: { include: { tecnico: { select: { nombre: true } } }, where: { estado: 1 } },
        // Datos financieros del cobro (fuente única, la misma de Gestión de
        // cobros) para mostrar cuánto se lleva cobrado y cuánto falta pagar.
        cobro: { select: { total_abonado: true, saldo_pendiente: true, moneda: true } }
      }
    });

    // Roles sin acceso financiero no ven precio ni montos del cobro.
    const sanit = ROLES_PRECIO.includes(req.user.rol_codigo)
      ? servicios
      : servicios.map(s => ({ ...s, precio_interno: null, cobro: null }));
    res.json({ data: sanit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte operativo' });
  }
};

const emergenciasAtendidas = async (req, res) => {
  try {
    const { desde, hasta, estado_emergencia, nivel_urgencia, id_cliente } = req.query;
    const where = { estado: 1 };
    if (desde || hasta) {
      where.fecha_reporte = {};
      if (desde) where.fecha_reporte.gte = parseYMDLima(desde);
      if (hasta) where.fecha_reporte.lte = parseYMDFinDiaLima(hasta);
    }
    if (estado_emergencia) where.estado_emergencia = estado_emergencia;
    if (nivel_urgencia) where.nivel_urgencia = nivel_urgencia;
    if (id_cliente) where.id_cliente = Number(id_cliente);

    const list = await prisma.tbl_emergencias.findMany({
      where, orderBy: { fecha_reporte: 'desc' },
      include: {
        cliente: { select: { nombre: true } },
        ascensor: { select: { codigo: true, ubicacion: true } },
        servicio: {
          select: {
            codigo: true, estado_servicio: true,
            asignaciones: { where: { estado: 1 }, include: { tecnico: { select: { nombre: true } } } }
          }
        }
      }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte emergencias' });
  }
};

const mantenimientosCumplidos = async (req, res) => {
  try {
    const { desde, hasta, id_cliente, id_ascensor } = req.query;
    const where = {
      estado: 1,
      origen: 'mantenimiento',
      OR: [
        { estado_servicio: { startsWith: 'Finalizado' } },
        { estado_servicio: { in: ['Cerrado', 'A gestión de cobro', 'En revisión administrativa', 'En cobro', 'Cobrado parcial', 'Cobrado total', 'Facturado'] } }
      ]
    };
    if (desde || hasta) {
      where.fecha_programada = {};
      if (desde) where.fecha_programada.gte = parseYMDLima(desde);
      if (hasta) where.fecha_programada.lte = parseYMDFinDiaLima(hasta);
    }
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_ascensor) where.ascensores = { some: { id_ascensor: Number(id_ascensor), estado: 1 } };

    const servicios = await prisma.tbl_servicios_proyectos.findMany({
      where, orderBy: { fecha_programada: 'desc' },
      include: {
        cliente: true,
        ascensores: { where: { estado: 1 }, include: { ascensor: true } },
        tipo_servicio: true,
        asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
        mantenimiento_plan: true
      }
    });
    const sanit = ROLES_PRECIO.includes(req.user.rol_codigo)
      ? servicios
      : servicios.map(s => ({ ...s, precio_interno: null }));
    res.json({ data: sanit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte mantenimientos cumplidos' });
  }
};

const serviciosFinalizados = async (req, res) => {
  try {
    const { desde, hasta, id_cliente, id_tecnico, id_tipo_servicio } = req.query;
    const where = { estado: 1 };
    if (desde || hasta) {
      where.fecha_realizacion = {};
      if (desde) where.fecha_realizacion.gte = parseYMDLima(desde);
      if (hasta) where.fecha_realizacion.lte = parseYMDFinDiaLima(hasta);
    }
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_tecnico) where.OR = [{ id_tecnico_principal: Number(id_tecnico) }, { id_responsable_documentacion: Number(id_tecnico) }];

    const realizados = await prisma.tbl_servicios_realizados.findMany({
      where, orderBy: { fecha_realizacion: 'desc' },
      include: {
        servicio: {
          include: {
            cliente: true,
            ascensores: { where: { estado: 1 }, include: { ascensor: true } },
            tipo_servicio: true,
            asignaciones: { where: { estado: 1 }, include: { tecnico: true } }
          }
        }
      }
    });
    const filtrados = id_tipo_servicio
      ? realizados.filter(r => r.servicio?.id_tipo_servicio === Number(id_tipo_servicio))
      : realizados;
    const sanit = filtrados.map(r => ({
      ...r,
      servicio: r.servicio && !ROLES_PRECIO.includes(req.user.rol_codigo)
        ? { ...r.servicio, precio_interno: null }
        : r.servicio
    }));
    res.json({ data: sanit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte servicios finalizados' });
  }
};

const pendientesDeCobro = async (req, res) => {
  try {
    if (!ROLES_PRECIO.includes(req.user.rol_codigo)) return res.status(403).json({ error: 'No autorizado' });
    const { id_cliente } = req.query;
    const where = {
      estado: 1,
      saldo_pendiente: { gt: 0 },
      estado_cobro: { in: ['Pendiente de iniciar', 'En gestión'] }
    };
    if (id_cliente) where.id_cliente = Number(id_cliente);
    const list = await prisma.tbl_cobros.findMany({
      where, orderBy: { id: 'desc' },
      include: { cliente: true, servicio: { include: { tipo_servicio: true, ascensores: { where: { estado: 1 }, include: { ascensor: true } } } } }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte pendientes de cobro' });
  }
};

const cobrosVencidos = async (req, res) => {
  try {
    if (!ROLES_PRECIO.includes(req.user.rol_codigo)) return res.status(403).json({ error: 'No autorizado' });
    const { id_cliente } = req.query;
    const hoy = inicioDelDiaLima();
    const where = {
      estado: 1,
      saldo_pendiente: { gt: 0 },
      fecha_proximo_abono: { lt: hoy }
    };
    if (id_cliente) where.id_cliente = Number(id_cliente);
    const list = await prisma.tbl_cobros.findMany({
      where, orderBy: { fecha_proximo_abono: 'asc' },
      include: { cliente: true, servicio: { include: { ascensores: { where: { estado: 1 }, include: { ascensor: true } }, tipo_servicio: true } } }
    });
    const data = list.map(c => {
      const dias = Math.round((hoy - new Date(c.fecha_proximo_abono)) / (1000 * 60 * 60 * 24));
      return { ...c, dias_vencido: dias, en_mora: dias >= 30 };
    });
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte cobros vencidos' });
  }
};

const historialTecnicoAscensor = async (req, res) => {
  try {
    const { id_ascensor } = req.query;
    if (!id_ascensor) return res.status(400).json({ error: 'id_ascensor obligatorio' });

    const ascensor = await prisma.tbl_ascensores.findUnique({
      where: { id: Number(id_ascensor) },
      include: { cliente: true }
    });
    if (!ascensor) return res.status(404).json({ error: 'Ascensor no encontrado' });

    const [servicios, emergencias, mantenimientos, eventos] = await Promise.all([
      prisma.tbl_servicios_proyectos.findMany({
        where: { ascensores: { some: { id_ascensor: Number(id_ascensor), estado: 1 } }, estado: 1 },
        orderBy: { fecha_programada: 'desc' },
        include: {
          tipo_servicio: true,
          ascensores: { where: { estado: 1 }, include: { ascensor: true } },
          asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
          guias: { where: { estado: 1 } },
          evidencias: { where: { estado: 1 } }
        }
      }),
      prisma.tbl_emergencias.findMany({
        where: { id_ascensor: Number(id_ascensor), estado: 1 },
        orderBy: { fecha_reporte: 'desc' }
      }),
      prisma.tbl_mantenimientos_planes.findMany({
        where: { id_ascensor: Number(id_ascensor), estado: 1 }
      }),
      prisma.tbl_ascensores_historial.findMany({
        where: { id_ascensor: Number(id_ascensor) },
        orderBy: { fecha_evento: 'desc' },
        take: 200
      })
    ]);

    const sanit = ROLES_PRECIO.includes(req.user.rol_codigo)
      ? servicios
      : servicios.map(s => ({ ...s, precio_interno: null }));
    res.json({ data: { ascensor, servicios: sanit, emergencias, mantenimientos, eventos } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en historial técnico' });
  }
};

const cobros = async (req, res) => {
  try {
    if (!ROLES_PRECIO.includes(req.user.rol_codigo)) return res.status(403).json({ error: 'No autorizado' });
    const list = await prisma.tbl_cobros.findMany({
      where: { estado: 1 }, orderBy: { id: 'desc' },
      include: { cliente: true, servicio: true }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte cobros' });
  }
};

const tecnicos = async (_req, res) => {
  try {
    const tecs = await prisma.tbl_tecnicos.findMany({
      where: { estado: 1 },
      include: {
        asignaciones: {
          where: { estado: 1 },
          include: { servicio: { select: { id: true, codigo: true, estado_servicio: true } } }
        }
      }
    });
    const data = tecs.map(t => {
      const asignados = t.asignaciones.length;
      const finalizados = t.asignaciones.filter(a => a.servicio?.estado_servicio?.startsWith('Finalizado') || a.servicio?.estado_servicio === 'Cerrado').length;
      const enCurso = t.asignaciones.filter(a => ['En camino', 'En curso'].includes(a.servicio?.estado_servicio)).length;
      return { id: t.id, nombre: t.nombre, estado_operativo: t.estado_operativo, asignados, finalizados, enCurso };
    });
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte técnicos' });
  }
};

const correctivos = async (req, res) => {
  try {
    const { desde, hasta, id_cliente, estado_correctivo, nivel_urgencia } = req.query;
    const where = { estado: 1 };
    if (desde || hasta) {
      where.fecha_reporte = {};
      if (desde) where.fecha_reporte.gte = parseYMDLima(desde);
      if (hasta) where.fecha_reporte.lte = parseYMDFinDiaLima(hasta);
    }
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (estado_correctivo) where.estado_correctivo = estado_correctivo;
    if (nivel_urgencia) where.nivel_urgencia = nivel_urgencia;
    const list = await prisma.tbl_correctivos.findMany({
      where, orderBy: { fecha_reporte: 'desc' },
      include: {
        cliente: { select: { nombre: true } },
        ascensor: { select: { codigo: true, ubicacion: true } },
        servicio: {
          select: {
            codigo: true, estado_servicio: true,
            asignaciones: { where: { estado: 1 }, include: { tecnico: { select: { nombre: true } } } }
          }
        }
      }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte correctivos' });
  }
};

const atencionesRapidas = async (req, res) => {
  try {
    const { desde, hasta, id_cliente, estado_atencion, nivel_urgencia, tipo_solicitud } = req.query;
    const where = { estado: 1 };
    if (desde || hasta) {
      where.date_time_registration = {};
      if (desde) where.date_time_registration.gte = parseYMDLima(desde);
      if (hasta) where.date_time_registration.lte = parseYMDFinDiaLima(hasta);
    }
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (estado_atencion) where.estado_atencion = estado_atencion;
    if (nivel_urgencia) where.nivel_urgencia = nivel_urgencia;
    if (tipo_solicitud) where.tipo_solicitud = tipo_solicitud;
    const list = await prisma.tbl_atenciones_rapidas.findMany({
      where, orderBy: { date_time_registration: 'desc' },
      include: {
        cliente: { select: { nombre: true } },
        ascensor: { select: { codigo: true } }
      }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte atenciones rápidas' });
  }
};

const leads = async (_req, res) => {
  try {
    const list = await prisma.tbl_leads.findMany({
      where: { estado: 1 },
      include: { tipo_servicio: true, cliente: true }
    });
    const porCanal = {};
    list.forEach(l => {
      const k = l.canal || 'desconocido';
      porCanal[k] = (porCanal[k] || 0) + 1;
    });
    const convertidos = list.filter(l => l.estado_lead === ESTADO_LEAD_INGRESADO).length;
    const descartados = list.filter(l => l.estado_lead === ESTADO_LEAD_DESCARTADO).length;
    res.json({ data: { total: list.length, convertidos, descartados, porCanal, leads: list } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte leads' });
  }
};

const ascensores = async (_req, res) => {
  try {
    const list = await prisma.tbl_ascensores.findMany({
      where: { estado: 1 },
      include: { cliente: true, _count: { select: { servicios_ascensores: true, emergencias: true } } }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error reporte ascensores' });
  }
};

const mantenimientosVencidos = async (_req, res) => {
  try {
    const hoy = inicioDelDiaLima();
    const list = await prisma.tbl_servicios_proyectos.findMany({
      where: {
        estado: 1,
        origen: 'mantenimiento',
        estado_servicio: { in: ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida'] },
        fecha_programada: { lt: hoy }
      },
      orderBy: { fecha_programada: 'asc' },
      include: { cliente: true, ascensores: { where: { estado: 1 }, include: { ascensor: true } }, tipo_servicio: true }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error reporte mantenimientos vencidos' });
  }
};

const moraPorCliente = async (req, res) => {
  try {
    if (!ROLES_PRECIO.includes(req.user.rol_codigo)) return res.status(403).json({ error: 'No autorizado' });
    const hoy = inicioDelDiaLima();
    const cobros = await prisma.tbl_cobros.findMany({
      where: {
        estado: 1,
        saldo_pendiente: { gt: 0 },
        fecha_proximo_abono: { lt: hoy }
      },
      include: { cliente: true, servicio: true }
    });
    const agrupado = {};
    cobros.forEach(c => {
      const k = c.id_cliente;
      agrupado[k] ||= { cliente: c.cliente, total_saldo: 0, casos: 0, servicios: [] };
      agrupado[k].total_saldo += Number(c.saldo_pendiente);
      agrupado[k].casos += 1;
      agrupado[k].servicios.push({ codigo: c.servicio?.codigo, saldo: c.saldo_pendiente, vencimiento: c.fecha_proximo_abono });
    });
    res.json({ data: Object.values(agrupado).sort((a, b) => b.total_saldo - a.total_saldo) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error reporte mora' });
  }
};

const facturados = async (req, res) => {
  try {
    if (!ROLES_PRECIO.includes(req.user.rol_codigo)) return res.status(403).json({ error: 'No autorizado' });
    const facturados = req.query.facturados !== '0';
    const realizados = await prisma.tbl_servicios_realizados.findMany({
      where: {
        estado: 1,
        estado_facturacion: facturados
          ? { in: ESTADOS_FACTURACION_COMPLETA }
          : { in: [ESTADO_FACTURACION_SIN, ESTADO_FACTURACION_PENDIENTE] }
      },
      include: {
        servicio: {
          include: { cliente: true, ascensores: { where: { estado: 1 }, include: { ascensor: true } }, tipo_servicio: true, facturas: true, cobro: true }
        }
      },
      orderBy: { fecha_realizacion: 'desc' }
    });
    res.json({ data: realizados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error reporte facturación' });
  }
};

const abonosRegistrados = async (req, res) => {
  try {
    if (!ROLES_PRECIO.includes(req.user.rol_codigo)) return res.status(403).json({ error: 'No autorizado' });
    const { desde, hasta } = req.query;
    const where = { estado: 1 };
    if (desde || hasta) {
      where.fecha_pago = {};
      if (desde) where.fecha_pago.gte = parseYMDLima(desde);
      if (hasta) where.fecha_pago.lte = parseYMDFinDiaLima(hasta);
    }
    const pagos = await prisma.tbl_pagos.findMany({
      where, orderBy: { fecha_pago: 'desc' },
      include: { cobro: { include: { cliente: true, servicio: true } } }
    });
    res.json({ data: pagos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error reporte abonos' });
  }
};

/**
 * Reporte: ingresos por banco. Agrupa los pagos (tbl_pagos) por cuenta
 * bancaria de destino, devolviendo totales y el detalle de cada abono.
 * Los pagos sin cuenta bancaria (Efectivo, Otro) se agrupan por método
 * y moneda bajo "Sin cuenta", para no perder visibilidad de los ingresos.
 *
 * Filtros: desde, hasta (sobre fecha_pago); id_cuenta_bancaria, banco,
 * moneda (filtran a nivel relación cuenta_bancaria).
 */
const ingresosPorBanco = async (req, res) => {
  try {
    if (!ROLES_PRECIO.includes(req.user.rol_codigo)) return res.status(403).json({ error: 'No autorizado' });
    const { desde, hasta, id_cuenta_bancaria, banco, moneda } = req.query;

    const where = { estado: 1 };
    if (desde || hasta) {
      where.fecha_pago = {};
      if (desde) where.fecha_pago.gte = parseYMDLima(desde);
      if (hasta) where.fecha_pago.lte = parseYMDFinDiaLima(hasta);
    }
    if (id_cuenta_bancaria) {
      where.id_cuenta_bancaria = Number(id_cuenta_bancaria);
    } else if (banco || moneda) {
      const cuentaWhere = {};
      if (banco) cuentaWhere.banco = banco;
      if (moneda) cuentaWhere.moneda = moneda;
      where.cuenta_bancaria = { is: cuentaWhere };
    }

    const pagos = await prisma.tbl_pagos.findMany({
      where,
      orderBy: { fecha_pago: 'desc' },
      include: {
        cuenta_bancaria: true,
        cobro: { include: { cliente: { select: { id: true, nombre: true } }, servicio: { select: { id: true, codigo: true } } } }
      }
    });

    const grupos = new Map();
    const totalesPorMoneda = {};

    for (const p of pagos) {
      const monto = Number(p.monto) || 0;
      let key;
      let meta;
      if (p.cuenta_bancaria) {
        const c = p.cuenta_bancaria;
        key = `cuenta:${c.id}`;
        meta = {
          id_cuenta: c.id,
          etiqueta: `${c.banco} · ${c.nombre}`,
          banco: c.banco,
          tipo_cuenta: c.tipo_cuenta,
          moneda: c.moneda,
          numero_cuenta: c.numero_cuenta,
          cci: c.cci,
          titular: c.titular
        };
      } else {
        const metodo = p.metodo_pago || 'Sin método';
        key = `sin-cuenta:${metodo}`;
        meta = {
          id_cuenta: null,
          etiqueta: `Sin cuenta — ${metodo}`,
          banco: null,
          tipo_cuenta: null,
          moneda: null,
          numero_cuenta: null,
          cci: null,
          titular: null,
          metodo_pago: metodo
        };
      }

      const grupo = grupos.get(key) || { ...meta, cantidad_pagos: 0, total: 0, pagos: [] };
      grupo.cantidad_pagos += 1;
      grupo.total += monto;
      grupo.pagos.push({
        id: p.id,
        fecha_pago: p.fecha_pago,
        metodo_pago: p.metodo_pago,
        monto,
        numero_abono: p.numero_abono,
        observaciones: p.observaciones,
        id_archivo_comprobante: p.id_archivo_comprobante,
        cliente: p.cobro?.cliente || null,
        servicio: p.cobro?.servicio || null
      });
      grupos.set(key, grupo);

      const m = meta.moneda || 'SIN_MONEDA';
      totalesPorMoneda[m] = (totalesPorMoneda[m] || 0) + monto;
    }

    const data = Array.from(grupos.values()).sort((a, b) => {
      if (a.id_cuenta == null && b.id_cuenta != null) return 1;
      if (a.id_cuenta != null && b.id_cuenta == null) return -1;
      return b.total - a.total;
    });

    res.json({ data: { grupos: data, totales_por_moneda: totalesPorMoneda } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error reporte ingresos por banco' });
  }
};

// Estados de ejecución que produce el dataset de mantenimientos. Se nombran
// para no repetir literales en el conteo. 'Proyectado' es la ocurrencia teórica
// del cronograma de un plan continuo que aún no se ha materializado en servicio.
const EJEC_REALIZADO = 'Realizado';
const EJEC_EN_CURSO = 'En curso';
const EJEC_CANCELADO = 'Cancelado';

/**
 * Reporte: mantenimientos por cliente (maestro-detalle).
 * Para cada cliente con planes activos devuelve el desglose POR PLAN de sus
 * mantenimientos programados, contando por estado de ejecución. Cuando se
 * recibe un rango (desde/hasta) los conteos reflejan solo las ocurrencias cuya
 * fecha programada cae dentro del rango.
 *
 * Reutiliza el dataset del módulo de mantenimientos (instancias materializadas
 * + proyecciones del cronograma) para no duplicar esa lógica.
 *
 * Query: id_cliente?, desde?, hasta?
 */
const mantenimientosPorCliente = async (req, res) => {
  try {
    const { id_cliente, desde, hasta } = req.query;
    const { construirDatasetReporteMantenimientos } = require('./mantenimientosController');
    const idsCliente = id_cliente ? [Number(id_cliente)] : null;

    const dataset = await construirDatasetReporteMantenimientos({
      idsCliente, idsAscensor: null, estadoEjecucion: null, desde, hasta
    });

    const data = dataset
      .map(grupo => {
        const progsPorPlan = new Map();
        for (const pr of grupo.programaciones) {
          const arr = progsPorPlan.get(pr.id_plan) || [];
          arr.push(pr);
          progsPorPlan.set(pr.id_plan, arr);
        }

        const planes = grupo.planes.map(plan => {
          const progs = progsPorPlan.get(plan.id) || [];
          const programados = progs.length;
          const realizados = progs.filter(p => p.estado_ejecucion === EJEC_REALIZADO).length;
          const en_curso = progs.filter(p => p.estado_ejecucion === EJEC_EN_CURSO).length;
          const cancelados = progs.filter(p => p.estado_ejecucion === EJEC_CANCELADO).length;
          // "Faltan" = programados aún por realizar (pendientes + proyectados),
          // descontando los ya realizados, en curso o cancelados.
          const faltan = programados - realizados - en_curso - cancelados;
          return {
            id_plan: plan.id,
            ascensor_codigo: plan.ascensor?.codigo || null,
            ascensor_ubicacion: plan.ascensor?.ubicacion || null,
            tipo_servicio: plan.tipo_servicio?.nombre || null,
            tipo_plan: plan.tipo_plan,
            frecuencia: plan.frecuencia || null,
            programados,
            realizados,
            faltan,
            en_curso,
            cancelados,
            gratuitos_cupo: Number(plan.cantidad_mantenimientos_gratuitos || 0),
            gratuitos_ejecutados: Number(plan.mantenimientos_gratuitos_ejecutados || 0)
          };
        });

        const resumen = planes.reduce((acc, p) => ({
          programados: acc.programados + p.programados,
          realizados: acc.realizados + p.realizados,
          faltan: acc.faltan + p.faltan,
          en_curso: acc.en_curso + p.en_curso,
          cancelados: acc.cancelados + p.cancelados
        }), { programados: 0, realizados: 0, faltan: 0, en_curso: 0, cancelados: 0 });

        return {
          id_cliente: grupo.cliente?.id ?? null,
          cliente_nombre: grupo.cliente?.nombre || '—',
          planes_total: planes.length,
          ...resumen,
          planes
        };
      })
      // Solo clientes con planes activos (un cliente sin planes no aporta filas).
      .filter(c => c.planes_total > 0)
      .sort((a, b) => a.cliente_nombre.localeCompare(b.cliente_nombre));

    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte mantenimientos por cliente' });
  }
};

/**
 * Reporte: mantenimientos programados (eventos) que aún no tienen servicio creado.
 * Devuelve un evento por línea con datos del cliente, ascensor, precio del plan
 * y la fecha programada. Útil para identificar mantenimientos por materializar.
 */
const mantenimientosProgramadosSinServicio = async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const where = {
      estado: 1,
      id_mantenimiento_plan: { not: null },
      id_servicio: null
    };
    if (desde || hasta) {
      where.fecha_inicio = {};
      if (desde) where.fecha_inicio.gte = parseYMDLima(desde);
      if (hasta) where.fecha_inicio.lte = parseYMDFinDiaLima(hasta);
    }
    const eventos = await prisma.tbl_calendario_eventos.findMany({
      where,
      orderBy: { fecha_inicio: 'asc' },
      include: {
        mantenimiento_plan: {
          include: {
            cliente: {
              select: {
                id: true, nombre: true,
                precios: { where: { estado: 1 }, select: { id_tipo_servicio: true, precio: true, moneda: true } }
              }
            },
            ascensor: { select: { id: true, codigo: true, ubicacion: true } },
            tipo_servicio: { select: { id: true, nombre: true } }
          }
        }
      }
    });

    const hoy = inicioDelDiaLima();
    const data = eventos.map(e => {
      const plan = e.mantenimiento_plan;
      const fecha = e.fecha_inicio;
      const vencido = fecha && new Date(fecha) < hoy;
      const precioCfg = plan?.cliente?.precios?.find(p => p.id_tipo_servicio === plan.id_tipo_servicio) || null;
      return {
        id_evento: e.id,
        fecha_programada: fecha,
        vencido,
        id_plan: plan?.id || null,
        cliente: plan?.cliente ? { id: plan.cliente.id, nombre: plan.cliente.nombre } : null,
        ascensor: plan?.ascensor || null,
        tipo_servicio: plan?.tipo_servicio || null,
        precio: precioCfg ? Number(precioCfg.precio) : null,
        moneda: precioCfg?.moneda || 'PEN',
        titulo: e.titulo,
        tipo_plan: plan?.tipo_plan || null,
        frecuencia: plan?.frecuencia || null
      };
    });

    // Sanitizar precios para roles sin acceso financiero.
    const sanit = ROLES_PRECIO.includes(req.user.rol_codigo)
      ? data
      : data.map(d => ({ ...d, precio: null }));
    res.json({ data: sanit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en reporte mantenimientos programados sin servicio' });
  }
};

module.exports = {
  operativos, cobros, tecnicos, leads, ascensores,
  mantenimientosVencidos, moraPorCliente, facturados, abonosRegistrados,
  emergenciasAtendidas, mantenimientosCumplidos, serviciosFinalizados,
  pendientesDeCobro, cobrosVencidos, historialTecnicoAscensor,
  mantenimientosPorCliente, mantenimientosProgramadosSinServicio,
  ingresosPorBanco, correctivos, atencionesRapidas
};

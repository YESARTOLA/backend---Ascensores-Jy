const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { cambiarEstadoServicio, estadoServicioDesdeCobro, estaServicioFinalizado } = require('../utils/estadoServicio');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima, parseYMDFinDiaLima } = require('../utils/tiempo');
const { descartarAlertaFacturarServicio } = require('../utils/recordatoriosAuto');
const {
  ESTADO_FACTURA_EMITIDA,
  ESTADO_FACTURA_ANULADA,
  ESTADOS_FACTURA,
  esEstadoFacturaValido,
  esFacturado,
  calcularEstadoFacturacion
} = require('../utils/estadoFactura');
const { bajaArchivoEnTx, purgarObjetosWasabi } = require('../utils/reversionEliminacion');
const { elegibilidadContable } = require('../utils/elegibilidadContable');
const { porServicioOPlanAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');

const listar = async (req, res) => {
  try {
    const { id_cliente, id_servicio, q, estado_factura, cobertura, desde, hasta } = req.query;
    const where = { estado: 1 };
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_servicio) where.id_servicio = Number(id_servicio);
    if (estado_factura) where.estado_factura = estado_factura;
    // Cobertura: 'general' = factura por todo el servicio (sin cuota);
    // 'cuota' = factura ligada a una cuota específica del plan.
    if (cobertura === 'general') where.id_cuota = null;
    else if (cobertura === 'cuota') where.id_cuota = { not: null };
    if (desde || hasta) {
      where.fecha_emision = {};
      if (desde) where.fecha_emision.gte = parseYMDLima(desde);
      if (hasta) where.fecha_emision.lte = parseYMDFinDiaLima(hasta);
    }
    if (q) where.OR = [
      { numero_factura: { contains: q, mode: 'insensitive' } },
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      { servicio: { codigo: { contains: q, mode: 'insensitive' } } }
    ];

    // Orden configurable por columna (whitelist para evitar inyección). El
    // correlativo refleja el orden de creación (id), por eso "correlativo" mapea
    // a id. Por defecto: id ascendente (el correlativo 1 queda arriba).
    const { sort, dir } = req.query;
    const direccion = dir === 'desc' ? 'desc' : 'asc';
    const ORDEN = {
      correlativo: { id: direccion },
      numero_factura: { numero_factura: direccion },
      cliente: { cliente: { nombre: direccion } },
      servicio: { servicio: { codigo: direccion } },
      fecha_emision: { fecha_emision: direccion },
      monto: { monto: direccion },
      cobertura: { id_cuota: direccion },
      estado_factura: { estado_factura: direccion }
    };
    const orderBy = ORDEN[sort] || { id: 'asc' };
    // Alcance por tipo de edificio (Administrador): factura de servicio o de plan.
    conAlcance(where, porServicioOPlanAscensorEdificioWhere(req.user));

    const result = await paginar(
      prisma.tbl_facturas,
      { where, orderBy, include: { cliente: true, servicio: true, mantenimiento_plan: { include: { tipo_servicio: true } }, archivo: true, cobro: true, cuota: true } },
      req.query
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar facturas' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const f = await prisma.tbl_facturas.findUnique({
      where: { id }, include: { cliente: true, servicio: true, mantenimiento_plan: { include: { tipo_servicio: true } }, archivo: true, cobro: true, cuota: true }
    });
    if (!f) return res.status(404).json({ error: 'No encontrada' });
    res.json({ data: f });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener factura' });
  }
};

/**
 * Recalcula el estado_facturacion agregado del servicio en base a sus
 * facturas y cuotas activas (centralizado en utils/estadoFactura.js).
 * Se llama desde crear() y desde cambiarEstado() para que el cambio en una
 * factura quede reflejado inmediatamente en Contabilidad / Reportes / Dashboard.
 */
async function recomputarEstadoFacturacionServicio(idServicio, idUsuario) {
  const facturas = await prisma.tbl_facturas.findMany({
    where: { id_servicio: idServicio, estado: 1 }
  });
  const cobro = await prisma.tbl_cobros.findUnique({
    where: { id_servicio: idServicio },
    include: { cuotas: { where: { estado: 1 } } }
  });
  const estadoFacturacion = calcularEstadoFacturacion({
    facturas,
    cuotas: cobro?.cuotas || []
  });
  await prisma.tbl_servicios_realizados.updateMany({
    where: { id_servicio: idServicio },
    data: {
      estado_facturacion: estadoFacturacion,
      user_id_modification: idUsuario,
      date_time_modification: new Date()
    }
  });
  return estadoFacturacion;
}

/**
 * Crea una factura para el cobro ÚNICO de un plan de mantenimiento (sin servicio).
 * El plan se factura una sola vez por el total; admite factura general o por cuota,
 * con las mismas reglas de exclusividad que las facturas por servicio.
 */
async function _crearFacturaPlan(req, res, d) {
  const idPlan = Number(d.id_mantenimiento_plan);
  const plan = await prisma.tbl_mantenimientos_planes.findUnique({
    where: { id: idPlan }, include: { cobro: true }
  });
  if (!plan || plan.estado === 0) return res.status(400).json({ error: 'Plan de mantenimiento no existe' });
  const cobro = plan.cobro && plan.cobro.estado === 1 ? plan.cobro : null;
  if (!cobro) return res.status(400).json({ error: 'El plan no tiene cobro activo para facturar' });

  const idCuota = d.id_cuota ? Number(d.id_cuota) : null;
  const facturasExistentes = await prisma.tbl_facturas.findMany({
    where: { id_mantenimiento_plan: idPlan, estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA } }
  });
  const hayGeneral = facturasExistentes.some(f => f.id_cuota === null);
  const hayPorCuota = facturasExistentes.some(f => f.id_cuota !== null);

  if (idCuota === null) {
    if (hayPorCuota) return res.status(400).json({ error: 'Este plan ya tiene facturas por cuota. No se puede emitir una factura general además.' });
    if (hayGeneral) return res.status(400).json({ error: 'Este plan ya tiene una factura general emitida.' });
    const totalCobrable = Number(cobro.monto_total || 0);
    if (totalCobrable > 0 && Number(d.monto) - totalCobrable > 0.01) {
      return res.status(400).json({ error: `El monto de la factura (S/ ${Number(d.monto).toFixed(2)}) excede el total del plan (S/ ${totalCobrable.toFixed(2)}).` });
    }
  } else {
    if (hayGeneral) return res.status(400).json({ error: 'Este plan ya tiene una factura general. No se puede emitir factura por cuota además.' });
    const cuota = await prisma.tbl_cobros_cuotas.findUnique({ where: { id: idCuota } });
    if (!cuota) return res.status(400).json({ error: 'Cuota no existe' });
    if (cuota.id_cobro !== cobro.id) return res.status(400).json({ error: 'La cuota no pertenece a este plan' });
    const yaFacturada = facturasExistentes.find(f => f.id_cuota === idCuota);
    if (yaFacturada) return res.status(400).json({ error: `La cuota N° ${cuota.numero_cuota} ya tiene factura (${yaFacturada.numero_factura})` });
    if (Math.abs(Number(d.monto) - Number(cuota.monto)) > 0.01) {
      return res.status(400).json({ error: `El monto de la factura (S/ ${Number(d.monto).toFixed(2)}) debe igualar el monto de la cuota N° ${cuota.numero_cuota} (S/ ${Number(cuota.monto).toFixed(2)})` });
    }
  }

  const estadoFacturaInicial = d.estado_factura && esEstadoFacturaValido(d.estado_factura)
    ? d.estado_factura : ESTADO_FACTURA_EMITIDA;
  const factura = await prisma.tbl_facturas.create({
    data: {
      id_servicio: null,
      id_mantenimiento_plan: idPlan,
      id_cobro: cobro.id,
      id_cuota: idCuota,
      id_cliente: plan.id_cliente,
      numero_factura: d.numero_factura,
      fecha_emision: parseYMDLima(d.fecha_emision),
      monto: d.monto,
      id_archivo: d.id_archivo || null,
      estado_factura: estadoFacturaInicial,
      registrado_por: req.user.id,
      user_id_registration: req.user.id
    }
  });
  await registrarAuditoria({
    id_usuario: req.user.id, entidad: 'tbl_facturas', id_entidad: factura.id, accion: 'CREATE', valor_nuevo: factura, ip: req.ip
  });
  return res.status(201).json({ data: factura });
}

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.numero_factura || !d.fecha_emision) {
      return res.status(400).json({ error: 'Número y fecha son obligatorios' });
    }
    if (d.monto === undefined || d.monto === null || d.monto === '') {
      return res.status(400).json({ error: 'Monto obligatorio' });
    }
    if (Number(d.monto) < 0) {
      return res.status(400).json({ error: 'Monto no puede ser negativo' });
    }
    // Factura de plan de mantenimiento (cobro único del plan, sin servicio).
    if (d.id_mantenimiento_plan) {
      return await _crearFacturaPlan(req, res, d);
    }
    if (!d.id_servicio) {
      return res.status(400).json({ error: 'Servicio (o plan de mantenimiento) es obligatorio' });
    }
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: Number(d.id_servicio) }, include: { cobro: true, servicio_realizado: true }
    });
    if (!servicio) return res.status(400).json({ error: 'Servicio no existe' });
    // Regla ÚNICA de elegibilidad contable (utils/elegibilidadContable):
    //  - Origen cotización → habilitado por conversión efectiva a servicio.
    //  - Operativo → requiere aprobación administrativa (estado 'Revisado').
    const elegibilidad = elegibilidadContable({ servicio, servicioRealizado: servicio.servicio_realizado });
    if (!elegibilidad.habilitado) {
      return res.status(400).json({ error: elegibilidad.motivo || 'El servicio no está habilitado para facturación' });
    }
    // Bandera persistida "requiere factura": si el servicio está marcado como
    // "Sin factura" (requiere_factura = 0), no admite emisión de comprobante.
    if (servicio.requiere_factura === 0) {
      return res.status(400).json({ error: 'El servicio está marcado como "Sin factura"; no admite emisión de comprobantes.' });
    }

    // Modo: general (id_cuota null) vs por-cuota (id_cuota set).
    // Mutuamente excluyentes a nivel servicio.
    const idCuota = d.id_cuota ? Number(d.id_cuota) : null;
    const facturasExistentes = await prisma.tbl_facturas.findMany({
      where: { id_servicio: Number(d.id_servicio), estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA } }
    });
    const hayGeneral = facturasExistentes.some(f => f.id_cuota === null);
    const hayPorCuota = facturasExistentes.some(f => f.id_cuota !== null);

    if (idCuota === null) {
      // Quiere crear factura general
      if (hayPorCuota) {
        return res.status(400).json({ error: 'Este servicio ya tiene facturas por cuota. No se puede emitir una factura general además.' });
      }
      if (hayGeneral) {
        return res.status(400).json({ error: 'Este servicio ya tiene una factura general emitida.' });
      }
      // No exceder el monto del servicio: la factura general no puede superar el
      // total cobrable (monto del cobro o, en su defecto, el precio del servicio).
      const totalCobrable = Number(servicio.cobro?.monto_total ?? servicio.precio_interno ?? 0);
      if (totalCobrable > 0 && Number(d.monto) - totalCobrable > 0.01) {
        return res.status(400).json({
          error: `El monto de la factura (S/ ${Number(d.monto).toFixed(2)}) excede el total del servicio (S/ ${totalCobrable.toFixed(2)}).`
        });
      }
    } else {
      // Quiere crear factura por cuota
      if (hayGeneral) {
        return res.status(400).json({ error: 'Este servicio ya tiene una factura general. No se puede emitir factura por cuota además.' });
      }
      const cuota = await prisma.tbl_cobros_cuotas.findUnique({ where: { id: idCuota } });
      if (!cuota) return res.status(400).json({ error: 'Cuota no existe' });
      if (servicio.cobro && cuota.id_cobro !== servicio.cobro.id) {
        return res.status(400).json({ error: 'La cuota no pertenece a este servicio' });
      }
      const yaFacturada = facturasExistentes.find(f => f.id_cuota === idCuota);
      if (yaFacturada) {
        return res.status(400).json({ error: `La cuota N° ${cuota.numero_cuota} ya tiene factura (${yaFacturada.numero_factura})` });
      }
      // Monto debe igualar el monto de la cuota (no editable)
      if (Math.abs(Number(d.monto) - Number(cuota.monto)) > 0.01) {
        return res.status(400).json({
          error: `El monto de la factura (S/ ${Number(d.monto).toFixed(2)}) debe igualar el monto de la cuota N° ${cuota.numero_cuota} (S/ ${Number(cuota.monto).toFixed(2)})`
        });
      }
    }

    const estadoFacturaInicial = d.estado_factura && esEstadoFacturaValido(d.estado_factura)
      ? d.estado_factura
      : ESTADO_FACTURA_EMITIDA;

    const factura = await prisma.tbl_facturas.create({
      data: {
        id_servicio: Number(d.id_servicio),
        id_cobro: servicio.cobro?.id || null,
        id_cuota: idCuota,
        id_cliente: servicio.id_cliente,
        numero_factura: d.numero_factura,
        fecha_emision: parseYMDLima(d.fecha_emision),
        monto: d.monto,
        id_archivo: d.id_archivo || null,
        estado_factura: estadoFacturaInicial,
        registrado_por: req.user.id,
        user_id_registration: req.user.id
      }
    });

    // Recalcular estado_facturacion agregado vía helper centralizado.
    const estadoFacturacion = await recomputarEstadoFacturacionServicio(
      Number(d.id_servicio),
      req.user.id
    );

    // Transición de estado de servicio: solo si el servicio ya está en
    // post-ejecución. Si la factura se emitió contra el adelanto antes que
    // el técnico finalice, el servicio mantiene su flujo operativo.
    if (estaServicioFinalizado(servicio.estado_servicio)) {
      const cobro = servicio.cobro;
      const nuevoEstadoServ = estadoServicioDesdeCobro({
        estado_cobro: cobro?.estado_cobro,
        total_abonado: cobro?.total_abonado,
        saldo_pendiente: cobro?.saldo_pendiente,
        facturado: esFacturado(estadoFacturacion)
      });
      await cambiarEstadoServicio(Number(d.id_servicio), nuevoEstadoServ, req.user.id, `Factura ${d.numero_factura} adjunta`);
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_facturas', id_entidad: factura.id, accion: 'CREATE', valor_nuevo: factura, ip: req.ip
    });

    // Auto-cierre de la alerta "facturar servicio" para contabilidad — la
    // acción ya se cumplió. Las alertas "revisar" (coordinador) y "aviso"
    // (admin) siguen siendo cierre manual.
    descartarAlertaFacturarServicio(Number(d.id_servicio)).catch(err =>
      console.error('Descartar alerta facturar:', err));

    res.status(201).json({ data: factura });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear factura: ' + err.message });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado_factura } = req.body;
    if (!esEstadoFacturaValido(estado_factura)) {
      return res.status(400).json({ error: `Estado inválido. Permitidos: ${ESTADOS_FACTURA.join(', ')}` });
    }
    const previo = await prisma.tbl_facturas.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Factura no encontrada' });
    const f = await prisma.tbl_facturas.update({
      where: { id },
      data: { estado_factura, user_id_modification: req.user.id, date_time_modification: new Date() }
    });

    // Facturas de servicio: recalcular estado_facturacion agregado y sincronizar
    // el estado contable del servicio. Las facturas de PLAN no tienen servicio.
    if (previo.id_servicio) {
      const estadoFacturacion = await recomputarEstadoFacturacionServicio(
        previo.id_servicio,
        req.user.id
      );
      const servicio = await prisma.tbl_servicios_proyectos.findUnique({
        where: { id: previo.id_servicio }, include: { cobro: true }
      });
      if (servicio && estaServicioFinalizado(servicio.estado_servicio)) {
        const cobro = servicio.cobro;
        const nuevoEstadoServ = estadoServicioDesdeCobro({
          estado_cobro: cobro?.estado_cobro,
          total_abonado: cobro?.total_abonado,
          saldo_pendiente: cobro?.saldo_pendiente,
          facturado: esFacturado(estadoFacturacion)
        });
        await cambiarEstadoServicio(
          previo.id_servicio,
          nuevoEstadoServ,
          req.user.id,
          `Factura ${previo.numero_factura} pasó a ${estado_factura}`
        );
      }
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_facturas', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado_factura }, valor_nuevo: { estado: estado_factura }, ip: req.ip
    });
    res.json({ data: f });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

/**
 * Soft-delete de una factura (estado = 0). Solo Super Admin. Da de baja el PDF
 * en Wasabi, recalcula el estado_facturacion agregado del servicio (puede
 * volver a "Sin factura") y retransiciona el estado del servicio si ya está en
 * post-ejecución. Se permite borrar incluso facturas "Enviada" (override SA
 * para corregir errores de emisión); queda auditado y es recuperable.
 */
const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await prisma.tbl_facturas.findUnique({ where: { id } });
    if (!previo || previo.estado === 0) return res.status(404).json({ error: 'Factura no encontrada' });

    const idServicio = previo.id_servicio;
    const wasabiKeys = [];
    await prisma.$transaction(async (tx) => {
      await tx.tbl_facturas.update({
        where: { id },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      const key = await bajaArchivoEnTx(tx, previo.id_archivo, req.user.id);
      if (key) wasabiKeys.push(key);
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_facturas', id_entidad: id,
        accion: 'DELETE', valor_anterior: previo, ip: req.ip
      });
    });

    await purgarObjetosWasabi(wasabiKeys);

    // Facturas de servicio: recalcular estado_facturacion y resincronizar estado.
    // Las facturas de PLAN no tienen servicio que recalcular.
    if (idServicio) {
      const estadoFacturacion = await recomputarEstadoFacturacionServicio(idServicio, req.user.id);
      const servicio = await prisma.tbl_servicios_proyectos.findUnique({
        where: { id: idServicio }, include: { cobro: true }
      });
      if (servicio && estaServicioFinalizado(servicio.estado_servicio)) {
        const cobro = servicio.cobro;
        const nuevoEstadoServ = estadoServicioDesdeCobro({
          estado_cobro: cobro?.estado_cobro,
          total_abonado: cobro?.total_abonado,
          saldo_pendiente: cobro?.saldo_pendiente,
          facturado: esFacturado(estadoFacturacion)
        });
        await cambiarEstadoServicio(idServicio, nuevoEstadoServ, req.user.id, `Factura ${previo.numero_factura} eliminada`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar factura: ' + err.message });
  }
};

module.exports = { listar, obtener, crear, cambiarEstado, eliminar };

const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { cambiarEstadoServicio, estadoServicioDesdeCobro, estaServicioFinalizado } = require('../utils/estadoServicio');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima } = require('../utils/tiempo');
const { descartarAlertaFacturarServicio } = require('../utils/recordatoriosAuto');

const listar = async (req, res) => {
  try {
    const { id_cliente, id_servicio } = req.query;
    const where = { estado: 1 };
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_servicio) where.id_servicio = Number(id_servicio);
    const result = await paginar(
      prisma.tbl_facturas,
      { where, orderBy: { id: 'desc' }, include: { cliente: true, servicio: true, archivo: true, cobro: true, cuota: true } },
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
      where: { id }, include: { cliente: true, servicio: true, archivo: true, cobro: true, cuota: true }
    });
    if (!f) return res.status(404).json({ error: 'No encontrada' });
    res.json({ data: f });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener factura' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_servicio || !d.numero_factura || !d.fecha_emision) {
      return res.status(400).json({ error: 'Servicio, número y fecha son obligatorios' });
    }
    if (d.monto === undefined || d.monto === null || d.monto === '') {
      return res.status(400).json({ error: 'Monto obligatorio' });
    }
    if (Number(d.monto) < 0) {
      return res.status(400).json({ error: 'Monto no puede ser negativo' });
    }
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: Number(d.id_servicio) }, include: { cobro: true }
    });
    if (!servicio) return res.status(400).json({ error: 'Servicio no existe' });
    // Para servicios derivados de cotización aprobada el cobro nace al aprobar:
    // se permite facturar el adelanto antes de la ejecución del servicio. Para
    // los demás se mantiene la regla "servicio debe estar finalizado".
    const provieneDeCotizacion = !!servicio.id_cotizacion;
    if (!estaServicioFinalizado(servicio.estado_servicio) && !provieneDeCotizacion) {
      return res.status(400).json({ error: 'Servicio debe estar finalizado' });
    }

    // Modo: general (id_cuota null) vs por-cuota (id_cuota set).
    // Mutuamente excluyentes a nivel servicio.
    const idCuota = d.id_cuota ? Number(d.id_cuota) : null;
    const facturasExistentes = await prisma.tbl_facturas.findMany({
      where: { id_servicio: Number(d.id_servicio), estado: 1, estado_factura: { not: 'Anulada' } }
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
        estado_factura: d.estado_factura || 'Emitida',
        registrado_por: req.user.id,
        user_id_registration: req.user.id
      }
    });
    // Estado de facturación: en modo general una sola factura cubre todo el servicio
    // (Facturado). En modo por-cuota se considera Facturado solo cuando todas las
    // cuotas activas tienen una factura no anulada.
    let estadoFacturacion = 'Facturado';
    if (idCuota !== null && servicio.cobro) {
      const cuotasActivas = await prisma.tbl_cobros_cuotas.findMany({
        where: { id_cobro: servicio.cobro.id, estado: 1 }
      });
      const facturasPorCuota = await prisma.tbl_facturas.findMany({
        where: { id_servicio: Number(d.id_servicio), estado: 1, estado_factura: { not: 'Anulada' }, id_cuota: { not: null } }
      });
      const cuotasFacturadas = new Set(facturasPorCuota.map(f => f.id_cuota));
      const todasFacturadas = cuotasActivas.length > 0 && cuotasActivas.every(c => cuotasFacturadas.has(c.id));
      estadoFacturacion = todasFacturadas ? 'Facturado' : 'Parcialmente facturado';
    }

    await prisma.tbl_servicios_realizados.updateMany({
      where: { id_servicio: Number(d.id_servicio) },
      data: { estado_facturacion: estadoFacturacion, user_id_modification: req.user.id, date_time_modification: new Date() }
    });

    // Transición de estado de servicio: solo si el servicio ya está en
    // post-ejecución. Si la factura se emitió contra el adelanto antes que
    // el técnico finalice, el servicio mantiene su flujo operativo.
    if (estaServicioFinalizado(servicio.estado_servicio)) {
      const cobro = servicio.cobro;
      const nuevoEstadoServ = estadoServicioDesdeCobro({
        estado_cobro: cobro?.estado_cobro,
        total_abonado: cobro?.total_abonado,
        saldo_pendiente: cobro?.saldo_pendiente,
        facturado: estadoFacturacion === 'Facturado'
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
    const validos = ['Sin factura', 'Pendiente de emitir', 'Emitida', 'Adjunta', 'Observada', 'Anulada'];
    if (!validos.includes(estado_factura)) return res.status(400).json({ error: 'Estado inválido' });
    const previo = await prisma.tbl_facturas.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Factura no encontrada' });
    const f = await prisma.tbl_facturas.update({
      where: { id },
      data: { estado_factura, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    // Si se anula, marcar servicio realizado como sin factura
    if (estado_factura === 'Anulada') {
      await prisma.tbl_servicios_realizados.updateMany({
        where: { id_servicio: previo.id_servicio },
        data: { estado_facturacion: 'Sin factura', user_id_modification: req.user.id, date_time_modification: new Date() }
      });
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

module.exports = { listar, obtener, crear, cambiarEstado };

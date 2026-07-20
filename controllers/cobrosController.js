const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { cambiarEstadoServicio, estadoServicioDesdeCobro, estaServicioFinalizado } = require('../utils/estadoServicio');
const { diffDiasLima, parseYMDLima, parseYMDFinDiaLima, inicioDelDiaLima } = require('../utils/tiempo');
const { sincronizarRecordatorioCobro } = require('../utils/recordatoriosAuto');
const { paginarArray } = require('../utils/paginacion');
const { METODOS_PAGO, METODOS_PAGO_CODIGOS, METODOS_REQUIEREN_CUENTA } = require('../utils/catalogosBancarios');
const { ESTADO_FACTURACION_SIN } = require('../utils/estadoFactura');
const { bajaArchivoEnTx, purgarObjetosWasabi } = require('../utils/reversionEliminacion');
const { elegibilidadContable } = require('../utils/elegibilidadContable');
const { porServicioOPlanAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');

const ETIQUETA_POR_METODO = Object.fromEntries(METODOS_PAGO.map(m => [m.codigo, m.etiqueta]));

const diffDays = (d1, d2) => diffDiasLima(d1, d2);

// Los montos se almacenan en Decimal(12,2); convertir a centavos (enteros)
// evita residuos de IEEE 754 al sumar/restar cuotas y abonos, que provocaban
// que un cobro totalmente pagado quedara como "Parcialmente pagado" (saldo
// computado como 0.0000000001 en vez de 0 exacto).
const aCentavos = (n) => Math.round(Number(n || 0) * 100);
const aSoles = (c) => Number((c / 100).toFixed(2));

function calcularMetricas(cobro) {
  const ahora = new Date();
  let dias_proximo = null, dias_mora = 0, vencido = false;
  if (cobro.fecha_proximo_abono && Number(cobro.saldo_pendiente) > 0) {
    dias_proximo = diffDays(cobro.fecha_proximo_abono, ahora);
    if (dias_proximo < 0) {
      dias_mora = Math.abs(dias_proximo);
      vencido = true;
      dias_proximo = 0;
    }
  }
  return { ...cobro, dias_proximo, dias_mora, vencido, abonos_por_cuenta: agruparAbonosPorCuenta(cobro.pagos) };
}

/**
 * Agrupa los pagos por cuenta bancaria. Los pagos sin cuenta se agrupan
 * por método de pago (Efectivo, Otro, etc.). Suma en centavos para evitar
 * residuos de IEEE 754. Devuelve array ordenado por total descendente.
 */
function agruparAbonosPorCuenta(pagos) {
  if (!Array.isArray(pagos) || pagos.length === 0) return [];
  const grupos = new Map();
  for (const p of pagos) {
    let key, label;
    if (p.id_cuenta_bancaria && p.cuenta_bancaria) {
      key = `c:${p.id_cuenta_bancaria}`;
      label = p.cuenta_bancaria.nombre;
    } else {
      const metodo = p.metodo_pago || 'Otro';
      key = `m:${metodo}`;
      label = ETIQUETA_POR_METODO[metodo] || metodo;
    }
    const actual = grupos.get(key) || { key, label, id_cuenta_bancaria: p.id_cuenta_bancaria || null, metodo_pago: p.id_cuenta_bancaria ? null : p.metodo_pago, total_cents: 0 };
    actual.total_cents += aCentavos(p.monto);
    grupos.set(key, actual);
  }
  return Array.from(grupos.values())
    .map(g => ({ key: g.key, label: g.label, id_cuenta_bancaria: g.id_cuenta_bancaria, metodo_pago: g.metodo_pago, total: aSoles(g.total_cents) }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Ordena el array de cobros (ya con métricas calculadas) por la columna pedida.
 * Las columnas que pueden ser null se relegan al final independientemente de la
 * dirección, para que el usuario nunca pierda los registros con dato faltante
 * arriba de la lista. El criterio del campo "servicio" es el código completo
 * (SRV-YYYY-NNNNNN); como el correlativo está zero-padded, la comparación
 * lexicográfica refleja el orden correlativo dentro del mismo año.
 */
function ordenarCobros(arr, orden, direccion) {
  const dir = direccion === 'desc' ? -1 : 1;
  const getters = {
    cliente: c => (c.cliente?.nombre || '').toLowerCase(),
    proyecto: c => (c.servicio?.titulo || '').toLowerCase(),
    servicio: c => c.servicio?.codigo || '',
    ot: c => c.servicio?.servicio_realizado?.numero_ot || '',
    precio: c => Number(c.monto_total || 0),
    abonos: c => Number(c.total_abonado || 0),
    cuotas: c => Number(c.cuotas_pagadas || 0),
    saldo: c => Number(c.saldo_pendiente || 0),
    proximo: c => c.fecha_proximo_abono ? new Date(c.fecha_proximo_abono).getTime() : null,
    mora: c => Number(c.dias_mora || 0),
    estado: c => c.estado_cobro || ''
  };
  const getter = getters[orden];
  if (!getter) return arr;
  const vacio = v => v === null || v === undefined || v === '';
  return arr.slice().sort((a, b) => {
    const va = getter(a);
    const vb = getter(b);
    const aVacio = vacio(va);
    const bVacio = vacio(vb);
    if (aVacio && bVacio) return 0;
    if (aVacio) return 1;
    if (bVacio) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

/**
 * Persiste el estado real del cobro (Vencido / En mora) cuando aplica.
 * Solo modifica si el estado base permite la transición (no toca Pagado/Cerrado/Incobrable).
 */
async function persistirEstadoMora(cobro) {
  if (!cobro || !cobro.fecha_proximo_abono) return cobro;
  if (['Pagado', 'Cerrado', 'Incobrable', 'Sin cobro'].includes(cobro.estado_cobro)) return cobro;
  if (Number(cobro.saldo_pendiente) <= 0) return cobro;
  const ahora = new Date();
  const dias = diffDays(cobro.fecha_proximo_abono, ahora);
  let nuevoEstado = cobro.estado_cobro;
  if (dias < 0 && Math.abs(dias) >= 30) nuevoEstado = 'En mora';
  else if (dias < 0) nuevoEstado = 'Vencido';
  if (nuevoEstado !== cobro.estado_cobro) {
    await prisma.tbl_cobros.update({ where: { id: cobro.id }, data: { estado_cobro: nuevoEstado } });
    cobro.estado_cobro = nuevoEstado;
  }
  return cobro;
}

const listar = async (req, res) => {
  try {
    const {
      q, estado_cobro, vencidos, en_mora, pagados, pendientes,
      id_cliente, id_tecnico, id_tipo_servicio, id_proyecto,
      fecha_proximo_desde, fecha_proximo_hasta,
      orden, direccion
    } = req.query;

    const where = { estado: 1 };
    if (estado_cobro) where.estado_cobro = estado_cobro;
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_proyecto) where.id_servicio = Number(id_proyecto);
    if (fecha_proximo_desde || fecha_proximo_hasta) {
      where.fecha_proximo_abono = {};
      if (fecha_proximo_desde) where.fecha_proximo_abono.gte = parseYMDLima(fecha_proximo_desde);
      if (fecha_proximo_hasta) where.fecha_proximo_abono.lte = parseYMDFinDiaLima(fecha_proximo_hasta);
    }

    const filtroServicio = {};
    if (id_tipo_servicio) filtroServicio.id_tipo_servicio = Number(id_tipo_servicio);
    if (id_tecnico) filtroServicio.asignaciones = { some: { id_tecnico: Number(id_tecnico), estado: 1 } };
    if (Object.keys(filtroServicio).length > 0) where.servicio = filtroServicio;
    // Alcance por tipo de edificio (Administrador): el cobro cuelga de un servicio
    // o de un plan de mantenimiento; se muestra si llega a un tipo permitido.
    conAlcance(where, porServicioOPlanAscensorEdificioWhere(req.user));

    const cobros = await prisma.tbl_cobros.findMany({
      where,
      orderBy: { id: 'desc' },
      include: {
        cliente: true,
        servicio: {
          include: {
            tipo_servicio: true,
            cotizacion: { select: { id: true, codigo: true } },
            ascensores: { where: { estado: 1 }, include: { ascensor: true } },
            asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
            servicio_realizado: { include: { archivo_ot: true } }
          }
        },
        // Cobro de plan de mantenimiento (sin servicio): se muestra con el plan,
        // su tipo de servicio y los ascensores que cubre.
        mantenimiento_plan: {
          include: {
            tipo_servicio: true,
            ascensores: { where: { estado: 1 }, include: { ascensor: true } }
          }
        },
        pagos: { where: { estado: 1 }, include: { cuenta_bancaria: true }, orderBy: { id: 'desc' } },
        cuotas: { where: { estado: 1 } },
        facturas: true
      }
    });
    // Persistir mora antes de calcular
    for (const c of cobros) await persistirEstadoMora(c);
    let data = cobros.map(calcularMetricas);

    if (q) {
      const ql = q.toLowerCase();
      data = data.filter(c =>
        c.cliente?.nombre?.toLowerCase().includes(ql) ||
        c.servicio?.codigo?.toLowerCase().includes(ql) ||
        c.servicio?.titulo?.toLowerCase().includes(ql)
      );
    }
    if (vencidos === '1') data = data.filter(c => c.vencido);
    if (en_mora === '1') data = data.filter(c => c.dias_mora > 0);
    if (pagados === '1') data = data.filter(c => Number(c.saldo_pendiente) === 0);
    if (pendientes === '1') data = data.filter(c => Number(c.saldo_pendiente) > 0);

    if (orden) data = ordenarCobros(data, orden, direccion);

    res.json(paginarArray(data, req.query));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar cobros' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cobro = await prisma.tbl_cobros.findUnique({
      where: { id },
      include: {
        cliente: true,
        servicio: { include: { tipo_servicio: true, ascensores: { where: { estado: 1 }, include: { ascensor: true } } } },
        mantenimiento_plan: {
          include: {
            tipo_servicio: true,
            ascensores: { where: { estado: 1 }, include: { ascensor: true } }
          }
        },
        pagos: { where: { estado: 1 }, include: { archivo: true, cuenta_bancaria: true }, orderBy: { id: 'desc' } },
        cuotas: { where: { estado: 1 }, orderBy: { numero_cuota: 'asc' }, include: { facturas: { where: { estado: 1 } } } },
        recordatorios: { orderBy: { id: 'desc' } },
        facturas: { include: { archivo: true, cuota: true } }
      }
    });
    if (!cobro) return res.status(404).json({ error: 'Cobro no encontrado' });
    await persistirEstadoMora(cobro);

    const aprobacionCotizacion = await obtenerAprobacionCotizacion(cobro.servicio?.id_cotizacion);
    res.json({ data: { ...calcularMetricas(cobro), aprobacion_cotizacion: aprobacionCotizacion } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener cobro' });
  }
};

/**
 * Devuelve los datos de aprobación de la cotización que originó el cobro:
 * observaciones generales y plan_cuotas (con observación por cuota) tal como
 * quedaron al aprobar (o re-aprobar) la versión. Sin cotización, retorna null.
 *
 * Se prefiere la versión Aprobada más reciente. Si no se encontró ninguna
 * Aprobada (caso histórico raro), se cae a la versión activa con mayor número.
 */
async function obtenerAprobacionCotizacion(idCotizacion) {
  if (!idCotizacion) return null;
  const cotizacion = await prisma.tbl_cotizaciones.findUnique({
    where: { id: Number(idCotizacion) },
    select: { codigo: true }
  });
  if (!cotizacion) return null;
  const version = await prisma.tbl_cotizaciones_versiones.findFirst({
    where: { id_cotizacion: Number(idCotizacion), estado: 1, estado_version: 'Aprobado' },
    orderBy: [{ fecha_aprobacion: 'desc' }, { numero_version: 'desc' }],
    select: {
      numero_version: true, observaciones: true, plan_cuotas: true,
      tiene_cuotas: true, fecha_aprobacion: true
    }
  });
  if (!version) return null;
  return {
    codigo_cotizacion: cotizacion.codigo,
    numero_version: version.numero_version,
    fecha_aprobacion: version.fecha_aprobacion,
    observaciones: version.observaciones || null,
    tiene_cuotas: Boolean(version.tiene_cuotas),
    plan_cuotas: Array.isArray(version.plan_cuotas) ? version.plan_cuotas : null
  };
}

/**
 * Actualiza el plan de cuotas de un cobro respetando:
 *
 *  - Inmutabilidad dinámica: las cuotas existentes con pagos parciales/totales
 *    o con factura asociada quedan blindadas. Su monto, fecha y posición no
 *    pueden cambiar y deben enviarse intactas desde el cliente (o no enviarse,
 *    en cuyo caso se conservan).
 *  - Regla de suma según saldo_variable del cobro:
 *      · false (default) → suma de cuotas = monto_total original. Permite
 *        redistribuir cuotas pendientes pero el total no se mueve.
 *      · true → la suma puede ser mayor o menor al monto_total cotizado. El
 *        monto_total del cobro se recalcula y se sincroniza con
 *        precio_interno del servicio para que reportes y dashboard reflejen
 *        lo realmente cobrable.
 *    En ambos casos la suma de cuotas pagadas/facturadas debe respetarse
 *    como piso mínimo (no puede reducirse el total por debajo de lo ya
 *    comprometido).
 */
const actualizarPlanCuotas = async (req, res) => {
  try {
    const id = Number(req.params.id);
    // numero_cuotas se ignora — el total se deriva siempre de cuotas.length.
    const { fecha_proximo_abono, cuotas } = req.body;
    const cobro = await prisma.tbl_cobros.findUnique({
      where: { id },
      include: {
        cuotas: { where: { estado: 1 }, include: { facturas: { where: { estado: 1 } } } }
      }
    });
    if (!cobro) return res.status(404).json({ error: 'Cobro no encontrado' });
    // Un cobro cerrado es inmutable: no se puede reestructurar su plan de cuotas.
    // La UI oculta el botón "Plan de cuotas" en estado Cerrado; este guard cubre
    // el acceso directo a la API.
    if (cobro.estado_cobro === 'Cerrado') {
      return res.status(409).json({ error: 'El cobro está cerrado; no se puede modificar el plan de cuotas' });
    }

    const pagadas = cobro.cuotas_pagadas;
    const cuotasArrIn = Array.isArray(cuotas) ? cuotas : [];

    // Cuotas blindadas: pagadas (parcial o total) o con factura asociada.
    const cuotaBlindada = (c) =>
      Number(c.monto_pagado) > 0 || (Array.isArray(c.facturas) && c.facturas.length > 0);
    const cuotasBlindadas = cobro.cuotas.filter(cuotaBlindada);
    const idsBlindadas = new Set(cuotasBlindadas.map(c => c.id));

    // Las cuotas blindadas deben venir en el payload con su id, mismo monto y
    // misma fecha. Si no vienen, las preservamos automáticamente al final para
    // que un cliente desactualizado no las pierda.
    const cuotasIn = cuotasArrIn.map(c => ({
      id: c.id ? Number(c.id) : null,
      numero_cuota: Number(c.numero_cuota),
      fecha_vencimiento: c.fecha_vencimiento,
      monto: Number(c.monto || 0)
    }));
    const idsEnPayload = new Set(cuotasIn.filter(c => c.id).map(c => c.id));
    for (const blind of cuotasBlindadas) {
      const enviada = cuotasIn.find(c => c.id === blind.id);
      if (!enviada) continue; // Se reincorpora abajo si no viene.
      if (Math.abs(enviada.monto - Number(blind.monto)) > 0.01) {
        return res.status(400).json({
          error: `Cuota ${blind.numero_cuota} está blindada (pagada/facturada) — no se puede cambiar su monto.`
        });
      }
      // Comparar como YYYY-MM-DD. Columnas @db.Date llegan de Prisma como Date
      // a UTC midnight; tomar la porción ISO UTC preserva el día sin desfase
      // por TZ (ymdLima retrocede un día en Lima -05:00).
      const fechaIn = String(enviada.fecha_vencimiento).slice(0, 10);
      const fechaBlind = new Date(blind.fecha_vencimiento).toISOString().slice(0, 10);
      if (fechaIn !== fechaBlind) {
        return res.status(400).json({
          error: `Cuota ${blind.numero_cuota} está blindada (pagada/facturada) — no se puede cambiar su fecha.`
        });
      }
    }
    const blindadasNoEnviadas = cuotasBlindadas.filter(b => !idsEnPayload.has(b.id));
    const cuotasFinales = [
      ...blindadasNoEnviadas.map(b => ({
        id: b.id,
        numero_cuota: b.numero_cuota,
        fecha_vencimiento: b.fecha_vencimiento,
        monto: Number(b.monto)
      })),
      ...cuotasIn
    ];
    // Renumerar al final por orden de vencimiento para evitar huecos.
    cuotasFinales.sort((a, b) => new Date(a.fecha_vencimiento) - new Date(b.fecha_vencimiento));
    cuotasFinales.forEach((c, i) => { c.numero_cuota = i + 1; });

    if (cuotasFinales.length === 0) {
      return res.status(400).json({ error: 'Debe definir al menos una cuota' });
    }
    const sumaCuotas = cuotasFinales.reduce((acc, c) => acc + c.monto, 0);
    const minimoComprometido = cuotasBlindadas.reduce((acc, c) => acc + Number(c.monto), 0);

    if (cobro.saldo_variable) {
      // En modo variable la suma puede subir o bajar, pero nunca por debajo
      // de lo ya comprometido (pagado/facturado).
      if (sumaCuotas < minimoComprometido - 0.01) {
        return res.status(400).json({
          error: `La suma de cuotas (S/ ${sumaCuotas.toFixed(2)}) no puede ser menor a lo ya comprometido (S/ ${minimoComprometido.toFixed(2)})`
        });
      }
    } else {
      const objetivo = Number(cobro.monto_total);
      if (Math.abs(sumaCuotas - objetivo) > 0.01) {
        return res.status(400).json({
          error: `La suma de las cuotas (S/ ${sumaCuotas.toFixed(2)}) debe ser exactamente S/ ${objetivo.toFixed(2)}`
        });
      }
    }

    const nuevoMontoTotal = cobro.saldo_variable
      ? Number(sumaCuotas.toFixed(2))
      : Number(cobro.monto_total);
    const totalAbonado = Number(cobro.total_abonado);
    const nuevoSaldo = Math.max(0, Number((nuevoMontoTotal - totalAbonado).toFixed(2)));
    const totalCuotasReal = cuotasFinales.length;
    const proximaPendiente = cuotasFinales.find(c => {
      const blind = cobro.cuotas.find(x => x.id === c.id);
      return !blind || Number(blind.monto_pagado) < Number(blind.monto);
    });
    // Asegurar Date — las cuotas nuevas traen fecha_vencimiento como string.
    let nuevaFechaProximo = null;
    if (fecha_proximo_abono) {
      nuevaFechaProximo = parseYMDLima(fecha_proximo_abono);
    } else if (proximaPendiente) {
      nuevaFechaProximo = typeof proximaPendiente.fecha_vencimiento === 'string'
        ? parseYMDLima(proximaPendiente.fecha_vencimiento)
        : proximaPendiente.fecha_vencimiento;
    }

    // Reemplazo atómico: borrar las no-blindadas y crear las nuevas. Las
    // blindadas se actualizan in-place para preservar su id y los vínculos
    // con facturas existentes.
    const noBlindadasNuevas = cuotasFinales.filter(c => !idsBlindadas.has(c.id));

    await prisma.$transaction([
      prisma.tbl_cobros_cuotas.deleteMany({
        where: { id_cobro: id, id: { notIn: Array.from(idsBlindadas) } }
      }),
      // Reasignar numero_cuota a blindadas según el nuevo orden global.
      ...cuotasFinales
        .filter(c => idsBlindadas.has(c.id))
        .map(c => prisma.tbl_cobros_cuotas.update({
          where: { id: c.id },
          data: { numero_cuota: c.numero_cuota, user_id_modification: req.user.id, date_time_modification: new Date() }
        })),
      ...noBlindadasNuevas.map(cu =>
        prisma.tbl_cobros_cuotas.create({
          data: {
            id_cobro: id,
            numero_cuota: cu.numero_cuota,
            fecha_vencimiento: typeof cu.fecha_vencimiento === 'string'
              ? parseYMDLima(cu.fecha_vencimiento)
              : cu.fecha_vencimiento,
            monto: cu.monto,
            user_id_registration: req.user.id
          }
        })
      ),
      prisma.tbl_cobros.update({
        where: { id },
        data: {
          monto_total: nuevoMontoTotal,
          saldo_pendiente: nuevoSaldo,
          numero_cuotas: totalCuotasReal,
          cuotas_faltantes: Math.max(0, totalCuotasReal - pagadas),
          fecha_proximo_abono: nuevaFechaProximo,
          estado_cobro: cobro.estado_cobro === 'Pendiente de iniciar' ? 'En gestión' : cobro.estado_cobro,
          user_id_modification: req.user.id, date_time_modification: new Date()
        }
      }),
      // Sincroniza precio_interno del servicio solo si el cobro es variable y
      // el monto cambió. Mantiene la regla "el cobro manda" para reportes y
      // dashboard.
      ...(cobro.saldo_variable && Math.abs(nuevoMontoTotal - Number(cobro.monto_total)) > 0.01
        ? [prisma.tbl_servicios_proyectos.update({
            where: { id: cobro.id_servicio },
            data: { precio_interno: nuevoMontoTotal, user_id_modification: req.user.id, date_time_modification: new Date() }
          })]
        : [])
    ]);
    sincronizarRecordatorioCobro(id).catch(err => console.error('Sync rec cobro:', err));

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar plan de cuotas: ' + err.message });
  }
};

const registrarPago = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const cobro = await prisma.tbl_cobros.findUnique({
      where: { id }, include: {
        pagos: { where: { estado: 1 } },
        cuotas: { where: { estado: 1 } },
        servicio: { include: { servicio_realizado: true, tipo_servicio: true } }
      }
    });
    if (!cobro) return res.status(404).json({ error: 'Cobro no encontrado' });

    // Cobro de plan de mantenimiento: facturación única del plan, disponible desde
    // que se crea el plan → siempre elegible (no depende de un servicio).
    const esCobroDePlan = !!cobro.id_mantenimiento_plan;
    // Regla ÚNICA de elegibilidad (solo cobros por servicio): no se registran
    // abonos contra servicios aún no habilitados para Contabilidad.
    if (!esCobroDePlan) {
      const elegibilidad = elegibilidadContable({ servicio: cobro.servicio, servicioRealizado: cobro.servicio?.servicio_realizado });
      if (!elegibilidad.habilitado) {
        return res.status(400).json({ error: elegibilidad.motivo || 'El servicio no está habilitado para cobro' });
      }
    }

    // Un correctivo marcado "Con factura" (requiere_factura=1) no admite abonos
    // hasta que exista una factura del servicio (primero facturar, luego cobrar).
    // "Correctivo" se detecta por el módulo del tipo de servicio (cubre también
    // los correctivos originados en una cotización, cuyo origen es 'cotizacion').
    const esCorrectivoCobro = cobro.servicio?.tipo_servicio?.modulo_asociado === 'correctivo'
      || cobro.servicio?.origen === 'correctivo';
    if (esCorrectivoCobro && cobro.servicio?.requiere_factura === 1) {
      const facturaExistente = await prisma.tbl_facturas.findFirst({ where: { id_servicio: cobro.id_servicio, estado: 1 } });
      if (!facturaExistente) {
        return res.status(400).json({ error: 'Este correctivo requiere factura: agregue una factura al cobro antes de registrar abonos.' });
      }
    }

    const monto = Number(d.monto);
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto debe ser mayor a cero' });

    const montoCents = aCentavos(monto);
    const saldoCents = aCentavos(cobro.saldo_pendiente);
    if (montoCents > saldoCents && req.user.rol_codigo !== 'super_admin') {
      return res.status(400).json({ error: 'El abono excede el saldo. Solo Super Admin puede sobrepasarlo' });
    }

    const metodoPago = String(d.metodo_pago || 'Efectivo');
    if (!METODOS_PAGO_CODIGOS.includes(metodoPago)) {
      return res.status(400).json({ error: `Método de pago inválido. Valores permitidos: ${METODOS_PAGO_CODIGOS.join(', ')}` });
    }

    let idCuentaBancaria = d.id_cuenta_bancaria ? Number(d.id_cuenta_bancaria) : null;
    if (METODOS_REQUIEREN_CUENTA.includes(metodoPago)) {
      if (!idCuentaBancaria) {
        return res.status(400).json({ error: `El método "${metodoPago}" requiere seleccionar una cuenta bancaria` });
      }
    }
    if (idCuentaBancaria) {
      const cuenta = await prisma.tbl_cuentas_bancarias.findFirst({
        where: { id: idCuentaBancaria, estado: 1 }
      });
      if (!cuenta) return res.status(400).json({ error: 'Cuenta bancaria no encontrada o inactiva' });
    }

    const numAbono = cobro.pagos.length + 1;
    await prisma.tbl_pagos.create({
      data: {
        id_cobro: id,
        numero_abono: numAbono,
        monto,
        fecha_pago: d.fecha_pago ? parseYMDLima(d.fecha_pago) : inicioDelDiaLima(),
        metodo_pago: metodoPago,
        id_archivo_comprobante: d.id_archivo_comprobante || null,
        id_cuenta_bancaria: idCuentaBancaria,
        observaciones: d.observaciones || null,
        registrado_por: req.user.id,
        user_id_registration: req.user.id
      }
    });

    // Cálculos en centavos para evitar residuos de punto flotante.
    const montoTotalCents = aCentavos(cobro.monto_total);
    const totalAbonadoCents = aCentavos(cobro.total_abonado) + montoCents;
    const nuevoSaldoCents = Math.max(0, montoTotalCents - totalAbonadoCents);
    const totalAbonado = aSoles(totalAbonadoCents);
    const nuevoSaldo = aSoles(nuevoSaldoCents);

    // Aplicar a cuotas FIFO
    let restanteCents = montoCents;
    let cuotasPagadas = cobro.cuotas_pagadas;
    const cuotasOrdenadas = cobro.cuotas.sort((a, b) => a.numero_cuota - b.numero_cuota);
    for (const cu of cuotasOrdenadas) {
      if (restanteCents <= 0) break;
      const cuMontoCents = aCentavos(cu.monto);
      const cuPagadoCents = aCentavos(cu.monto_pagado);
      const faltaCuotaCents = cuMontoCents - cuPagadoCents;
      if (faltaCuotaCents <= 0) continue;
      const aplicarCents = Math.min(restanteCents, faltaCuotaCents);
      const nuevoMontoPagadoCents = cuPagadoCents + aplicarCents;
      const estadoCu = nuevoMontoPagadoCents >= cuMontoCents ? 'Pagada' : 'Parcial';
      const nuevoMontoPagado = aSoles(nuevoMontoPagadoCents);
      await prisma.tbl_cobros_cuotas.update({
        where: { id: cu.id },
        data: {
          monto_pagado: nuevoMontoPagado,
          estado_cuota: estadoCu,
          fecha_pago: estadoCu === 'Pagada' ? inicioDelDiaLima() : cu.fecha_pago,
          user_id_modification: req.user.id, date_time_modification: new Date()
        }
      });
      cu.monto_pagado = nuevoMontoPagado;
      cu.estado_cuota = estadoCu;
      if (estadoCu === 'Pagada') cuotasPagadas++;
      restanteCents -= aplicarCents;
    }

    // Avanzar fecha_proximo_abono al vencimiento de la siguiente cuota pendiente.
    // Si no quedan cuotas pendientes (todo cancelado) se limpia; si no hay plan
    // de cuotas detallado se conserva el valor actual.
    const proximaCuotaPendiente = cuotasOrdenadas.find(c => aCentavos(c.monto_pagado) < aCentavos(c.monto));
    let nuevaFechaProximo;
    if (nuevoSaldoCents === 0) nuevaFechaProximo = null;
    else if (proximaCuotaPendiente) nuevaFechaProximo = proximaCuotaPendiente.fecha_vencimiento;
    else nuevaFechaProximo = cobro.fecha_proximo_abono;

    let nuevoEstado = cobro.estado_cobro;
    if (nuevoSaldoCents === 0) nuevoEstado = 'Pagado';
    else if (totalAbonadoCents > 0) nuevoEstado = 'Parcialmente pagado';
    else nuevoEstado = 'En gestión';

    await prisma.tbl_cobros.update({
      where: { id },
      data: {
        total_abonado: totalAbonado,
        saldo_pendiente: nuevoSaldo,
        cuotas_pagadas: cuotasPagadas,
        cuotas_faltantes: Math.max(0, cobro.numero_cuotas - cuotasPagadas),
        fecha_ultimo_abono: d.fecha_pago ? parseYMDLima(d.fecha_pago) : inicioDelDiaLima(),
        fecha_proximo_abono: nuevaFechaProximo,
        estado_cobro: nuevoEstado,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });

    // Side-effects sobre el servicio: solo para cobros por servicio. Los cobros
    // de plan no tienen servicio asociado (facturación única del plan).
    if (!esCobroDePlan && cobro.id_servicio) {
      // Actualizar estado en servicio realizado
      await prisma.tbl_servicios_realizados.updateMany({
        where: { id_servicio: cobro.id_servicio },
        data: {
          estado_cobro: nuevoEstado,
          user_id_modification: req.user.id, date_time_modification: new Date()
        }
      });

      // Transición del estado del servicio según cobro.
      // Solo aplica si el servicio ya está en post-ejecución (admin/cobro). Si
      // el cobro nació al aprobar la cotización (adelanto pagado antes de
      // ejecutar el servicio), el servicio permanece en su estado operativo y
      // las cuotas siguen su ciclo en paralelo.
      const servicioActual = await prisma.tbl_servicios_proyectos.findUnique({
        where: { id: cobro.id_servicio },
        select: { estado_servicio: true }
      });
      if (estaServicioFinalizado(servicioActual?.estado_servicio)) {
        const facturas = await prisma.tbl_facturas.findFirst({ where: { id_servicio: cobro.id_servicio, estado: 1 } });
        const nuevoEstadoServ = estadoServicioDesdeCobro({
          estado_cobro: nuevoEstado,
          total_abonado: totalAbonado,
          saldo_pendiente: nuevoSaldo,
          facturado: !!facturas
        });
        await cambiarEstadoServicio(cobro.id_servicio, nuevoEstadoServ, req.user.id, `Abono registrado: ${monto}`);
      }
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_pagos', id_entidad: id,
      accion: 'CREATE', valor_nuevo: { monto, saldo: nuevoSaldo }, ip: req.ip
    });
    sincronizarRecordatorioCobro(id).catch(err => console.error('Sync rec cobro:', err));
    res.status(201).json({ ok: true, saldo: nuevoSaldo, estado: nuevoEstado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar abono: ' + err.message });
  }
};

const enviarRecordatorio = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cobro = await prisma.tbl_cobros.findUnique({
      where: { id },
      include: { cliente: true, servicio: true }
    });
    if (!cobro) return res.status(404).json({ error: 'Cobro no encontrado' });
    if (Number(cobro.saldo_pendiente) <= 0) {
      return res.status(400).json({ error: 'Sin saldo pendiente' });
    }
    if (!cobro.cliente.whatsapp && !cobro.cliente.telefono) {
      return res.status(400).json({ error: 'Cliente sin número WhatsApp' });
    }
    const telefono = (cobro.cliente.whatsapp || cobro.cliente.telefono).replace(/\D/g, '');
    const fecha = cobro.fecha_proximo_abono ? new Date(cobro.fecha_proximo_abono).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : 'próxima';
    const mensaje =
`Hola, somos Ascensores Jy. Le recordamos que tiene un saldo pendiente de S/ ${Number(cobro.saldo_pendiente).toFixed(2)} correspondiente al servicio/proyecto ${cobro.servicio.codigo}. La fecha de abono era ${fecha}. Por favor indíquenos cuándo podrá realizar el pago. Gracias.`;

    await prisma.tbl_cobros_recordatorios.create({
      data: {
        id_cobro: id, canal: 'whatsapp', mensaje,
        enviado_por: req.user.id,
        user_id_registration: req.user.id
      }
    });

    const url = `https://wa.me/51${telefono}?text=${encodeURIComponent(mensaje)}`;
    res.json({ data: { url, mensaje, telefono } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar recordatorio' });
  }
};

const cerrarCobro = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cobro = await prisma.tbl_cobros.findUnique({ where: { id } });
    if (!cobro) return res.status(404).json({ error: 'Cobro no encontrado' });
    if (Number(cobro.saldo_pendiente) > 0) {
      return res.status(400).json({ error: 'No se puede cerrar con saldo pendiente' });
    }
    await prisma.tbl_cobros.update({
      where: { id }, data: { estado_cobro: 'Cerrado', user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    // Cobro de plan: no hay servicio que transicionar; cerrar el cobro basta.
    if (cobro.id_mantenimiento_plan || !cobro.id_servicio) {
      sincronizarRecordatorioCobro(id).catch(err => console.error('Sync rec cobro:', err));
      return res.json({ ok: true });
    }
    const facturas = await prisma.tbl_facturas.findFirst({ where: { id_servicio: cobro.id_servicio, estado: 1 } });
    // Solo transiciona el estado del servicio si ya está en post-ejecución.
    // Si el cobro se cierra antes de ejecutar (caso atípico, pero posible si
    // monto_total = 0), el servicio mantiene su flujo operativo.
    const servicioActual = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: cobro.id_servicio },
      select: { estado_servicio: true }
    });
    if (estaServicioFinalizado(servicioActual?.estado_servicio)) {
      await cambiarEstadoServicio(cobro.id_servicio, facturas ? 'Cerrado' : 'Cobrado total', req.user.id, 'Cobro cerrado');
    } else {
      // El servicio aún no está en post-ejecución, pero el cobro pasó a
      // Cerrado: recalcular estado_global de la cotización (si la hay) por si
      // ahora corresponde marcarla como Terminada.
      const srv = await prisma.tbl_servicios_proyectos.findUnique({
        where: { id: cobro.id_servicio }, select: { id_cotizacion: true }
      });
      if (srv?.id_cotizacion) {
        const { sincronizarEstadoGlobal } = require('./cotizacionesController');
        sincronizarEstadoGlobal(srv.id_cotizacion).catch(err =>
          console.error('Sync estado_global tras cerrar cobro:', err));
      }
    }
    sincronizarRecordatorioCobro(id).catch(err => console.error('Sync rec cobro:', err));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cerrar cobro' });
  }
};

const marcarIncobrable = async (req, res) => {
  try {
    if (req.user.rol_codigo !== 'super_admin') return res.status(403).json({ error: 'Solo Super Admin puede marcar incobrable' });
    const id = Number(req.params.id);
    const cobro = await prisma.tbl_cobros.findUnique({ where: { id } });
    if (!cobro) return res.status(404).json({ error: 'Cobro no encontrado' });
    const { motivo } = req.body;
    await prisma.tbl_cobros.update({
      where: { id },
      data: {
        estado_cobro: 'Incobrable',
        observaciones: (cobro.observaciones ? cobro.observaciones + '\n' : '') + `[Incobrable] ${motivo || ''}`,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cobros', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_nuevo: { estado: 'Incobrable', motivo }, ip: req.ip
    });
    sincronizarRecordatorioCobro(id).catch(err => console.error('Sync rec cobro:', err));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar incobrable' });
  }
};

/**
 * Devuelve todas las cuotas (activas) cuya fecha_vencimiento cae en [desde, hasta],
 * con info del cobro/cliente/servicio para pintar en el calendario.
 */
const cuotasCalendario = async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const where = { estado: 1 };
    if (desde || hasta) {
      where.fecha_vencimiento = {};
      if (desde) where.fecha_vencimiento.gte = new Date(desde);
      if (hasta) where.fecha_vencimiento.lte = new Date(hasta);
    }
    const cuotas = await prisma.tbl_cobros_cuotas.findMany({
      where,
      orderBy: { fecha_vencimiento: 'asc' },
      include: {
        cobro: {
          include: {
            cliente: true,
            servicio: { select: { id: true, codigo: true, titulo: true } }
          }
        }
      }
    });
    res.json({ data: cuotas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar cuotas para calendario' });
  }
};

/**
 * Devuelve la lista de proyectos (= servicios con cobro activo) para
 * alimentar el combobox de filtros. Solo IDs + datos visibles, sin metricas.
 */
const listarProyectos = async (_req, res) => {
  try {
    const cobros = await prisma.tbl_cobros.findMany({
      where: { estado: 1 },
      orderBy: { id: 'desc' },
      select: {
        servicio: {
          select: {
            id: true,
            codigo: true,
            titulo: true,
            cliente: { select: { id: true, nombre: true } },
            ascensores: { where: { estado: 1 }, select: { id: true } }
          }
        }
      }
    });
    const data = cobros
      .map(c => c.servicio)
      .filter(s => s && s.id)
      .map(s => ({
        id: s.id,
        codigo: s.codigo,
        titulo: s.titulo,
        cliente_nombre: s.cliente?.nombre || null,
        cantidad_ascensores: s.ascensores.length
      }));
    res.json({ data });
  } catch (err) {
    console.error('[cobros.listarProyectos]', err);
    res.status(500).json({ error: 'Error al listar proyectos con cobro' });
  }
};

/**
 * Soft-delete de un cobro completo (estado = 0). Solo Super Admin. Da de baja
 * en cascada cuotas, pagos, recordatorios de cobro, recordatorios de
 * seguimiento y facturas del servicio, purga de Wasabi los comprobantes de pago
 * y los PDFs de factura, y deja el servicio realizado en "Sin cobro" / "Sin
 * factura". Se permite eliminar AUNQUE existan abonos registrados (override SA
 * para corregir errores); queda auditado y es recuperable.
 */
const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cobro = await prisma.tbl_cobros.findUnique({
      where: { id },
      include: { pagos: { where: { estado: 1 } } }
    });
    if (!cobro || cobro.estado === 0) return res.status(404).json({ error: 'Cobro no encontrado' });

    const idServicio = cobro.id_servicio;
    const esCobroDePlan = !!cobro.id_mantenimiento_plan;
    // Facturas a dar de baja: por servicio (cobros por servicio) o por plan (cobro
    // único del plan). En el caso de plan se filtran por id_mantenimiento_plan.
    const facturas = esCobroDePlan
      ? await prisma.tbl_facturas.findMany({ where: { id_mantenimiento_plan: cobro.id_mantenimiento_plan, estado: 1 } })
      : await prisma.tbl_facturas.findMany({ where: { id_servicio: idServicio, estado: 1 } });

    // Recolectar archivos a purgar: comprobantes de pago + PDFs de factura.
    const archivoIds = new Set();
    for (const p of cobro.pagos) if (p.id_archivo_comprobante) archivoIds.add(p.id_archivo_comprobante);
    for (const f of facturas) if (f.id_archivo) archivoIds.add(f.id_archivo);

    const wasabiKeys = [];
    await prisma.$transaction(async (tx) => {
      const stamp = { user_id_modification: req.user.id, date_time_modification: new Date() };
      await tx.tbl_cobros_cuotas.updateMany({ where: { id_cobro: id, estado: 1 }, data: { estado: 0, ...stamp } });
      await tx.tbl_pagos.updateMany({ where: { id_cobro: id, estado: 1 }, data: { estado: 0, ...stamp } });
      await tx.tbl_cobros_recordatorios.updateMany({ where: { id_cobro: id, estado: 1 }, data: { estado: 0, ...stamp } });
      await tx.tbl_recordatorios.updateMany({ where: { id_cobro: id, estado: 1 }, data: { estado: 0, ...stamp } });
      if (esCobroDePlan) {
        await tx.tbl_facturas.updateMany({ where: { id_mantenimiento_plan: cobro.id_mantenimiento_plan, estado: 1 }, data: { estado: 0, ...stamp } });
      } else {
        await tx.tbl_facturas.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });
      }

      for (const idArchivo of archivoIds) {
        const key = await bajaArchivoEnTx(tx, idArchivo, req.user.id);
        if (key) wasabiKeys.push(key);
      }

      await tx.tbl_cobros.update({ where: { id }, data: { estado: 0, ...stamp } });
      // El folder contable del servicio queda sin cobro ni facturación. Los cobros
      // de plan no tienen folder de servicio que actualizar.
      if (!esCobroDePlan && idServicio) {
        await tx.tbl_servicios_realizados.updateMany({
          where: { id_servicio: idServicio },
          data: { estado_cobro: 'Sin cobro', estado_facturacion: ESTADO_FACTURACION_SIN, ...stamp }
        });
      }

      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_cobros', id_entidad: id,
        accion: 'DELETE', valor_anterior: cobro, ip: req.ip
      });
    });

    await purgarObjetosWasabi(wasabiKeys);
    res.json({ ok: true });
  } catch (err) {
    console.error('[cobros.eliminar]', err);
    res.status(500).json({ error: 'Error al eliminar cobro: ' + err.message });
  }
};

module.exports = { listar, obtener, actualizarPlanCuotas, registrarPago, enviarRecordatorio, cerrarCobro, marcarIncobrable, cuotasCalendario, listarProyectos, eliminar };

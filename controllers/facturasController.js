const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const {
  cambiarEstadoServicio,
  estadoServicioDesdeCobro,
  estaServicioFinalizado,
  ESTADO_SERVICIO_EN_CURSO
} = require('../utils/estadoServicio');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima, parseYMDFinDiaLima } = require('../utils/tiempo');
const { descartarAlertaFacturarServicio } = require('../utils/recordatoriosAuto');
const {
  TIPOS_COMPROBANTE_CODIGOS,
  esTipoComprobanteValido,
  normalizarTipoComprobante
} = require('../utils/catalogosComprobante');
const {
  ESTADO_FACTURA_EMITIDA,
  ESTADO_FACTURA_ANULADA,
  ESTADOS_FACTURA,
  esEstadoFacturaValido,
  esFacturado,
  calcularEstadoFacturacion
} = require('../utils/estadoFactura');
const { bajaArchivoEnTx, purgarObjetosWasabi } = require('../utils/reversionEliminacion');
const { MONEDA_POR_DEFECTO } = require('../utils/catalogosBancarios');
const { elegibilidadContable } = require('../utils/elegibilidadContable');
const { detalleMensualDeCuota } = require('../utils/planMantenimientoMensual');
const { porServicioOPlanAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');

/**
 * Añade a la factura la fecha en que se inició el servicio facturado:
 *  - `fecha_inicio_servicio`: primer paso a 'En curso' (inicio real en obra) y,
 *    si el servicio aún no se inició, la fecha programada.
 *  - `inicio_servicio_es_real`: distingue una de otra para la UI.
 * En facturas de plan de mantenimiento (sin servicio) se usa el inicio del plan.
 */
function conFechaInicioServicio(f) {
  const inicioReal = f.servicio?.historial_estados?.[0]?.fecha_cambio || null;
  const programada = f.servicio?.fecha_programada || null;
  const inicioPlan = !f.servicio ? (f.mantenimiento_plan?.fecha_inicio || null) : null;
  return {
    ...f,
    fecha_inicio_servicio: inicioReal || programada || inicioPlan,
    inicio_servicio_es_real: !!inicioReal
  };
}

// Las dos situaciones que Facturas presenta como indicadores y como filtro
// rápido de la cabecera. Valores admitidos por el parámetro `situacion`.
const SITUACIONES_FACTURA = ['facturado', 'pendiente_cobro'];

/**
 * Analiza el conjunto FILTRADO completo (no la página visible) y devuelve, por
 * factura, su importe emitido, su moneda y cuánto de ese importe sigue
 * pendiente de cobro. De aquí salen dos cosas que deben coincidir siempre:
 * los indicadores de la cabecera y el filtro rápido por situación.
 *
 * Las facturas ANULADAS quedan fuera: no son facturación válida aunque sigan
 * listadas en la tabla.
 *
 * Cómo se reparte el saldo entre las facturas de un mismo cobro (para no
 * contarlo dos veces): una factura de cuota se lleva el saldo de SU cuota; las
 * facturas generales (sin cuota) se reparten a prorrata el saldo del cobro MENOS
 * el de las cuotas que ya tienen factura propia — solo esas, porque son las
 * únicas que otra fila va a contar. El saldo de las cuotas todavía sin facturar
 * sigue perteneciendo a la factura general que cubre el cobro. En ambos casos el
 * pendiente de una factura nunca supera su propio importe.
 *
 * @returns {Promise<Array<{id:number, moneda:string, monto:number, pendiente:number}>>}
 *          importes en CENTAVOS enteros (sin residuos de coma flotante).
 */
async function analizarFacturas(where) {
  const filas = await prisma.tbl_facturas.findMany({
    where,
    select: {
      id: true, monto: true, id_cobro: true, estado_factura: true,
      cuota: { select: { monto: true, monto_pagado: true } },
      servicio: { select: { moneda: true } },
      cobro: {
        select: {
          id: true, moneda: true, saldo_pendiente: true,
          cuotas: {
            where: { estado: 1 },
            select: {
              monto: true, monto_pagado: true,
              // Si la cuota ya tiene comprobante propio, su saldo lo reporta esa
              // factura; si no, sigue dentro del saldo de la factura general.
              facturas: { where: { estado: 1 }, select: { estado_factura: true } }
            }
          }
        }
      }
    }
  });

  // Centavos enteros: evita los residuos de coma flotante al acumular importes.
  const cent = (v) => Math.round(Number(v || 0) * 100);
  const saldoCuota = (c) => Math.max(0, cent(c?.monto) - cent(c?.monto_pagado));
  // Misma regla que usa la tabla para mostrar la moneda de cada fila.
  const monedaDe = (f) => f.cobro?.moneda || f.servicio?.moneda || MONEDA_POR_DEFECTO;

  const activas = filas.filter(f => f.estado_factura !== ESTADO_FACTURA_ANULADA);

  // Resto del cobro no cubierto por sus cuotas, a repartir entre las facturas
  // generales de ese cobro que estén dentro del filtro.
  const generalesPorCobro = new Map();
  for (const f of activas) {
    if (f.cuota || !f.id_cobro) continue;
    if (!generalesPorCobro.has(f.id_cobro)) generalesPorCobro.set(f.id_cobro, []);
    generalesPorCobro.get(f.id_cobro).push(f);
  }
  const pendientePorFactura = new Map();
  for (const [, grupo] of generalesPorCobro) {
    const cobro = grupo[0].cobro;
    const saldoCuotasFacturadas = (cobro?.cuotas || [])
      .filter(c => (c.facturas || []).some(f => f.estado_factura !== ESTADO_FACTURA_ANULADA))
      .reduce((acc, c) => acc + saldoCuota(c), 0);
    const resto = Math.max(0, cent(cobro?.saldo_pendiente) - saldoCuotasFacturadas);
    const totalGrupo = grupo.reduce((acc, f) => acc + cent(f.monto), 0);
    for (const f of grupo) {
      const parte = totalGrupo > 0 ? Math.round((resto * cent(f.monto)) / totalGrupo) : 0;
      pendientePorFactura.set(f.id, Math.min(cent(f.monto), parte));
    }
  }
  for (const f of activas) {
    if (!f.cuota) continue;
    pendientePorFactura.set(f.id, Math.min(cent(f.monto), saldoCuota(f.cuota)));
  }

  return activas.map(f => ({
    id: f.id,
    moneda: monedaDe(f),
    monto: cent(f.monto),
    pendiente: pendientePorFactura.get(f.id) || 0
  }));
}

/**
 * Resume las facturas analizadas en los dos indicadores de la cabecera.
 *
 *   - `facturado`: cuántas facturas hay y por cuánto se emitieron;
 *   - `pendiente`: de esas mismas, las que siguen con saldo y cuánto falta.
 *
 * Los importes van desglosados POR MONEDA: la cartera mezcla PEN y USD y
 * sumarlos daría un número falso. Mismo formato que `resumen_facturacion` de
 * Contabilidad: monedas ordenadas de mayor a menor, para que la UI las pinte
 * sin adivinar.
 */
function resumirFacturas(analizadas) {
  const facturado = { cantidad: 0, montos: new Map() };
  const pendiente = { cantidad: 0, montos: new Map() };
  const acumular = (grupo, moneda, centavos) =>
    grupo.montos.set(moneda, (grupo.montos.get(moneda) || 0) + centavos);

  for (const f of analizadas) {
    facturado.cantidad++;
    acumular(facturado, f.moneda, f.monto);
    if (f.pendiente > 0) {
      pendiente.cantidad++;
      acumular(pendiente, f.moneda, f.pendiente);
    }
  }

  const aSalida = (g) => ({
    cantidad: g.cantidad,
    montos: [...g.montos.entries()]
      .map(([moneda, centavos]) => ({ moneda, total: centavos / 100 }))
      .sort((a, b) => b.total - a.total)
  });
  return { facturado: aSalida(facturado), pendiente: aSalida(pendiente) };
}

const listar = async (req, res) => {
  try {
    const { id_cliente, id_servicio, q, estado_factura, tipo_comprobante, cobertura, tipo_categoria, situacion, desde, hasta } = req.query;
    // Se acumulan en AND porque hay dos filtros que usan OR (búsqueda libre y
    // tipo de servicio): asignarlos a where.OR directamente se pisarían.
    const and = [];
    const where = { estado: 1, AND: and };
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (id_servicio) where.id_servicio = Number(id_servicio);
    if (estado_factura) where.estado_factura = estado_factura;
    // Tipo de comprobante: Factura | Boleta. Un valor desconocido se ignora en
    // vez de devolver una lista vacía silenciosa.
    if (tipo_comprobante && esTipoComprobanteValido(tipo_comprobante)) {
      where.tipo_comprobante = tipo_comprobante;
    }
    // Cobertura: 'general' = factura por todo el servicio (sin cuota);
    // 'cuota' = factura ligada a una cuota específica del plan.
    if (cobertura === 'general') where.id_cuota = null;
    else if (cobertura === 'cuota') where.id_cuota = { not: null };
    if (desde || hasta) {
      where.fecha_emision = {};
      if (desde) where.fecha_emision.gte = parseYMDLima(desde);
      if (hasta) where.fecha_emision.lte = parseYMDFinDiaLima(hasta);
    }
    if (q) and.push({ OR: [
      { numero_factura: { contains: q, mode: 'insensitive' } },
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      // RUC / DNI del cliente: contabilidad busca por documento tanto como por nombre.
      { cliente: { numero_documento: { contains: q, mode: 'insensitive' } } },
      { servicio: { codigo: { contains: q, mode: 'insensitive' } } },
      // Nombre del edificio / obra. La factura llega al sitio por dos caminos
      // según su origen: vía el servicio, o vía el plan de mantenimiento cuando
      // es la factura de una cuota del plan (esas no tienen id_servicio).
      { servicio: { ascensores: { some: { estado: 1, ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } } } } },
      { mantenimiento_plan: { ascensores: { some: { estado: 1, ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } } } } }
    ] });
    // Tipo de servicio facturado. Mismo criterio que el filtro de Cobros
    // (cobrosController.listar): correctivo / preventivo (mantenimiento, incluye
    // las facturas del cobro del plan) / proyecto.
    if (tipo_categoria === 'proyecto') {
      and.push({ servicio: { tipo_registro: 'proyecto' } });
    } else if (tipo_categoria === 'correctivo') {
      and.push({ servicio: { tipo_servicio: { modulo_asociado: 'correctivo' } } });
    } else if (tipo_categoria === 'preventivo') {
      and.push({ OR: [
        { servicio: { tipo_servicio: { modulo_asociado: 'mantenimiento' } } },
        { AND: [{ id_servicio: null }, { id_mantenimiento_plan: { not: null } }] }
      ] });
    }

    // Orden configurable por columna (whitelist para evitar inyección). El
    // correlativo refleja el orden de creación (id), por eso "correlativo" mapea
    // a id. Por defecto: serie y N° de factura ascendente, que es el orden del
    // registro contable y el que muestra la pantalla al abrirse. El correlativo
    // (zero-padded dentro de cada serie) ordena bien como texto.
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
    const orderBy = ORDEN[sort] || { numero_factura: 'asc' };
    // Alcance por tipo de edificio (Administrador): factura de servicio o de plan.
    conAlcance(where, porServicioOPlanAscensorEdificioWhere(req.user));

    // Análisis del conjunto filtrado ANTES de paginar y antes de aplicar la
    // situación: de él salen los dos indicadores y el propio filtro rápido, así
    // que pulsar "Pendiente de cobro" deja en la tabla exactamente las facturas
    // que ese indicador cuenta.
    const analizadas = await analizarFacturas(where);
    // El pendiente de una factura no es una columna de la tabla (se reparte el
    // saldo del cobro entre sus facturas), así que el recorte va por id.
    // Un valor desconocido se ignora, en vez de devolver una lista vacía silenciosa.
    const situacionFiltro = SITUACIONES_FACTURA.includes(situacion) ? situacion : null;
    const visibles = situacionFiltro === 'pendiente_cobro'
      ? analizadas.filter(f => f.pendiente > 0)
      : analizadas;
    if (situacionFiltro === 'pendiente_cobro') {
      and.push({ id: { in: visibles.map(f => f.id) } });
    } else if (situacionFiltro === 'facturado') {
      // "Facturado" son las facturas válidas del filtro: todas menos las anuladas.
      and.push({ estado_factura: { not: ESTADO_FACTURA_ANULADA } });
    }

    const result = await paginar(
      prisma.tbl_facturas,
      {
        where,
        orderBy,
        include: {
          cliente: true,
          servicio: {
            include: {
              tipo_servicio: true,
              // Edificio / obra donde se prestó el servicio: la tabla lo muestra
              // y el buscador filtra por su nombre.
              ascensores: {
                where: { estado: 1 },
                select: { ascensor: { select: { edificio: { select: { id: true, nombre: true } } } } }
              },
              // Primer paso a 'En curso' = inicio real del servicio en obra.
              historial_estados: {
                where: { estado_nuevo: ESTADO_SERVICIO_EN_CURSO },
                orderBy: { fecha_cambio: 'asc' },
                take: 1,
                select: { fecha_cambio: true }
              }
            }
          },
          // Las facturas de cuota de un plan no cuelgan de un servicio: el
          // edificio se resuelve por los ascensores que cubre el plan.
          mantenimiento_plan: {
            include: {
              tipo_servicio: true,
              ascensores: {
                where: { estado: 1 },
                select: { ascensor: { select: { edificio: { select: { id: true, nombre: true } } } } }
              }
            }
          },
          archivo: true,
          cobro: true,
          cuota: true
        }
      },
      req.query
    );
    if (Array.isArray(result?.data)) result.data = result.data.map(conFechaInicioServicio);
    // El resumen describe TODO el recorte elegido, no las 25 filas visibles, y
    // sale del mismo análisis que alimenta el filtro: no pueden desincronizarse.
    // La ruta ya está restringida a roles con visibilidad financiera (ver
    // facturasRoutes).
    res.json({ ...result, resumen_facturas: resumirFacturas(visibles) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar facturas' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const f = await prisma.tbl_facturas.findUnique({
      where: { id },
      include: {
        cliente: true,
        servicio: {
          include: {
            tipo_servicio: true,
            historial_estados: {
              where: { estado_nuevo: ESTADO_SERVICIO_EN_CURSO },
              orderBy: { fecha_cambio: 'asc' },
              take: 1,
              select: { fecha_cambio: true }
            }
          }
        },
        mantenimiento_plan: { include: { tipo_servicio: true } },
        archivo: true,
        cobro: true,
        cuota: true
      }
    });
    if (!f) return res.status(404).json({ error: 'No encontrada' });
    // Factura de un MES de un plan de mantenimiento: adjunta el detalle de los
    // mantenimientos que cubre ese mes (qué ascensor, cuántas veces y en qué
    // fechas). Es un solo comprobante por el monto mensual pactado; el detalle
    // se deriva del cronograma del plan, no se copia en la factura.
    const detalleMensual = f.id_cuota ? await detalleMensualDeCuota(prisma, f.id_cuota) : null;
    res.json({ data: { ...conFechaInicioServicio(f), detalle_mensual: detalleMensual } });
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
async function _crearFacturaPlan(req, res, d, tipoComprobante) {
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
      tipo_comprobante: tipoComprobante,
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
    // Tipo de comprobante: se exige un valor del catálogo cuando viene, en vez
    // de caer al default en silencio y guardar una boleta como factura.
    if (d.tipo_comprobante !== undefined && d.tipo_comprobante !== null && d.tipo_comprobante !== ''
        && !esTipoComprobanteValido(d.tipo_comprobante)) {
      return res.status(400).json({ error: `Tipo de comprobante inválido. Valores permitidos: ${TIPOS_COMPROBANTE_CODIGOS.join(', ')}` });
    }
    const tipoComprobante = normalizarTipoComprobante(d.tipo_comprobante);
    // Factura de plan de mantenimiento (cobro único del plan, sin servicio).
    if (d.id_mantenimiento_plan) {
      return await _crearFacturaPlan(req, res, d, tipoComprobante);
    }
    if (!d.id_servicio) {
      return res.status(400).json({ error: 'Servicio (o plan de mantenimiento) es obligatorio' });
    }
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: Number(d.id_servicio) }, include: { cobro: true, servicio_realizado: true }
    });
    if (!servicio) return res.status(400).json({ error: 'Servicio no existe' });
    // Servicios de un PLAN de mantenimiento: la facturación es única a nivel de
    // plan (una factura por mes, contra la cuota del cobro del plan). Emitir un
    // comprobante por el mantenimiento de un solo ascensor duplicaría lo que ya
    // se factura en el total del mes.
    //
    // EXCEPCIÓN legacy: planes del modelo anterior (sin cobro único de plan)
    // cuyos servicios nacieron con cobro PROPIO. Ahí no existe cuota de plan
    // que facturar — el único vehículo de cobro/factura es el del servicio, y
    // bloquearlo dejaría esas cuotas incobrables. Se permite el flujo normal
    // por servicio SOLO en ese caso.
    if (servicio.id_mantenimiento_plan) {
      const cobroPlan = await prisma.tbl_cobros.findFirst({
        where: { id_mantenimiento_plan: servicio.id_mantenimiento_plan, estado: 1 },
        select: { id: true }
      });
      const cobroPropioVivo = servicio.cobro && servicio.cobro.estado === 1;
      if (cobroPlan || !cobroPropioVivo) {
        return res.status(400).json({
          error: 'Este mantenimiento pertenece a un plan: se factura una sola vez al mes, no por servicio. Emita la factura desde el detalle del plan (Facturación mensual) o en Gestión de cobros → Por facturar.'
        });
      }
    }
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
        tipo_comprobante: tipoComprobante,
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
    const { estado_factura, motivo } = req.body;
    if (!esEstadoFacturaValido(estado_factura)) {
      return res.status(400).json({ error: `Estado inválido. Permitidos: ${ESTADOS_FACTURA.join(', ')}` });
    }
    const previo = await prisma.tbl_facturas.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Factura no encontrada' });
    if (previo.estado === 0) return res.status(404).json({ error: 'Factura no encontrada' });
    // Una anulación es definitiva: la factura queda como constancia y el servicio
    // (o la cuota) vuelve a admitir la emisión de una nueva. Revertirla podría
    // dejar dos facturas vigentes sobre el mismo concepto.
    if (previo.estado_factura === ESTADO_FACTURA_ANULADA) {
      return estado_factura === ESTADO_FACTURA_ANULADA
        ? res.status(400).json({ error: 'La factura ya está anulada.' })
        : res.status(400).json({ error: 'Una factura anulada no se puede reactivar. Emita una nueva factura.' });
    }
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
      accion: 'STATUS_CHANGE',
      valor_anterior: { estado: previo.estado_factura },
      // El motivo de anulación no tiene columna propia: queda en la auditoría,
      // que es donde se consulta el porqué de un cambio de estado.
      valor_nuevo: { estado: estado_factura, ...(motivo ? { motivo: String(motivo).trim() } : {}) },
      ip: req.ip
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

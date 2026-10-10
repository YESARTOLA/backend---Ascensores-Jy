const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const {
  cambiarEstadoServicio,
  estadoServicioDesdeCobro,
  estaServicioFinalizado,
  ESTADO_SERVICIO_EN_CURSO
} = require('../utils/estadoServicio');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima, parseYMDFinDiaLima, ymdDeFecha } = require('../utils/tiempo');
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
const { MONEDA_POR_DEFECTO, normalizarMoneda } = require('../utils/catalogosBancarios');
const { elegibilidadContable } = require('../utils/elegibilidadContable');
const { detalleMensualDeCuota } = require('../utils/planMantenimientoMensual');
const { sincronizarFacturacionServiciosPlan } = require('../utils/facturacionServiciosPlan');
const { porServicioOPlanAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');
const {
  MAX_DOCUMENTOS_FACTURA,
  SELECT_ARCHIVO,
  INCLUDE_DOCUMENTOS,
  errorHttp,
  tipoDocumentoValido,
  descripcionDocumento,
  vincularDocumentosEnTx,
  bajaDocumentosDeFacturasEnTx
} = require('../utils/documentosFactura');

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
    const { id_cliente, id_servicio, q, estado_factura, tipo_comprobante, cobertura, tipo_categoria, situacion, moneda, desde, hasta } = req.query;
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

    // Filtro por moneda. La factura no guarda la suya: la HEREDA del cobro y,
    // si no lo tiene, del servicio (misma regla que `monedaDe`, la que rotula
    // cada importe de la tabla y agrupa el resumen). Por eso el filtro no es una
    // columna sino un OR sobre la relación que aporta la divisa. El tercer caso
    // —factura sin cobro y sin servicio— toma la moneda por defecto, así que
    // solo entra cuando se filtra justamente por esa. Un código fuera del
    // catálogo se ignora (normalizarMoneda devuelve null).
    const monedaFiltro = normalizarMoneda(moneda);
    if (monedaFiltro) {
      and.push({ OR: [
        { cobro: { is: { moneda: monedaFiltro } } },
        { cobro: { is: null }, servicio: { is: { moneda: monedaFiltro } } },
        ...(monedaFiltro === MONEDA_POR_DEFECTO
          ? [{ cobro: { is: null }, servicio: { is: null } }]
          : [])
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
          documentos: INCLUDE_DOCUMENTOS,
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
        documentos: INCLUDE_DOCUMENTOS,
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
 * Factura de PLAN: refleja el cambio en los mantenimientos del mes que cubre
 * (Contabilidad lista cada uno con su estado de factura). La factura ya quedó
 * grabada: un fallo aquí se registra pero no la deshace.
 */
async function sincronizarServiciosDelPlan(idPlan, idUsuario) {
  try {
    await sincronizarFacturacionServiciosPlan(prisma, idPlan, idUsuario);
  } catch (err) {
    console.error(`[facturas] sincronizar servicios del plan #${idPlan}:`, err);
  }
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
  const errorCobertura = await validarCoberturaFactura({
    ambito: { id_mantenimiento_plan: idPlan },
    nombre: 'plan',
    cobro,
    totalCobrable: Number(cobro.monto_total || 0),
    idCuota,
    monto: d.monto
  });
  if (errorCobertura) return res.status(400).json({ error: errorCobertura });

  const estadoFacturaInicial = d.estado_factura && esEstadoFacturaValido(d.estado_factura)
    ? d.estado_factura : ESTADO_FACTURA_EMITIDA;
  // La factura y sus documentos adicionales se registran juntos: si un
  // documento no es válido, no queda una factura a medias.
  const factura = await prisma.$transaction(async (tx) => {
    const creada = await tx.tbl_facturas.create({
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
    await vincularDocumentosEnTx(tx, creada.id, d.documentos, req.user.id);
    return creada;
  });
  await registrarAuditoria({
    id_usuario: req.user.id, entidad: 'tbl_facturas', id_entidad: factura.id, accion: 'CREATE', valor_nuevo: factura, ip: req.ip
  });
  await sincronizarServiciosDelPlan(idPlan, req.user.id);
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
    let esPlanLegacyConCobroPropio = false;
    if (servicio.id_mantenimiento_plan) {
      const cobroPlan = await prisma.tbl_cobros.findFirst({
        where: { id_mantenimiento_plan: servicio.id_mantenimiento_plan, estado: 1 },
        select: { id: true }
      });
      const cobroPropioVivo = servicio.cobro && servicio.cobro.estado === 1;
      if (cobroPlan || !cobroPropioVivo) {
        return res.status(400).json({
          error: 'Este mantenimiento pertenece a un plan: se factura una sola vez al mes, no por servicio. Emita la factura contra la cuota del plan desde Contabilidad → Por facturar, Gestión de cobros → Por facturar o el detalle del plan (Facturación mensual).'
        });
      }
      esPlanLegacyConCobroPropio = true;
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
    //
    // No aplica a la excepción legacy de arriba: todo servicio de plan nace (o
    // quedó, por la migración 20260731120000) con la marca en 0 porque en el
    // modelo mensual se factura la cuota del plan. En un plan legacy esa cuota no
    // existe y el cobro propio del servicio es la única vía de facturarlo.
    if (servicio.requiere_factura === 0 && !esPlanLegacyConCobroPropio) {
      return res.status(400).json({ error: 'El servicio está marcado como "Sin factura"; no admite emisión de comprobantes.' });
    }

    // Modo: general (id_cuota null) vs por-cuota (id_cuota set), mutuamente
    // excluyentes a nivel servicio. La general no supera el total cobrable
    // (monto del cobro o, en su defecto, el precio del servicio).
    const idCuota = d.id_cuota ? Number(d.id_cuota) : null;
    const errorCobertura = await validarCoberturaFactura({
      ambito: { id_servicio: Number(d.id_servicio) },
      nombre: 'servicio',
      cobro: servicio.cobro,
      totalCobrable: Number(servicio.cobro?.monto_total ?? servicio.precio_interno ?? 0),
      idCuota,
      monto: d.monto
    });
    if (errorCobertura) return res.status(400).json({ error: errorCobertura });

    const estadoFacturaInicial = d.estado_factura && esEstadoFacturaValido(d.estado_factura)
      ? d.estado_factura
      : ESTADO_FACTURA_EMITIDA;

    // La factura y sus documentos adicionales se registran juntos: si un
    // documento no es válido, no queda una factura a medias.
    const factura = await prisma.$transaction(async (tx) => {
      const creada = await tx.tbl_facturas.create({
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
      await vincularDocumentosEnTx(tx, creada.id, d.documentos, req.user.id);
      return creada;
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
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
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
      await sincronizarServicioTrasFactura(
        previo.id_servicio,
        req.user.id,
        `Factura ${previo.numero_factura} pasó a ${estado_factura}`
      );
    }
    // Factura de PLAN: anularla (o marcarla Enviada) cambia el estado de los
    // mantenimientos del mes que cubre.
    if (previo.id_mantenimiento_plan) await sincronizarServiciosDelPlan(previo.id_mantenimiento_plan, req.user.id);

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
 * y los documentos adicionales en Wasabi, recalcula el estado_facturacion agregado del servicio (puede
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
      // El comprobante y los documentos adicionales corren la misma suerte.
      const idsArchivo = [
        previo.id_archivo,
        ...await bajaDocumentosDeFacturasEnTx(tx, [id], req.user.id)
      ];
      for (const idArchivo of idsArchivo) {
        const key = await bajaArchivoEnTx(tx, idArchivo, req.user.id);
        if (key) wasabiKeys.push(key);
      }
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_facturas', id_entidad: id,
        accion: 'DELETE', valor_anterior: previo, ip: req.ip
      });
    });

    await purgarObjetosWasabi(wasabiKeys);

    // Facturas de servicio: recalcular estado_facturacion y resincronizar estado.
    // Las facturas de PLAN no tienen servicio que recalcular.
    if (idServicio) {
      await sincronizarServicioTrasFactura(idServicio, req.user.id, `Factura ${previo.numero_factura} eliminada`);
    }
    if (previo.id_mantenimiento_plan) await sincronizarServiciosDelPlan(previo.id_mantenimiento_plan, req.user.id);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar factura: ' + err.message });
  }
};

// ---------------------------------------------------------------------
// DOCUMENTOS DE LA FACTURA
//
// El comprobante (tbl_facturas.id_archivo) más los documentos de soporte que lo
// acompañan: constancia de detracción, de retención, de pago, XML/CDR… Suelen
// llegar DESPUÉS de emitir la factura, por eso se gestionan sobre la factura ya
// registrada. También sobre una anulada: lo que respalda la anulación (la nota
// de crédito, por ejemplo) es un documento que se archiva con ella.
// ---------------------------------------------------------------------

/** Factura viva (estado = 1) con su comprobante, o null. */
async function facturaVigente(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const f = await prisma.tbl_facturas.findUnique({
    where: { id },
    select: { id: true, estado: true, id_archivo: true, archivo: { select: SELECT_ARCHIVO } }
  });
  return f && f.estado === 1 ? f : null;
}

/** Respuesta común de los endpoints de documentos: comprobante + adicionales. */
async function respuestaDocumentos(factura) {
  const documentos = await prisma.tbl_facturas_archivos.findMany({
    ...INCLUDE_DOCUMENTOS,
    where: { ...INCLUDE_DOCUMENTOS.where, id_factura: factura.id }
  });
  return {
    data: { comprobante: factura.archivo || null, documentos },
    meta: { max: MAX_DOCUMENTOS_FACTURA }
  };
}

const listarDocumentos = async (req, res) => {
  try {
    const factura = await facturaVigente(Number(req.params.id));
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    res.json(await respuestaDocumentos(factura));
  } catch (err) {
    console.error('[facturas.listarDocumentos]', err);
    res.status(500).json({ error: 'Error al listar los documentos de la factura' });
  }
};

const agregarDocumentos = async (req, res) => {
  try {
    const factura = await facturaVigente(Number(req.params.id));
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    const creados = await prisma.$transaction(tx =>
      vincularDocumentosEnTx(tx, factura.id, req.body?.documentos, req.user.id));
    if (creados.length === 0) return res.status(400).json({ error: 'No se recibió ningún documento válido' });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_facturas_archivos', id_entidad: factura.id,
      accion: 'CREATE',
      valor_nuevo: {
        id_factura: factura.id,
        documentos: creados.map(c => ({ id: c.id, id_archivo: c.id_archivo, tipo_documento: c.tipo_documento }))
      },
      ip: req.ip
    });
    res.status(201).json(await respuestaDocumentos(factura));
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error('[facturas.agregarDocumentos]', err);
    res.status(500).json({ error: 'Error al agregar los documentos' });
  }
};

const eliminarDocumento = async (req, res) => {
  try {
    const factura = await facturaVigente(Number(req.params.id));
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    const idDocumento = Number(req.params.idDocumento);
    const documento = Number.isInteger(idDocumento) && idDocumento > 0
      ? await prisma.tbl_facturas_archivos.findFirst({ where: { id: idDocumento, id_factura: factura.id, estado: 1 } })
      : null;
    if (!documento) return res.status(404).json({ error: 'Documento no encontrado' });

    let key = null;
    await prisma.$transaction(async (tx) => {
      await tx.tbl_facturas_archivos.update({
        where: { id: documento.id },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      key = await bajaArchivoEnTx(tx, documento.id_archivo, req.user.id);
    });
    // Purga del bucket tras el commit: si falla, el registro ya quedó dado de
    // baja y el objeto se limpia después — nunca al revés.
    await purgarObjetosWasabi([key]);

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_facturas_archivos', id_entidad: documento.id,
      accion: 'DELETE', valor_anterior: documento, ip: req.ip
    });
    res.json(await respuestaDocumentos(factura));
  } catch (err) {
    console.error('[facturas.eliminarDocumento]', err);
    res.status(500).json({ error: 'Error al eliminar el documento' });
  }
};

/** Archivo activo de tbl_archivos con ese id, o null. */
async function archivoActivo(idArchivo) {
  const id = Number(idArchivo);
  if (!Number.isInteger(id) || id <= 0) return null;
  return prisma.tbl_archivos.findFirst({ where: { id, estado: 1 }, select: { id: true } });
}

/**
 * Cambia el comprobante de la factura (tbl_facturas.id_archivo): lo adjunta,
 * lo reemplaza (`idArchivoNuevo`) o lo quita (null). El archivo anterior se da
 * de baja y se purga del bucket tras el commit; la auditoría guarda cuál era.
 *
 * El UPDATE exige que el comprobante siga siendo el que se leyó: dos cambios
 * simultáneos no pueden pisarse en silencio.
 */
async function cambiarComprobante(factura, idArchivoNuevo, idUsuario, ip) {
  let key = null;
  await prisma.$transaction(async (tx) => {
    const r = await tx.tbl_facturas.updateMany({
      where: { id: factura.id, estado: 1, id_archivo: factura.id_archivo },
      data: { id_archivo: idArchivoNuevo, user_id_modification: idUsuario, date_time_modification: new Date() }
    });
    if (r.count === 0) throw errorHttp('El comprobante de la factura cambió mientras tanto. Vuelve a abrirla.', 409);
    key = await bajaArchivoEnTx(tx, factura.id_archivo, idUsuario);
  });
  await purgarObjetosWasabi([key]);
  await registrarAuditoria({
    id_usuario: idUsuario, entidad: 'tbl_facturas', id_entidad: factura.id, accion: 'UPDATE',
    valor_anterior: { id_archivo: factura.id_archivo }, valor_nuevo: { id_archivo: idArchivoNuevo }, ip
  });
}

/** Adjunta el comprobante a la factura o REEMPLAZA el que tiene. */
const adjuntarComprobante = async (req, res) => {
  try {
    const factura = await facturaVigente(Number(req.params.id));
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    const archivo = await archivoActivo(req.body?.id_archivo);
    if (!archivo) return res.status(400).json({ error: 'Archivo no válido' });
    if (archivo.id !== factura.id_archivo) {
      await cambiarComprobante(factura, archivo.id, req.user.id, req.ip);
    }
    res.json(await respuestaDocumentos(await facturaVigente(factura.id)));
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error('[facturas.adjuntarComprobante]', err);
    res.status(500).json({ error: 'Error al adjuntar el comprobante' });
  }
};

/** Quita el comprobante de la factura (la factura queda registrada sin archivo). */
const quitarComprobante = async (req, res) => {
  try {
    const factura = await facturaVigente(Number(req.params.id));
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    if (!factura.id_archivo) return res.status(400).json({ error: 'La factura no tiene comprobante adjunto' });
    await cambiarComprobante(factura, null, req.user.id, req.ip);
    res.json(await respuestaDocumentos(await facturaVigente(factura.id)));
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error('[facturas.quitarComprobante]', err);
    res.status(500).json({ error: 'Error al quitar el comprobante' });
  }
};

/**
 * Edita un documento adicional: su tipo, su descripción y/o su archivo. Al
 * reemplazar el archivo, el anterior se da de baja y se purga del bucket.
 * Body (todo opcional): { tipo_documento, descripcion, id_archivo }
 */
const editarDocumento = async (req, res) => {
  try {
    const factura = await facturaVigente(Number(req.params.id));
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    const idDocumento = Number(req.params.idDocumento);
    const documento = Number.isInteger(idDocumento) && idDocumento > 0
      ? await prisma.tbl_facturas_archivos.findFirst({ where: { id: idDocumento, id_factura: factura.id, estado: 1 } })
      : null;
    if (!documento) return res.status(404).json({ error: 'Documento no encontrado' });

    const d = req.body || {};
    const data = {};
    if (d.tipo_documento !== undefined) data.tipo_documento = tipoDocumentoValido(d.tipo_documento);
    if (d.descripcion !== undefined) data.descripcion = descripcionDocumento(d.descripcion);
    if (d.id_archivo !== undefined && Number(d.id_archivo) !== documento.id_archivo) {
      const archivo = await archivoActivo(d.id_archivo);
      if (!archivo) return res.status(400).json({ error: 'Archivo no válido' });
      data.id_archivo = archivo.id;
    }
    if (Object.keys(data).length === 0) return res.json(await respuestaDocumentos(factura));

    let key = null;
    await prisma.$transaction(async (tx) => {
      await tx.tbl_facturas_archivos.update({
        where: { id: documento.id },
        data: { ...data, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      if (data.id_archivo) key = await bajaArchivoEnTx(tx, documento.id_archivo, req.user.id);
    });
    await purgarObjetosWasabi([key]);

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_facturas_archivos', id_entidad: documento.id, accion: 'UPDATE',
      valor_anterior: Object.fromEntries(Object.keys(data).map(k => [k, documento[k]])),
      valor_nuevo: data,
      ip: req.ip
    });
    res.json(await respuestaDocumentos(factura));
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error('[facturas.editarDocumento]', err);
    res.status(500).json({ error: 'Error al editar el documento' });
  }
};

// ---------------------------------------------------------------------
// EDICIÓN DE LA FACTURA
//
// Corrige los datos de una factura ya registrada: tipo de comprobante, número,
// fecha de emisión, monto, cobertura (general o cuota) y estado. Sus archivos
// se editan con los endpoints de documentos de arriba.
// ---------------------------------------------------------------------

/**
 * Tras un cambio en las facturas de un servicio: recalcula su estado de
 * facturación agregado y, si el servicio ya está en post-ejecución, su estado
 * (lo mueven el cobro y la facturación).
 */
async function sincronizarServicioTrasFactura(idServicio, idUsuario, motivo) {
  const estadoFacturacion = await recomputarEstadoFacturacionServicio(idServicio, idUsuario);
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
    await cambiarEstadoServicio(idServicio, nuevoEstadoServ, idUsuario, motivo);
  }
}

/**
 * Reglas de COBERTURA de una factura y de su monto, comunes a emitirla y a
 * editarla:
 *  - factura general y facturas por cuota se excluyen dentro del mismo
 *    servicio / plan; hay una sola general y una sola factura por cuota;
 *  - la general no supera el total cobrable; la de cuota iguala el monto de la cuota.
 * Las anuladas no cuentan. `excluirId` deja fuera a la propia factura al editar.
 *
 * @param {object} p
 * @param {object} p.ambito         { id_servicio } | { id_mantenimiento_plan }
 * @param {'servicio'|'plan'} p.nombre  cómo nombrar el ámbito en los mensajes
 * @param {object|null} p.cobro     cobro del ámbito (la cuota debe ser suya)
 * @param {number} p.totalCobrable  tope de la factura general (0 = sin tope)
 * @param {number|null} p.idCuota
 * @param {number|string} p.monto
 * @param {number} [p.excluirId]
 * @returns {Promise<string|null>} mensaje de error, o null si es válida
 */
async function validarCoberturaFactura({ ambito, nombre, cobro, totalCobrable, idCuota, monto, excluirId }) {
  const facturasExistentes = await prisma.tbl_facturas.findMany({
    where: {
      ...ambito, estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA },
      ...(excluirId ? { id: { not: excluirId } } : {})
    }
  });
  const hayGeneral = facturasExistentes.some(f => f.id_cuota === null);
  const hayPorCuota = facturasExistentes.some(f => f.id_cuota !== null);

  if (idCuota === null) {
    if (hayPorCuota) return `Este ${nombre} ya tiene facturas por cuota. No se puede emitir una factura general además.`;
    if (hayGeneral) return `Este ${nombre} ya tiene una factura general emitida.`;
    if (totalCobrable > 0 && Number(monto) - totalCobrable > 0.01) {
      return `El monto de la factura (S/ ${Number(monto).toFixed(2)}) excede el total del ${nombre} (S/ ${totalCobrable.toFixed(2)}).`;
    }
    return null;
  }
  if (hayGeneral) return `Este ${nombre} ya tiene una factura general. No se puede emitir factura por cuota además.`;
  const cuota = await prisma.tbl_cobros_cuotas.findUnique({ where: { id: idCuota } });
  if (!cuota || cuota.estado !== 1) return 'Cuota no existe';
  if (cobro && cuota.id_cobro !== cobro.id) return `La cuota no pertenece a este ${nombre}`;
  const yaFacturada = facturasExistentes.find(f => f.id_cuota === idCuota);
  if (yaFacturada) return `La cuota N° ${cuota.numero_cuota} ya tiene factura (${yaFacturada.numero_factura})`;
  // El monto de una factura de cuota es el de la cuota (no editable).
  if (Math.abs(Number(monto) - Number(cuota.monto)) > 0.01) {
    return `El monto de la factura (S/ ${Number(monto).toFixed(2)}) debe igualar el monto de la cuota N° ${cuota.numero_cuota} (S/ ${Number(cuota.monto).toFixed(2)})`;
  }
  return null;
}

/**
 * Ámbito de cobertura de una factura ya registrada (su servicio o su plan),
 * para `validarCoberturaFactura`. Null si la factura no cuelga de ninguno.
 */
async function contextoCoberturaDeFactura(f) {
  if (f.id_servicio) {
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: f.id_servicio }, include: { cobro: true }
    });
    return {
      ambito: { id_servicio: f.id_servicio },
      nombre: 'servicio',
      cobro: servicio?.cobro || null,
      totalCobrable: Number(servicio?.cobro?.monto_total ?? servicio?.precio_interno ?? 0)
    };
  }
  if (f.id_mantenimiento_plan) {
    const cobro = f.id_cobro ? await prisma.tbl_cobros.findUnique({ where: { id: f.id_cobro } }) : null;
    return {
      ambito: { id_mantenimiento_plan: f.id_mantenimiento_plan },
      nombre: 'plan',
      cobro,
      totalCobrable: Number(cobro?.monto_total || 0)
    };
  }
  return null;
}

/**
 * Lo que necesita el formulario de edición: los datos de la factura, su moneda
 * y las opciones de cobertura — las cuotas activas de su cobro y las OTRAS
 * facturas vigentes del mismo servicio o plan (para marcar qué está ocupado).
 */
const contextoEdicion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const f = Number.isInteger(id) && id > 0
      ? await prisma.tbl_facturas.findUnique({
          where: { id },
          include: {
            cobro: { select: { moneda: true } },
            servicio: { select: { moneda: true } },
            cuota: { select: { numero_cuota: true } }
          }
        })
      : null;
    if (!f || f.estado === 0) return res.status(404).json({ error: 'Factura no encontrada' });
    const ctx = await contextoCoberturaDeFactura(f);
    const idCobro = ctx?.cobro?.id ?? f.id_cobro;
    const [cuotas, otrasFacturas] = await Promise.all([
      idCobro
        ? prisma.tbl_cobros_cuotas.findMany({
            where: { id_cobro: idCobro, estado: 1 },
            orderBy: { numero_cuota: 'asc' },
            select: { id: true, numero_cuota: true, numero_mes: true, fecha_vencimiento: true, monto: true }
          })
        : [],
      ctx
        ? prisma.tbl_facturas.findMany({
            where: { ...ctx.ambito, estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA }, id: { not: id } },
            select: { id: true, numero_factura: true, id_cuota: true }
          })
        : []
    ]);
    res.json({
      data: {
        factura: {
          id: f.id,
          numero_factura: f.numero_factura,
          tipo_comprobante: f.tipo_comprobante,
          fecha_emision: f.fecha_emision,
          monto: f.monto,
          id_cuota: f.id_cuota,
          numero_cuota: f.cuota?.numero_cuota ?? null,
          estado_factura: f.estado_factura,
          es_plan: !f.id_servicio && !!f.id_mantenimiento_plan
        },
        moneda: f.cobro?.moneda || f.servicio?.moneda || MONEDA_POR_DEFECTO,
        cuotas,
        otras_facturas: otrasFacturas
      }
    });
  } catch (err) {
    console.error('[facturas.contextoEdicion]', err);
    res.status(500).json({ error: 'Error al cargar la factura' });
  }
};

// ¿El valor nuevo de un campo es igual al guardado? (Decimal, fecha o texto.)
function mismoValor(campo, anterior, nuevo) {
  if (campo === 'monto') return Math.round(Number(anterior) * 100) === Math.round(Number(nuevo) * 100);
  if (campo === 'fecha_emision') return ymdDeFecha(anterior) === ymdDeFecha(nuevo);
  return anterior === nuevo;
}

/**
 * Edita los datos de una factura. Body (todo opcional; lo que no viene no
 * cambia): { tipo_comprobante, numero_factura, fecha_emision, monto, id_cuota,
 * estado_factura }.
 *
 * Solo se valida lo que cambia: corregir el número de una factura antigua no
 * tropieza con una regla de monto que entonces no existía. Una factura ANULADA
 * admite corregir sus datos pero no su cobertura ni su estado: la anulación es
 * definitiva y ya no cubre nada. Para anular está su propia acción (pide motivo).
 */
const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = Number.isInteger(id) && id > 0 ? await prisma.tbl_facturas.findUnique({ where: { id } }) : null;
    if (!previo || previo.estado === 0) return res.status(404).json({ error: 'Factura no encontrada' });
    const d = req.body || {};

    const data = {};
    if (d.tipo_comprobante !== undefined) {
      if (!esTipoComprobanteValido(d.tipo_comprobante)) {
        return res.status(400).json({ error: `Tipo de comprobante inválido. Valores permitidos: ${TIPOS_COMPROBANTE_CODIGOS.join(', ')}` });
      }
      data.tipo_comprobante = normalizarTipoComprobante(d.tipo_comprobante);
    }
    if (d.numero_factura !== undefined) {
      const numero = String(d.numero_factura ?? '').trim();
      if (!numero) return res.status(400).json({ error: 'El número de comprobante es obligatorio' });
      if (numero.length > 50) return res.status(400).json({ error: 'El número de comprobante admite hasta 50 caracteres' });
      data.numero_factura = numero;
    }
    if (d.fecha_emision !== undefined) {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha_emision ?? '')) ? parseYMDLima(d.fecha_emision) : null;
      if (!fecha || isNaN(fecha.getTime())) return res.status(400).json({ error: 'Fecha de emisión inválida' });
      data.fecha_emision = fecha;
    }
    if (d.monto !== undefined) {
      const monto = d.monto === null || d.monto === '' ? NaN : Number(d.monto);
      if (!Number.isFinite(monto) || monto < 0) return res.status(400).json({ error: 'Monto inválido' });
      data.monto = Math.round(monto * 100) / 100;
    }
    if (d.id_cuota !== undefined) {
      const idCuota = d.id_cuota === null || d.id_cuota === '' ? null : Number(d.id_cuota);
      if (idCuota !== null && (!Number.isInteger(idCuota) || idCuota <= 0)) return res.status(400).json({ error: 'Cuota inválida' });
      data.id_cuota = idCuota;
    }
    if (d.estado_factura !== undefined) {
      if (!esEstadoFacturaValido(d.estado_factura)) {
        return res.status(400).json({ error: `Estado inválido. Permitidos: ${ESTADOS_FACTURA.join(', ')}` });
      }
      if (d.estado_factura === ESTADO_FACTURA_ANULADA && previo.estado_factura !== ESTADO_FACTURA_ANULADA) {
        return res.status(400).json({ error: 'Para anular la factura usa la acción «Anular», que registra el motivo.' });
      }
      data.estado_factura = d.estado_factura;
    }

    const cambios = Object.fromEntries(Object.entries(data).filter(([k, v]) => !mismoValor(k, previo[k], v)));
    if (Object.keys(cambios).length === 0) return res.json({ data: previo });

    const cambiaCobertura = 'id_cuota' in cambios;
    const cambiaEstado = 'estado_factura' in cambios;
    if (previo.estado_factura === ESTADO_FACTURA_ANULADA && (cambiaCobertura || cambiaEstado)) {
      return res.status(400).json({
        error: 'La factura está anulada: se pueden corregir sus datos y archivos, pero no su cobertura ni su estado. Emite una nueva desde el cobro.'
      });
    }
    if (previo.estado_factura !== ESTADO_FACTURA_ANULADA && (cambiaCobertura || 'monto' in cambios)) {
      const ctx = await contextoCoberturaDeFactura(previo);
      if (!ctx) return res.status(400).json({ error: 'La factura no está ligada a un servicio ni a un plan.' });
      const error = await validarCoberturaFactura({
        ...ctx,
        idCuota: cambiaCobertura ? cambios.id_cuota : previo.id_cuota,
        monto: 'monto' in cambios ? cambios.monto : previo.monto,
        excluirId: id
      });
      if (error) return res.status(400).json({ error });
    }

    const factura = await prisma.tbl_facturas.update({
      where: { id },
      data: { ...cambios, user_id_modification: req.user.id, date_time_modification: new Date() }
    });

    // Lo que mueve la facturación del servicio (o de los mantenimientos del mes
    // del plan): qué cubre la factura, su estado y su monto.
    if (cambiaCobertura || cambiaEstado || 'monto' in cambios) {
      if (previo.id_servicio) {
        await sincronizarServicioTrasFactura(previo.id_servicio, req.user.id, `Factura ${factura.numero_factura} editada`);
      }
      if (previo.id_mantenimiento_plan) await sincronizarServiciosDelPlan(previo.id_mantenimiento_plan, req.user.id);
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_facturas', id_entidad: id, accion: 'UPDATE',
      valor_anterior: Object.fromEntries(Object.keys(cambios).map(k => [k, previo[k]])),
      valor_nuevo: cambios,
      ip: req.ip
    });
    res.json({ data: factura });
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error('[facturas.actualizar]', err);
    res.status(500).json({ error: 'Error al editar la factura' });
  }
};

module.exports = {
  listar, obtener, crear, cambiarEstado, eliminar, actualizar, contextoEdicion,
  listarDocumentos, agregarDocumentos, editarDocumento, eliminarDocumento,
  adjuntarComprobante, quitarComprobante
};

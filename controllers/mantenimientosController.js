const prisma = require('../config/prisma');
const { ESTADO_EVENTO_PROGRAMADO, ESTADO_EVENTO_CANCELADO } = require('../utils/estadoEvento');
const { registrarAuditoria } = require('../utils/auditoria');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { combinarFechaHoraLima, parseYMDLima, parseYMDFinDiaLima, ymdLima, ymdDeFecha, finDelDiaLima, inicioDelDiaLima } = require('../utils/tiempo');
const { sincronizarRecordatorioMantenimientoPlan, sincronizarRecordatorioServicio, COLORES } = require('../utils/recordatoriosAuto');
const { paginar } = require('../utils/paginacion');
const { FRECUENCIAS, obtenerFrecuencia, calcularFechasProgramacion } = require('../utils/frecuenciaMantenimiento');
const { derivarEjecucion } = require('../utils/ejecucionFechas');
const { validarPertenenciaAscensores, preciosConfiguradosPorAscensor, repartirProporcional } = require('../utils/ascensoresMonto');
const { MONEDA_POR_DEFECTO } = require('../utils/catalogosBancarios');
const { crearCobroInicial } = require('../utils/crearCobroInicial');
const { estaServicioFinalizado, esServicioEditable } = require('../utils/estadoServicio');
const { ESTADO_PLAN_ACTIVO, ESTADO_PLAN_CANCELADO } = require('../utils/estadoPlanMantenimiento');
const { bajaServicioCascadaEnTx, bajaArchivoEnTx, liberarTecnicos } = require('../utils/reversionEliminacion');

// Un plan admite cupo de mantenimientos gratuitos solo si su subtipo pertenece
// al módulo Mantenimientos (preventivo). SSoT: se deriva de modulo_asociado.
const esModuloMantenimiento = (tipoServicio) => tipoServicio?.modulo_asociado === 'mantenimiento';
const { idTecnicoFiltro, whereServicioGeneradoAsignadoSiTecnico } = require('../utils/visibilidadCalendario');
const { visibilidadPorJunctionWhere, aplicarVisibilidadWhere } = require('../utils/visibilidadEdificio');
const { porJunctionAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');
const { puedeVerPrecio } = require('../middleware/rbacMiddleware');

const COLOR_MANTENIMIENTO = COLORES.mantenimiento;

const listarFrecuencias = (_req, res) => {
  res.json({ data: FRECUENCIAS.map(({ codigo, etiqueta, unidad }) => ({ codigo, etiqueta, unidad })) });
};

const listar = async (req, res) => {
  try {
    const { q } = req.query || {};
    const where = { estado: 1 };
    if (q) where.OR = [
      // Nombre del cliente
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      // Edificio / obra, código y tipo de alguno de los ascensores del plan
      { ascensores: { some: { estado: 1, ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } } } },
      { ascensores: { some: { estado: 1, ascensor: { edificio: { distrito: { contains: q, mode: 'insensitive' } } } } } },
      { ascensores: { some: { estado: 1, ascensor: { codigo: { contains: q, mode: 'insensitive' } } } } },
      { ascensores: { some: { estado: 1, ascensor: { tipo: { contains: q, mode: 'insensitive' } } } } },
      // Tipo de servicio
      { tipo_servicio: { nombre: { contains: q, mode: 'insensitive' } } },
      // Algún servicio generado por este plan
      { servicios_generados: { some: { estado: 1, codigo: { contains: q, mode: 'insensitive' } } } }
    ];
    // Técnico: solo planes con al menos una instancia (servicio generado) donde
    // tenga asignación activa.
    const filtroPlanesTecnico = whereServicioGeneradoAsignadoSiTecnico(req.user);
    if (filtroPlanesTecnico) where.servicios_generados = filtroPlanesTecnico;
    // Oculta a roles distintos de super_admin los planes de edificios inactivos.
    aplicarVisibilidadWhere(where, visibilidadPorJunctionWhere(req.user));
    // Alcance por tipo de edificio (Administrador acotado a Edificios u Obras).
    conAlcance(where, porJunctionAscensorEdificioWhere(req.user));
    const result = await paginar(
      prisma.tbl_mantenimientos_planes,
      {
        where,
        orderBy: { id: 'desc' },
        include: {
          cliente: true,
          ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: true } } } },
          tipo_servicio: true,
          // Cobro ÚNICO del plan (facturación a nivel de plan).
          cobro: { select: { id: true, monto_total: true, total_abonado: true, saldo_pendiente: true, estado_cobro: true, moneda: true } },
          servicios_generados: {
            where: { estado: 1 },
            select: {
              id: true,
              es_mantenimiento_gratuito: true,
              servicio_realizado: { select: { id: true, estado: true } }
            }
          }
        }
      },
      req.query
    );
    const data = result.data.map(plan => {
      const servicios = plan.servicios_generados || [];
      const ejecutadosTodos = servicios.filter(s => s.servicio_realizado && s.servicio_realizado.estado === 1).length;
      const ejecutadosGratuitos = servicios.filter(s =>
        s.es_mantenimiento_gratuito === 1 && s.servicio_realizado && s.servicio_realizado.estado === 1
      ).length;
      const { servicios_generados, ...rest } = plan;
      return {
        ...rest,
        mantenimientos_gratuitos_ejecutados: ejecutadosGratuitos,
        mantenimientos_ejecutados_total: ejecutadosTodos,
        tipo_servicio: plan.tipo_servicio
          ? { ...plan.tipo_servicio, es_preventivo: esModuloMantenimiento(plan.tipo_servicio) }
          : null
      };
    });
    res.json({ ...result, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar mantenimientos' });
  }
};

/**
 * Construye el payload de un evento de calendario para una fecha de programación.
 */
function _eventoPlan({ plan, fecha, fechaInicio, codigoServicio, idServicio, tituloBase }) {
  const titulo = codigoServicio
    ? `${codigoServicio} – ${tituloBase}`
    : tituloBase;
  return {
    id_servicio: idServicio || null,
    id_mantenimiento_plan: plan.id,
    titulo,
    tipo_evento: 'mantenimiento',
    // `fechaInicio` (instante absoluto) gana cuando la ocurrencia se reagenda;
    // si no, se calcula desde la fecha + hora del plan.
    fecha_inicio: fechaInicio || combinarFechaHoraLima(fecha, plan.hora_programada),
    estado_evento: ESTADO_EVENTO_PROGRAMADO,
    color: COLOR_MANTENIMIENTO
  };
}

/**
 * Crea un evento de calendario (tipo 'mantenimiento') para cada servicio de la
 * ocurrencia SALVO el primero, que ya tiene su propio evento (el de la
 * ocurrencia). Sin esto, los N-1 servicios restantes de un plan multi-ascensor
 * solo se verían en el calendario vía su recordatorio auto (tipo 'servicio'),
 * apareciendo como "Servicio" y con otra nomenclatura. Con un evento por
 * servicio, los N se ven como "Mantenimiento" con el mismo formato de título y
 * sus recordatorios quedan deduplicados por el calendario.
 *
 * `servicios[0]` es el principal (ya tiene evento); se omite aquí.
 */
async function _crearEventosServiciosSecundarios(tx, { plan, servicios, fecha, fechaInicio, tituloBase }) {
  const secundarios = servicios.slice(1);
  if (secundarios.length === 0) return;
  await Promise.all(secundarios.map(s =>
    tx.tbl_calendario_eventos.create({
      data: _eventoPlan({ plan, fecha, fechaInicio, codigoServicio: s.codigo, idServicio: s.id, tituloBase })
    })
  ));
}

/**
 * Crea los eventos programados (sin servicio) para las fechas indicadas.
 */
async function _crearEventosFuturos(tx, plan, fechas, tituloBase) {
  if (!fechas.length) return [];
  return Promise.all(fechas.map(fecha =>
    tx.tbl_calendario_eventos.create({
      data: _eventoPlan({ plan, fecha, tituloBase })
    })
  ));
}

/**
 * Valida y normaliza el body de creación/actualización de plan.
 * Para tipo_plan = eventual fuerza frecuencia/cantidad a null.
 * Para tipo_plan = continuo exige frecuencia válida y cantidad >= 1.
 *
 * `tipoServicio` se usa para validar el cupo gratuito (solo permitido en planes
 * cuyo subtipo pertenece al módulo Mantenimientos).
 */
function _normalizarPlanInput(d, tipoServicio) {
  const tipo_plan = d.tipo_plan === 'eventual' ? 'eventual' : 'continuo';
  const esPreventivo = esModuloMantenimiento(tipoServicio);

  const gratuitosRaw = d.cantidad_mantenimientos_gratuitos;
  let cantidad_mantenimientos_gratuitos = 0;
  if (gratuitosRaw !== undefined && gratuitosRaw !== null && gratuitosRaw !== '') {
    const g = Number(gratuitosRaw);
    if (!Number.isInteger(g) || g < 0) {
      throw new Error('cantidad_mantenimientos_gratuitos debe ser un entero >= 0');
    }
    cantidad_mantenimientos_gratuitos = g;
  }
  if (cantidad_mantenimientos_gratuitos > 0 && !esPreventivo) {
    throw new Error('Solo los planes del módulo Mantenimientos pueden tener mantenimientos gratuitos');
  }

  if (tipo_plan === 'eventual') {
    if (cantidad_mantenimientos_gratuitos > 1) {
      throw new Error('Un plan eventual puede tener como máximo 1 mantenimiento gratuito');
    }
    return {
      tipo_plan,
      frecuencia: null,
      frecuencia_dias_custom: null,
      cantidad_mantenimientos: null,
      cantidad_mantenimientos_gratuitos
    };
  }
  const frecuencia = d.frecuencia;
  if (!obtenerFrecuencia(frecuencia)) {
    throw new Error('Frecuencia inválida para plan continuo');
  }
  const cantidad = Number(d.cantidad_mantenimientos);
  if (!Number.isInteger(cantidad) || cantidad < 1) {
    throw new Error('cantidad_mantenimientos debe ser un entero >= 1');
  }
  if (cantidad_mantenimientos_gratuitos > cantidad) {
    throw new Error('cantidad_mantenimientos_gratuitos no puede ser mayor a cantidad_mantenimientos');
  }
  let frecuencia_dias_custom = null;
  if (frecuencia === 'custom') {
    const dc = Number(d.frecuencia_dias_custom);
    if (!Number.isInteger(dc) || dc <= 0) {
      throw new Error('frecuencia_dias_custom debe ser un entero positivo cuando frecuencia es "custom"');
    }
    frecuencia_dias_custom = dc;
  }
  return {
    tipo_plan,
    frecuencia,
    frecuencia_dias_custom,
    cantidad_mantenimientos: cantidad,
    cantidad_mantenimientos_gratuitos
  };
}

/**
 * Nombre del edificio/obra de un plan, tomado del primer ascensor (de la junction)
 * que tenga edificio con nombre. Requiere que `ascensores` venga incluido con
 * `ascensor.edificio`.
 */
function _edificioNombrePlan(ascensoresJunction) {
  return (ascensoresJunction || []).map(a => a.ascensor?.edificio?.nombre).find(Boolean) || null;
}

/**
 * Nomenclatura corta del mantenimiento generado por un plan: "Mant. <Edificio/Obra>".
 * El tipo de servicio y la frecuencia se muestran en sus propias columnas/campos,
 * así que no se repiten en el título. Sin edificio, cae a "Mantenimiento".
 */
function _tituloBase(edificioNombre) {
  return edificioNombre ? `Mant. ${edificioNombre}` : 'Mantenimiento';
}

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_cliente || !d.id_tipo_servicio || !d.fecha_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const tipoServicio = await prisma.tbl_tipos_servicio.findUnique({ where: { id: Number(d.id_tipo_servicio) } });

    // El precio NO se hereda del cliente: cada ascensor tiene el suyo por subtipo
    // de servicio (tbl_ascensores_precios), configurable desde la ficha del
    // ascensor o desde el propio modal del plan. El monto se lee de la base y se
    // ignora el que venga en el body, para que un cliente HTTP no pueda fijarlo.
    const idsAscensores = (Array.isArray(d.ascensores) ? d.ascensores : []).map(a => a?.id_ascensor);

    const pertenencia = await validarPertenenciaAscensores(idsAscensores, d.id_cliente);
    if (!pertenencia.ok) return res.status(400).json({ error: pertenencia.error });

    const validacion = await preciosConfiguradosPorAscensor(idsAscensores, d.id_tipo_servicio);
    if (!validacion.ok) return res.status(400).json({ error: validacion.error });

    let normalizado;
    try {
      normalizado = _normalizarPlanInput(d, tipoServicio);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // El primer servicio del plan es el ordinal 1: si el cupo gratuito >= 1
    // se crea como mantenimiento gratuito (sin generar cobro automático).
    const primerServicioGratuito = normalizado.cantidad_mantenimientos_gratuitos >= 1;

    const resultado = await prisma.$transaction(async (tx) => {
      const monedaServicio = validacion.moneda;
      const plan = await tx.tbl_mantenimientos_planes.create({
        data: {
          id_cliente: Number(d.id_cliente),
          id_tipo_servicio: Number(d.id_tipo_servicio),
          ...normalizado,
          fecha_inicio: parseYMDLima(d.fecha_inicio),
          hora_programada: d.hora_programada || null,
          estado_plan: ESTADO_PLAN_ACTIVO,
          observaciones: d.observaciones || null,
          user_id_registration: req.user.id,
          ascensores: {
            create: validacion.items.map(it => ({
              id_ascensor: it.id_ascensor,
              monto: it.monto,
              moneda: monedaServicio,
              user_id_registration: req.user.id
            }))
          }
        }
      });

      // Edificio/obra y códigos de ascensor (para el título corto y por servicio).
      const ascData = await tx.tbl_ascensores.findMany({
        where: { id: { in: validacion.items.map(it => it.id_ascensor) } },
        select: { id: true, codigo: true, edificio: { select: { nombre: true } } }
      });
      const ascById = new Map(ascData.map(a => [a.id, a]));
      const tituloBase = _tituloBase(ascData.map(a => a.edificio?.nombre).find(Boolean) || null);
      const fechaProgramada = parseYMDLima(d.fecha_inicio);

      // Un servicio por ascensor (cada uno con su parte del precio del catálogo).
      // El cobro NO se crea por servicio: es único a nivel de plan (abajo).
      const ascItems = validacion.items.map(it => ({
        id_ascensor: it.id_ascensor,
        monto: it.monto,
        moneda: monedaServicio,
        codigo: ascById.get(it.id_ascensor)?.codigo || null
      }));
      const servicios = await _crearServiciosOcurrencia(tx, {
        plan, tituloBase, ascItems, fechaProgramada,
        horaProgramada: d.hora_programada || null,
        esGratuito: primerServicioGratuito, userId: req.user.id
      });
      const servicioPrincipal = servicios[0];

      // Evento de calendario de la ocurrencia: ligado al primer servicio (mantiene
      // la invariante 1 evento ↔ servicio "materializado" del motor del plan).
      await tx.tbl_calendario_eventos.create({
        data: _eventoPlan({ plan, fecha: plan.fecha_inicio, codigoServicio: servicioPrincipal.codigo, idServicio: servicioPrincipal.id, tituloBase })
      });
      // Un evento más por cada ascensor adicional, para que los N servicios del
      // plan se vean todos como "Mantenimiento" con la misma nomenclatura.
      await _crearEventosServiciosSecundarios(tx, { plan, servicios, fecha: plan.fecha_inicio, tituloBase });

      // Cobro ÚNICO del plan que CRECE por periodo aprobado. Nace VACÍO (monto 0,
      // sin cuotas): cada periodo (ocurrencia) que el admin aprueba desde
      // `aprobarPeriodo` le añade una cuota por el total de ese periodo (suma de
      // todos los ascensores) y sube el total del cobro. Así el cliente nunca
      // aparece debiendo periodos aún no ejecutados, y por periodo se genera una
      // sola factura y un solo pago.
      await crearCobroInicial(tx, {
        idMantenimientoPlan: plan.id,
        idCliente: plan.id_cliente,
        monto: 0,
        moneda: monedaServicio,
        fechaCuotaUnica: plan.fecha_inicio,
        sinCuotas: true,
        idUsuario: req.user.id
      });

      let eventosFuturos = [];
      if (plan.tipo_plan === 'continuo' && plan.cantidad_mantenimientos > 1) {
        const fechas = calcularFechasProgramacion(
          plan.fecha_inicio,
          plan.frecuencia,
          plan.frecuencia_dias_custom,
          plan.cantidad_mantenimientos
        ).slice(1);
        eventosFuturos = await _crearEventosFuturos(tx, plan, fechas, tituloBase);
      }

      return { plan, servicios, servicio: servicioPrincipal, eventos_futuros: eventosFuturos.length };
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_mantenimientos_planes', id_entidad: resultado.plan.id,
      accion: 'CREATE', valor_nuevo: resultado.plan, ip: req.ip
    });
    sincronizarRecordatorioMantenimientoPlan(resultado.plan.id).catch(err => console.error('Sync rec mant:', err));
    for (const s of resultado.servicios) {
      sincronizarRecordatorioServicio(s.id).catch(err => console.error('Sync rec servicio:', err));
    }
    res.status(201).json({ data: resultado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear mantenimiento: ' + err.message });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_mantenimientos_planes.findUnique({
      where: { id },
      include: { tipo_servicio: true }
    });
    if (!previo) return res.status(404).json({ error: 'No encontrado' });

    // Cliente y ascensores son inmutables: ya existen servicios materializados
    // apuntando al cliente y a los ascensores originales. Cambiarlos rompería
    // historial y reportes; para otro cliente o conjunto de ascensores se crea
    // un plan nuevo.
    if (d.id_cliente !== undefined && Number(d.id_cliente) !== previo.id_cliente) {
      return res.status(409).json({ error: 'El cliente del plan no se puede cambiar. Cree un plan nuevo para otro cliente.' });
    }
    if (d.ascensores !== undefined) {
      return res.status(409).json({ error: 'Los ascensores del plan no se pueden cambiar. Cree un plan nuevo para otro conjunto de ascensores.' });
    }

    const idTipoFinal = d.id_tipo_servicio ? Number(d.id_tipo_servicio) : previo.id_tipo_servicio;
    const tipoServicioFinal = idTipoFinal === previo.id_tipo_servicio
      ? previo.tipo_servicio
      : await prisma.tbl_tipos_servicio.findUnique({ where: { id: idTipoFinal } });

    const tipoPlanFinal = d.tipo_plan ?? previo.tipo_plan;
    const mergeInput = {
      tipo_plan: tipoPlanFinal,
      frecuencia: d.frecuencia ?? previo.frecuencia,
      frecuencia_dias_custom: d.frecuencia_dias_custom ?? previo.frecuencia_dias_custom,
      cantidad_mantenimientos: d.cantidad_mantenimientos ?? previo.cantidad_mantenimientos,
      cantidad_mantenimientos_gratuitos: d.cantidad_mantenimientos_gratuitos ?? previo.cantidad_mantenimientos_gratuitos
    };
    let normalizado;
    try {
      normalizado = _normalizarPlanInput(mergeInput, tipoServicioFinal);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const nuevaFechaInicio = d.fecha_inicio ? parseYMDLima(d.fecha_inicio) : previo.fecha_inicio;
    const requiereRegenerar = normalizado.tipo_plan === 'continuo' && (
      normalizado.tipo_plan !== previo.tipo_plan ||
      normalizado.frecuencia !== previo.frecuencia ||
      Number(normalizado.frecuencia_dias_custom || 0) !== Number(previo.frecuencia_dias_custom || 0) ||
      Number(normalizado.cantidad_mantenimientos) !== Number(previo.cantidad_mantenimientos) ||
      nuevaFechaInicio.getTime() !== previo.fecha_inicio.getTime()
    );

    const cambiaAEventual = normalizado.tipo_plan === 'eventual' && previo.tipo_plan !== 'eventual';

    const planActualizado = await prisma.$transaction(async (tx) => {
      const plan = await tx.tbl_mantenimientos_planes.update({
        where: { id },
        data: {
          id_tipo_servicio: idTipoFinal,
          ...normalizado,
          fecha_inicio: nuevaFechaInicio,
          hora_programada: d.hora_programada ?? previo.hora_programada,
          estado_plan: d.estado_plan ?? previo.estado_plan,
          observaciones: d.observaciones ?? previo.observaciones,
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });

      if (cambiaAEventual || requiereRegenerar) {
        // Eliminar eventos futuros NO materializados (sin servicio) del plan.
        await tx.tbl_calendario_eventos.deleteMany({
          where: {
            id_mantenimiento_plan: id,
            id_servicio: null
          }
        });
      }

      if (requiereRegenerar && plan.cantidad_mantenimientos > 1) {
        const primerAsc = await tx.tbl_mantenimientos_planes_ascensores.findFirst({
          where: { id_plan: plan.id, estado: 1 },
          include: { ascensor: { include: { edificio: { select: { nombre: true } } } } }
        });
        const tituloBase = _tituloBase(primerAsc?.ascensor?.edificio?.nombre || null);
        const fechasTeoricas = calcularFechasProgramacion(
          plan.fecha_inicio,
          plan.frecuencia,
          plan.frecuencia_dias_custom,
          plan.cantidad_mantenimientos
        );
        // Tras borrar los eventos no materializados, en BD solo quedan los
        // que ya tienen `id_servicio` (mantenimientos realizados o en curso).
        // No podemos recrear eventos en esas mismas fechas porque eso duplica
        // el servicio: aparecería una segunda entrada del mismo mes en el
        // detalle del plan (bug observado al ampliar cupo / cantidad sobre un
        // plan con mantenimientos ya ejecutados).
        //
        // Importante usar `ymdDeFecha` y NO `ymdLima`. Las fechas teóricas
        // vienen como Date 00:00 UTC (plan.fecha_inicio se almacena con
        // `@db.Date`), y `ymdLima` las corre un día atrás al aplicar el huso
        // de Lima. `ymdDeFecha` detecta el caso "fecha pura" y usa los UTC*
        // getters para devolver el YMD almacenado tal cual; para los eventos
        // del calendario (instante absoluto con hora real) cae en `ymdLima`
        // como corresponde. Sin esto el `Set` nunca matchea y el filtro no
        // descarta nada → duplicación.
        const eventosVigentes = await tx.tbl_calendario_eventos.findMany({
          where: { id_mantenimiento_plan: plan.id, estado: 1 },
          select: { fecha_inicio: true }
        });
        const ymdOcupados = new Set(eventosVigentes.map(e => ymdDeFecha(e.fecha_inicio)));
        const fechasACrear = fechasTeoricas.filter(f => !ymdOcupados.has(ymdDeFecha(f)));
        await _crearEventosFuturos(tx, plan, fechasACrear, tituloBase);
      }

      return plan;
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_mantenimientos_planes', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: planActualizado, ip: req.ip
    });
    sincronizarRecordatorioMantenimientoPlan(id).catch(err => console.error('Sync rec mant:', err));
    res.json({ data: planActualizado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar mantenimiento: ' + err.message });
  }
};

/**
 * Crea N servicios (uno por ascensor) para una ocurrencia del plan. Cada servicio
 * cubre un solo ascensor con su parte del precio (su monto del plan) y queda listo
 * para asignarle su propio técnico. La facturación NO ocurre por servicio: es un
 * único cobro a nivel de plan (ver crear()), por eso estos servicios no generan
 * cobro propio al finalizar (gate por id_mantenimiento_plan en serviciosController).
 *
 * @param {Array<{id_ascensor:number, monto:number, moneda:string, codigo?:string}>} ascItems
 * @returns {Promise<Array>} servicios creados (orden = el de ascItems).
 */
async function _crearServiciosOcurrencia(tx, { plan, tituloBase, ascItems, fechaProgramada, horaProgramada, esGratuito, userId }) {
  const servicios = [];
  for (const a of ascItems) {
    // tx-aware: ve los servicios ya creados en esta misma transacción → sin colisión
    // de correlativo al crear N servicios (uno por ascensor) en el mismo tx.
    const codigo = await generarCodigoServicio('servicio', tx);
    const monto = Number(a.monto);
    const moneda = a.moneda || MONEDA_POR_DEFECTO;
    // Título por servicio: distingue el ascensor para que el coordinador asigne
    // el técnico al servicio correcto. Sin código de ascensor, cae a tituloBase.
    const titulo = a.codigo ? `${tituloBase} · ${a.codigo}` : tituloBase;
    const s = await tx.tbl_servicios_proyectos.create({
      data: {
        codigo,
        tipo_registro: 'servicio',
        id_tipo_servicio: plan.id_tipo_servicio,
        id_cliente: plan.id_cliente,
        id_mantenimiento_plan: plan.id,
        origen: 'mantenimiento',
        titulo,
        descripcion: plan.observaciones || null,
        fecha_programada: fechaProgramada,
        hora_programada: horaProgramada,
        prioridad: 'media',
        estado_servicio: 'Pendiente',
        precio_interno: monto,
        moneda,
        sin_cobro: esGratuito ? 1 : 0,
        es_mantenimiento_gratuito: esGratuito ? 1 : 0,
        // La factura del plan es ÚNICA por periodo (cuota del cobro del plan):
        // estos servicios NO se facturan uno a uno, así que no deben contarse
        // como "pendientes por facturar" en Contabilidad ni en el dashboard.
        requiere_factura: 0,
        user_id_registration: userId,
        ascensores: {
          create: [{ id_ascensor: a.id_ascensor, monto, moneda, user_id_registration: userId }]
        }
      }
    });
    servicios.push(s);
  }
  return servicios;
}

/**
 * Ordinal de ocurrencia (1-based) para una fecha dada: cantidad de fechas de
 * ocurrencia DISTINTAS del plan estrictamente anteriores, + 1. Como cada
 * ocurrencia genera N servicios (uno por ascensor), contar servicios sobrecontaría
 * el cupo gratuito; por eso se cuentan fechas distintas.
 */
async function _ordinalOcurrencia(tx, idPlan, fechaProgramada) {
  const previas = await tx.tbl_servicios_proyectos.findMany({
    where: { id_mantenimiento_plan: idPlan, estado: 1, fecha_programada: { lt: fechaProgramada } },
    select: { fecha_programada: true },
    distinct: ['fecha_programada']
  });
  return previas.length + 1;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Estado de facturación de un plan de mantenimiento, agrupado por PERIODO
 * (= ocurrencia de la frecuencia; todos los servicios de una ocurrencia comparten
 * `fecha_programada`). Un periodo es la unidad de facturación: se factura una sola
 * vez por el total de todos sus ascensores. Fuente única usada por `listarPeriodos`,
 * `aprobarPeriodo`, `ajustarPeriodo` y la detección de "periodo completo".
 *
 * Por cada periodo devuelve: ordinal, fecha (YMD), servicios (no cancelados),
 * total_servicios, done (finalizados), total_monto (suma de precio_interno),
 * es_gratuito, completo (done === total), la `cuota` del cobro del plan asociada
 * (mapeada por fecha de vencimiento = fecha de ocurrencia) y el `estado_periodo`
 * (pendiente | completo | aprobado | facturado | pagado).
 *
 * @param {object} client - prisma o tx
 * @param {number} idPlan
 */
async function _periodosDelPlan(client, idPlan) {
  const plan = await client.tbl_mantenimientos_planes.findUnique({
    where: { id: Number(idPlan) },
    select: { id: true, cantidad_mantenimientos_gratuitos: true, cobro: { select: { id: true } } }
  });
  if (!plan) return { id_cobro: null, cupo_gratuito: 0, periodos: [] };

  // Servicios del plan, excluyendo cancelados: un periodo con un servicio cancelado
  // se puede completar con los restantes.
  const servicios = await client.tbl_servicios_proyectos.findMany({
    where: { id_mantenimiento_plan: Number(idPlan), estado: 1, estado_servicio: { not: 'Cancelado' } },
    select: { id: true, codigo: true, estado_servicio: true, precio_interno: true, moneda: true, sin_cobro: true, fecha_programada: true },
    orderBy: { fecha_programada: 'asc' }
  });

  const cuotas = plan.cobro
    ? await client.tbl_cobros_cuotas.findMany({
        where: { id_cobro: plan.cobro.id, estado: 1 },
        select: { id: true, numero_cuota: true, fecha_vencimiento: true, monto: true, monto_pagado: true, estado_cuota: true }
      })
    : [];
  const facturas = plan.cobro
    ? await client.tbl_facturas.findMany({
        where: { id_mantenimiento_plan: Number(idPlan), estado: 1, id_cuota: { not: null } },
        select: { id_cuota: true }
      })
    : [];
  const cuotaFacturada = new Set(facturas.map(f => f.id_cuota));

  // Agrupar servicios por fecha de ocurrencia (YMD Lima).
  const porFecha = new Map();
  for (const s of servicios) {
    const ymd = ymdLima(s.fecha_programada);
    if (!porFecha.has(ymd)) porFecha.set(ymd, []);
    porFecha.get(ymd).push(s);
  }
  const cupoGratuito = Number(plan.cantidad_mantenimientos_gratuitos || 0);
  const fechas = [...porFecha.keys()].sort();

  const periodos = fechas.map((ymd, idx) => {
    const grupo = porFecha.get(ymd);
    const ordinal = idx + 1;
    const total_servicios = grupo.length;
    const done = grupo.filter(s => estaServicioFinalizado(s.estado_servicio)).length;
    const total_monto = round2(grupo.reduce((a, s) => a + Number(s.precio_interno || 0), 0));
    const es_gratuito = grupo.every(s => s.sin_cobro === 1) || ordinal <= cupoGratuito;
    const completo = total_servicios > 0 && done === total_servicios;
    // La cuota del periodo se liga por `numero_cuota` = ordinal de la ocurrencia
    // (fijado al aprobar). Se usa el ordinal y NO la fecha porque la cuota guarda
    // `fecha_vencimiento` como @db.Date (medianoche UTC) y el servicio guarda un
    // timestamptz: pasarlos por ymdLima daría días distintos y rompería el mapeo
    // (duplicaría cuotas al re-aprobar).
    const cuota = cuotas.find(c => c.numero_cuota === ordinal) || null;
    let estado_periodo = completo ? 'completo' : 'pendiente';
    if (cuota) {
      estado_periodo = 'aprobado';
      if (cuotaFacturada.has(cuota.id)) estado_periodo = 'facturado';
      if (String(cuota.estado_cuota) === 'Pagada' || Number(cuota.monto_pagado || 0) >= Number(cuota.monto)) {
        estado_periodo = 'pagado';
      }
    }
    return {
      ordinal,
      fecha: ymd,
      moneda: grupo[0]?.moneda || null,
      total_servicios,
      done,
      total_monto,
      es_gratuito,
      completo,
      servicios: grupo.map(s => ({ id: s.id, codigo: s.codigo, estado_servicio: s.estado_servicio })),
      cuota: cuota ? { id: cuota.id, numero_cuota: cuota.numero_cuota, monto: Number(cuota.monto), monto_pagado: Number(cuota.monto_pagado || 0), estado_cuota: cuota.estado_cuota } : null,
      estado_periodo
    };
  });

  return { id_cobro: plan.cobro?.id || null, cupo_gratuito: cupoGratuito, periodos };
}

/**
 * Materializa un evento de calendario como servicio real dentro de una
 * transacción Prisma. Calcula el ordinal del servicio dentro del plan y
 * marca el flag de mantenimiento gratuito si corresponde.
 *
 * Reutilizado por:
 *   - el endpoint HTTP `materializarEvento` (acción manual desde el calendario)
 *   - `materializarSiguienteEventoDelPlan` (auto-materialización al finalizar
 *     un servicio del plan)
 */
/**
 * Materializa un evento del calendario como servicio real.
 *
 * `overrides`:
 *   - `precio`: monto a usar (editable desde el modal). Si viene, gana.
 *   - `moneda`: moneda asociada al precio.
 *   - `fecha_programada` / `hora_programada`: permiten reagendar SOLO esta
 *     instancia sin alterar el resto del plan. Si la fecha cambia, también
 *     se mueve el evento del calendario para mantener la vista coherente.
 */
async function _materializarEventoEnTx(tx, evento, plan, userId, overrides = {}) {
  const tituloBase = _tituloBase(_edificioNombrePlan(plan.ascensores));

  const horaProgramada = overrides.hora_programada || plan.hora_programada || null;
  const ymdEvento = ymdLima(evento.fecha_inicio);
  const ymdFinal = overrides.fecha_programada
    ? String(overrides.fecha_programada).substring(0, 10)
    : ymdEvento;
  const fechaProgramada = parseYMDLima(ymdFinal);
  const fechaEventoNueva = combinarFechaHoraLima(ymdFinal, horaProgramada);
  const cambioFecha = ymdEvento !== ymdFinal || evento.fecha_inicio.getTime() !== fechaEventoNueva.getTime();

  // Ascensores que cubre el plan (junction). El precio total del mantenimiento se
  // reparte entre ellos: por defecto se respetan los montos pactados en el plan;
  // si llega un override de precio (edición del total desde el modal), se reparte
  // PROPORCIONALMENTE a esos mismos montos pactados, nunca en partes iguales: con
  // precios distintos por ascensor (100 / 300) un reparto parejo falsearía el
  // desglose operativo aunque el total global cuadrara.
  const ascensoresPlan = (plan.ascensores || []).filter(a => a.estado === 1);
  if (ascensoresPlan.length === 0) {
    throw new Error('El plan no tiene ascensores asociados');
  }

  let moneda;
  let montosPorAscensor;
  if (overrides.precio !== undefined && overrides.precio !== null && overrides.precio !== '') {
    const precio = Number(overrides.precio);
    if (!Number.isFinite(precio) || precio < 0) {
      throw new Error('Precio inválido');
    }
    moneda = overrides.moneda || ascensoresPlan[0].moneda || MONEDA_POR_DEFECTO;
    montosPorAscensor = repartirProporcional(precio, ascensoresPlan.map(a => Number(a.monto)));
  } else {
    montosPorAscensor = ascensoresPlan.map(a => Number(a.monto));
    moneda = ascensoresPlan[0].moneda || MONEDA_POR_DEFECTO;
  }

  const cupoGratuito = Number(plan.cantidad_mantenimientos_gratuitos || 0);
  const esPreventivo = esModuloMantenimiento(plan.tipo_servicio);

  let esGratuito = false;
  if (esPreventivo && cupoGratuito > 0) {
    // Ordinal por OCURRENCIA (fechas distintas), no por cantidad de servicios:
    // cada ocurrencia genera N servicios (uno por ascensor).
    const ordinal = await _ordinalOcurrencia(tx, plan.id, fechaProgramada);
    esGratuito = ordinal <= cupoGratuito;
  }

  // Un servicio por ascensor del plan, cada uno con su parte (sin override:
  // el monto pactado; con override de precio: el reparto parejo). El cobro es
  // único a nivel de plan, así que estos servicios no generan cobro propio.
  const ascItems = ascensoresPlan.map((a, i) => ({
    id_ascensor: a.id_ascensor,
    monto: montosPorAscensor[i],
    moneda,
    codigo: a.ascensor?.codigo || null
  }));
  const servicios = await _crearServiciosOcurrencia(tx, {
    plan, tituloBase, ascItems, fechaProgramada, horaProgramada, esGratuito, userId
  });
  const servicioPrincipal = servicios[0];

  await tx.tbl_calendario_eventos.update({
    where: { id: evento.id },
    data: {
      id_servicio: servicioPrincipal.id,
      titulo: `${servicioPrincipal.codigo} – ${tituloBase}`,
      ...(cambioFecha ? { fecha_inicio: fechaEventoNueva } : {}),
      user_id_modification: userId,
      date_time_modification: new Date()
    }
  });
  // Un evento más por cada ascensor adicional de la ocurrencia (mismo instante
  // que el principal), para que los N servicios se vean como "Mantenimiento"
  // con la misma nomenclatura en vez de aparecer como recordatorios "Servicio".
  await _crearEventosServiciosSecundarios(tx, {
    plan, servicios, fechaInicio: fechaEventoNueva, tituloBase
  });

  return servicios;
}

/**
 * Convierte un evento de calendario de un plan de mantenimiento (sin servicio
 * asociado) en un servicio real listo para asignar técnico, checklist y cobro.
 */
const materializarEvento = async (req, res) => {
  try {
    const idEvento = Number(req.params.id);
    const evento = await prisma.tbl_calendario_eventos.findUnique({
      where: { id: idEvento },
      include: { mantenimiento_plan: { include: { tipo_servicio: true, ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: { select: { nombre: true } } } } } } } } }
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });
    if (!evento.id_mantenimiento_plan) {
      return res.status(400).json({ error: 'El evento no pertenece a un plan de mantenimiento' });
    }
    if (evento.id_servicio) {
      return res.status(409).json({ error: 'Este evento ya está materializado en un servicio' });
    }
    const plan = evento.mantenimiento_plan;
    if (!plan || plan.estado !== 1) {
      return res.status(400).json({ error: 'El plan asociado no está activo' });
    }

    const overrides = {
      precio: req.body?.precio,
      moneda: req.body?.moneda,
      fecha_programada: req.body?.fecha_programada,
      hora_programada: req.body?.hora_programada
    };

    let servicios;
    try {
      servicios = await prisma.$transaction(tx => _materializarEventoEnTx(tx, evento, plan, req.user.id, overrides));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    for (const s of servicios) {
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: s.id,
        accion: 'CREATE', valor_nuevo: s, ip: req.ip
      });
      sincronizarRecordatorioServicio(s.id).catch(err => console.error('Sync rec servicio:', err));
    }
    res.status(201).json({ data: { servicios, servicio: servicios[0] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al materializar evento: ' + err.message });
  }
};

/**
 * Auto-materializa el siguiente evento futuro de un plan continuo. Se llama
 * desde `finalizarServicio` cuando se cierra un mantenimiento del plan.
 * Devuelve el servicio creado, o null si no hay siguiente evento.
 */
async function materializarSiguienteEventoDelPlan({ idPlan, fechaServicioFinalizado, userId }) {
  const plan = await prisma.tbl_mantenimientos_planes.findUnique({
    where: { id: idPlan },
    include: { tipo_servicio: true, ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: { select: { nombre: true } } } } } } }
  });
  if (!plan || plan.estado !== 1 || plan.estado_plan !== ESTADO_PLAN_ACTIVO || plan.tipo_plan !== 'continuo') {
    return null;
  }
  // `fechaServicioFinalizado` viene de `tbl_servicios_proyectos.fecha_programada`,
  // que es @db.Date → Date a 00:00 UTC. Los eventos del calendario tienen
  // `fecha_inicio` como instante absoluto con hora real (ej. 20:00Z para las
  // 15:00 Lima). Comparar con `gt: fechaServicioFinalizado` permite que un
  // evento del MISMO día cumpla el filtro (20:00Z > 00:00Z) y sea seleccionado
  // como "siguiente" — esto generaba un servicio fantasma con la misma fecha
  // que el recién finalizado. Filtramos por estricto > fin-del-día-Lima del
  // servicio finalizado para garantizar que el "siguiente" sea de otro día.
  const corte = finDelDiaLima(fechaServicioFinalizado);
  const siguienteEvento = await prisma.tbl_calendario_eventos.findFirst({
    where: {
      id_mantenimiento_plan: plan.id,
      id_servicio: null,
      estado: 1,
      fecha_inicio: { gt: corte }
    },
    orderBy: { fecha_inicio: 'asc' }
  });
  if (!siguienteEvento) return null;

  const servicios = await prisma.$transaction(tx => _materializarEventoEnTx(tx, siguienteEvento, plan, userId));
  for (const s of servicios) {
    sincronizarRecordatorioServicio(s.id).catch(err => console.error('Sync rec servicio:', err));
  }
  return servicios[0];
}

/**
 * Normaliza un filtro que puede venir como id único o lista (comma-separated)
 * a un array de Number. Devuelve null si no hay valores.
 */
function _normalizarIds(...candidatos) {
  for (const v of candidatos) {
    if (v === undefined || v === null || v === '') continue;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const nums = arr.map(x => Number(x)).filter(Number.isFinite);
    if (nums.length > 0) return nums;
  }
  return null;
}

// Horizonte por defecto para proyectar ocurrencias de planes continuos cuyo
// `cantidad_mantenimientos` esté indefinido. Cubre los 12 meses siguientes.
const HORIZONTE_DEFAULT_OCURRENCIAS = 12;

function _ymd(date) {
  if (!date) return null;
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Calcula las fechas teóricas que un plan continuo debería tener según su
 * frecuencia, recortadas opcionalmente por un rango (desde, hasta) y
 * acotadas por `cantidad_mantenimientos` cuando exista; si no existe,
 * usa HORIZONTE_DEFAULT_OCURRENCIAS.
 */
function _proyectarFechasPlanContinuo(plan, { desde, hasta }) {
  if (plan.tipo_plan !== 'continuo') return [];
  const cantidad = Number(plan.cantidad_mantenimientos);
  const cantidadEfectiva = Number.isInteger(cantidad) && cantidad >= 1
    ? cantidad
    : HORIZONTE_DEFAULT_OCURRENCIAS;
  let fechas;
  try {
    fechas = calcularFechasProgramacion(
      plan.fecha_inicio,
      plan.frecuencia,
      plan.frecuencia_dias_custom,
      cantidadEfectiva
    );
  } catch {
    return [];
  }
  const desdeLim = desde ? parseYMDLima(desde) : null;
  const hastaLim = hasta ? parseYMDFinDiaLima(hasta) : null;
  return fechas.filter(f => {
    if (desdeLim && f < desdeLim) return false;
    if (hastaLim && f > hastaLim) return false;
    return true;
  });
}

/**
 * Resume una lista de filas de junction (con `ascensor` + `edificio`) en los
 * campos de display que consumen la pestaña de instancias y los reportes:
 * arreglo de ascensores, edificio (del primero con dato), y códigos/ubicaciones/
 * tipos unidos por coma. Fuente única para no repetir el mapeo por todos lados.
 */
function _resumenAscensores(filas) {
  const ascs = (filas || []).map(f => f.ascensor).filter(Boolean);
  return {
    ascensores: ascs.map(a => ({ id: a.id, codigo: a.codigo, ubicacion: a.ubicacion, tipo: a.tipo })),
    edificio_nombre: ascs.map(a => a.edificio?.nombre).find(Boolean) || null,
    ascensor_codigo: ascs.map(a => a.codigo).filter(Boolean).join(', ') || null,
    ascensor_ubicacion: ascs.map(a => a.ubicacion).filter(Boolean).join(', ') || null,
    ascensor_tipo: ascs.map(a => a.tipo).filter(Boolean).join(', ') || null,
    ids_ascensor: ascs.map(a => a.id)
  };
}

/**
 * Obtiene las instancias de mantenimiento (materializadas + futuras) aplicando
 * filtros multi (cliente, ascensor) y rango de fechas. Helper puro usado tanto
 * por listarInstancias (pestaña) como por exportar.
 */
async function _obtenerInstanciasMantenimiento({ id_plan, ids_cliente, ids_ascensor, estado_ejecucion, desde, hasta, q, id_tecnico_filtro }) {
  const wherePlan = { estado: 1, id_mantenimiento_plan: { not: null } };
  if (id_plan) wherePlan.id_mantenimiento_plan = Number(id_plan);
  if (ids_cliente && ids_cliente.length > 0) wherePlan.id_cliente = { in: ids_cliente };
  // Técnico: solo servicios donde tenga asignación activa.
  if (id_tecnico_filtro) {
    wherePlan.asignaciones = { some: { id_tecnico: id_tecnico_filtro, estado: 1 } };
  }

  const wherePlanFecha = { ...wherePlan };
  if (desde || hasta) {
    wherePlanFecha.fecha_programada = {};
    if (desde) wherePlanFecha.fecha_programada.gte = parseYMDLima(desde);
    if (hasta) wherePlanFecha.fecha_programada.lte = parseYMDFinDiaLima(hasta);
  }

  // 1. Servicios ya materializados de planes. Los ascensores se leen de la propia
  //    junction del servicio (lo que realmente se ejecutó), no del plan.
  const servicios = await prisma.tbl_servicios_proyectos.findMany({
    where: wherePlanFecha,
    orderBy: { fecha_programada: 'desc' },
    include: {
      cliente: { select: { id: true, nombre: true } },
      tipo_servicio: { select: { id: true, nombre: true } },
      ascensores: {
        where: { estado: 1 },
        include: { ascensor: { select: { id: true, codigo: true, ubicacion: true, tipo: true, edificio: { select: { id: true, nombre: true } } } } }
      },
      mantenimiento_plan: { select: { id: true, tipo_plan: true, frecuencia: true } },
      historial_estados: { where: { estado: 1 }, orderBy: { fecha_cambio: 'asc' } },
      servicio_realizado: { select: { fecha_realizacion: true } }
    }
  });

  const instanciasServicios = servicios
    .map(s => ({ s, resumen: _resumenAscensores(s.ascensores) }))
    .filter(({ resumen }) => !ids_ascensor || resumen.ids_ascensor.some(id => ids_ascensor.includes(id)))
    .map(({ s, resumen }) => {
      const ej = derivarEjecucion(s);
      return {
        tipo_instancia: 'servicio',
        id_servicio: s.id,
        codigo_servicio: s.codigo,
        id_plan: s.id_mantenimiento_plan,
        id_cliente: s.id_cliente,
        cliente_nombre: resumen.edificio_nombre || s.cliente?.nombre || null,
        ascensores: resumen.ascensores,
        ascensor_codigo: resumen.ascensor_codigo,
        ascensor_ubicacion: resumen.ascensor_ubicacion,
        ascensor_tipo: resumen.ascensor_tipo,
        tipo_servicio: s.tipo_servicio?.nombre || null,
        es_mantenimiento_gratuito: s.es_mantenimiento_gratuito === 1,
        // Precio de ESTA ocurrencia (el del ascensor que cubre). Se sanitiza por
        // rol en `listarInstancias`; el técnico nunca lo recibe.
        precio_interno: Number(s.precio_interno || 0),
        moneda: s.moneda,
        sin_cobro: s.sin_cobro,
        estado_servicio: s.estado_servicio,
        fecha_programada: s.fecha_programada,
        estado_ejecucion: ej.estado_ejecucion,
        fecha_inicio_real: ej.fecha_inicio_real,
        fecha_fin_real: ej.fecha_fin_real,
        dias_ejecucion: ej.dias_ejecucion
      };
    });

  // 2. Eventos futuros sin servicio asociado (programación pendiente).
  // Excepción: para el técnico estos eventos no aplican porque aún no tienen
  // servicio materializado ni asignación; saltamos directamente a las
  // instancias ya materializadas.
  const whereEventos = {
    estado: 1,
    id_servicio: null,
    id_mantenimiento_plan: { not: null }
  };
  if (id_plan) whereEventos.id_mantenimiento_plan = Number(id_plan);
  if ((ids_cliente && ids_cliente.length > 0) || (ids_ascensor && ids_ascensor.length > 0)) {
    whereEventos.mantenimiento_plan = { is: {} };
    if (ids_cliente && ids_cliente.length > 0) whereEventos.mantenimiento_plan.is.id_cliente = { in: ids_cliente };
    if (ids_ascensor && ids_ascensor.length > 0) {
      whereEventos.mantenimiento_plan.is.ascensores = { some: { estado: 1, id_ascensor: { in: ids_ascensor } } };
    }
  }
  if (desde || hasta) {
    whereEventos.fecha_inicio = {};
    if (desde) whereEventos.fecha_inicio.gte = parseYMDLima(desde);
    if (hasta) whereEventos.fecha_inicio.lte = parseYMDFinDiaLima(hasta);
  }
  const eventos = id_tecnico_filtro
    ? []
    : await prisma.tbl_calendario_eventos.findMany({
        where: whereEventos,
        orderBy: { fecha_inicio: 'asc' },
        include: {
          mantenimiento_plan: {
            select: {
              id: true,
              id_cliente: true,
              cliente: { select: { id: true, nombre: true } },
              ascensores: {
                where: { estado: 1 },
                include: { ascensor: { select: { id: true, codigo: true, ubicacion: true, tipo: true, edificio: { select: { id: true, nombre: true } } } } }
              },
              tipo_servicio: { select: { id: true, nombre: true } }
            }
          }
        }
      });

  const instanciasFuturas = eventos
    .filter(e => e.mantenimiento_plan)
    .map(e => {
      const resumen = _resumenAscensores(e.mantenimiento_plan.ascensores);
      return {
        tipo_instancia: 'evento_futuro',
        id_servicio: null,
        codigo_servicio: null,
        id_evento: e.id,
        id_plan: e.id_mantenimiento_plan,
        id_cliente: e.mantenimiento_plan.id_cliente,
        cliente_nombre: resumen.edificio_nombre || e.mantenimiento_plan.cliente?.nombre || null,
        ascensores: resumen.ascensores,
        ascensor_codigo: resumen.ascensor_codigo,
        ascensor_ubicacion: resumen.ascensor_ubicacion,
        ascensor_tipo: resumen.ascensor_tipo,
        tipo_servicio: e.mantenimiento_plan.tipo_servicio?.nombre || null,
        es_mantenimiento_gratuito: false,
        fecha_programada: e.fecha_inicio,
        estado_ejecucion: 'Pendiente',
        fecha_inicio_real: null,
        fecha_fin_real: null,
        dias_ejecucion: null
      };
    });

  let todas = [...instanciasServicios, ...instanciasFuturas];
  if (estado_ejecucion) {
    todas = todas.filter(i => i.estado_ejecucion === estado_ejecucion);
  }
  if (q) {
    // Filtro libre case-insensitive sobre nombre cliente, código y tipo de
    // ascensor, código de servicio y tipo de servicio.
    const ql = String(q).toLowerCase();
    todas = todas.filter(i => {
      const campos = [
        i.cliente_nombre,
        i.ascensor_codigo,
        i.ascensor_tipo,
        i.codigo_servicio,
        i.tipo_servicio
      ];
      return campos.some(s => s && String(s).toLowerCase().includes(ql));
    });
  }
  // Orden por fecha PROGRAMADA centrado en HOY (Lima): primero los mantenimientos
  // de hoy en adelante ascendente (el más próximo arriba), luego los ya pasados
  // descendente (el más reciente primero). Los sin fecha van al final. Antes se
  // ordenaba solo descendente, lo que empujaba arriba fechas lejanas (p.ej. 2029)
  // y escondía el próximo mantenimiento a ejecutar.
  const hoyMs = inicioDelDiaLima().getTime();
  const clasificar = (i) => {
    if (!i.fecha_programada) return { grupo: 2, t: 0 };            // sin fecha: al final
    const t = new Date(i.fecha_programada).getTime();
    return { grupo: t >= hoyMs ? 0 : 1, t };                        // 0 = hoy en adelante, 1 = pasado
  };
  todas.sort((a, b) => {
    const ca = clasificar(a), cb = clasificar(b);
    if (ca.grupo !== cb.grupo) return ca.grupo - cb.grupo;
    if (ca.grupo === 0) return ca.t - cb.t;                         // próximos: ascendente
    if (ca.grupo === 1) return cb.t - ca.t;                         // pasados: descendente
    return 0;
  });
  return todas;
}

/**
 * Trae los planes activos asociados a los clientes/ascensores filtrados, con
 * agregados (mantenimientos ejecutados totales y gratuitos ejecutados) para
 * el resumen del reporte. Devuelve también ascensor y tipo_servicio.
 */
async function _obtenerPlanesParaReporte({ ids_cliente, ids_ascensor }) {
  const where = { estado: 1, estado_plan: ESTADO_PLAN_ACTIVO };
  if (ids_cliente && ids_cliente.length > 0) where.id_cliente = { in: ids_cliente };
  if (ids_ascensor && ids_ascensor.length > 0) where.ascensores = { some: { estado: 1, id_ascensor: { in: ids_ascensor } } };

  const planes = await prisma.tbl_mantenimientos_planes.findMany({
    where,
    orderBy: [{ id_cliente: 'asc' }, { id: 'asc' }],
    include: {
      cliente: true,
      ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: { select: { id: true, nombre: true, distrito: true } } } } } },
      tipo_servicio: true,
      servicios_generados: {
        where: { estado: 1 },
        select: {
          id: true,
          es_mantenimiento_gratuito: true,
          servicio_realizado: { select: { id: true, estado: true } }
        }
      }
    }
  });
  return planes.map(p => {
    const servicios = p.servicios_generados || [];
    const ejecutados = servicios.filter(s => s.servicio_realizado && s.servicio_realizado.estado === 1).length;
    const gratuitosEjecutados = servicios.filter(s =>
      s.es_mantenimiento_gratuito === 1 && s.servicio_realizado && s.servicio_realizado.estado === 1
    ).length;
    const { servicios_generados, ...rest } = p;
    return {
      ...rest,
      mantenimientos_ejecutados_total: ejecutados,
      mantenimientos_gratuitos_ejecutados: gratuitosEjecutados,
      tipo_servicio: p.tipo_servicio
        ? { ...p.tipo_servicio, es_preventivo: esModuloMantenimiento(p.tipo_servicio) }
        : null
    };
  });
}

/**
 * Lista TODAS las instancias de mantenimiento (materializadas + futuras)
 * de los planes activos. Cada fila incluye el estado de ejecución, fechas
 * reales y días de ejecución. Usado por la pestaña "Mantenimientos" del módulo.
 *
 * Filtros opcionales por query: id_plan, id_cliente, id_ascensor, estado_ejecucion, desde, hasta.
 */
const listarInstancias = async (req, res) => {
  try {
    const { id_plan, id_cliente, id_ascensor, estado_ejecucion, desde, hasta, q } = req.query;
    const ids_cliente = _normalizarIds(id_cliente);
    const ids_ascensor = _normalizarIds(id_ascensor);
    const id_tecnico_filtro = idTecnicoFiltro(req.user);
    const data = await _obtenerInstanciasMantenimiento({
      id_plan: id_plan ? Number(id_plan) : null,
      ids_cliente, ids_ascensor, estado_ejecucion, desde, hasta, q,
      id_tecnico_filtro
    });
    // El precio de cada ocurrencia solo viaja a los roles que pueden verlo
    // (mismo criterio que el resto de módulos): el técnico recibe la instancia
    // sin datos económicos.
    const salida = puedeVerPrecio(req)
      ? data
      : data.map(({ precio_interno, moneda, sin_cobro, ...resto }) => resto);
    res.json({ data: salida });
  } catch (err) {
    console.error('[mantenimientos.listarInstancias]', err);
    res.status(500).json({ error: 'Error al listar mantenimientos individuales' });
  }
};

/**
 * Construye el dataset agrupado por cliente que alimenta los reportes
 * (Excel, PDF, JSON). Garantiza que TODOS los clientes seleccionados aparezcan
 * (aunque no tengan planes ni programaciones), y mezcla las instancias reales
 * (servicios + eventos) con las fechas teóricas que cada plan continuo debería
 * tener según su frecuencia.
 */
async function _construirDatasetReporte({ idsCliente, idsAscensor, estadoEjecucion, desde, hasta }) {
  const [instancias, planes] = await Promise.all([
    _obtenerInstanciasMantenimiento({
      ids_cliente: idsCliente, ids_ascensor: idsAscensor,
      estado_ejecucion: estadoEjecucion, desde, hasta
    }),
    _obtenerPlanesParaReporte({ ids_cliente: idsCliente, ids_ascensor: idsAscensor })
  ]);

  // Mapa de claves "plan-fecha" para deduplicar con proyecciones teóricas.
  const claveExistente = new Set(
    instancias.map(i => `${i.id_plan}|${_ymd(i.fecha_programada)}`)
  );

  const proyecciones = [];
  for (const plan of planes) {
    if (plan.tipo_plan !== 'continuo') continue;
    const resumen = _resumenAscensores(plan.ascensores);
    const fechas = _proyectarFechasPlanContinuo(plan, { desde, hasta });
    for (const f of fechas) {
      const clave = `${plan.id}|${_ymd(f)}`;
      if (claveExistente.has(clave)) continue;
      proyecciones.push({
        tipo_instancia: 'proyeccion',
        id_servicio: null,
        codigo_servicio: null,
        id_plan: plan.id,
        id_cliente: plan.id_cliente,
        cliente_nombre: resumen.edificio_nombre || plan.cliente?.nombre || null,
        ascensores: resumen.ascensores,
        ascensor_codigo: resumen.ascensor_codigo,
        ascensor_ubicacion: resumen.ascensor_ubicacion,
        tipo_servicio: plan.tipo_servicio?.nombre || null,
        es_mantenimiento_gratuito: false,
        fecha_programada: f,
        estado_ejecucion: 'Proyectado',
        fecha_inicio_real: null,
        fecha_fin_real: null,
        dias_ejecucion: null
      });
      claveExistente.add(clave);
    }
  }

  // Filtro por estado de ejecución también aplica a proyecciones
  let programaciones = [...instancias, ...proyecciones];
  if (estadoEjecucion) {
    programaciones = programaciones.filter(p => p.estado_ejecucion === estadoEjecucion);
  }
  programaciones.sort((a, b) => new Date(a.fecha_programada) - new Date(b.fecha_programada));

  // Cargar info de clientes seleccionados que pueden no tener plan, para
  // que igualmente aparezcan en el reporte (cliente sin programaciones).
  const idsClientesUniverso = new Set();
  if (idsCliente && idsCliente.length > 0) {
    idsCliente.forEach(id => idsClientesUniverso.add(id));
  }
  planes.forEach(p => idsClientesUniverso.add(p.id_cliente));
  programaciones.forEach(p => idsClientesUniverso.add(p.id_cliente));

  const clientesInfo = idsClientesUniverso.size > 0
    ? await prisma.tbl_clientes.findMany({
        where: { id: { in: Array.from(idsClientesUniverso) } },
        select: {
          id: true, nombre: true, tipo_documento: true, numero_documento: true,
          telefono: true
        }
      })
    : [];
  const clientePorId = new Map(clientesInfo.map(c => [c.id, c]));

  const grupos = new Map();
  for (const id of idsClientesUniverso) {
    grupos.set(id, {
      cliente: clientePorId.get(id) || { id, nombre: `Cliente ${id}` },
      planes: [],
      programaciones: []
    });
  }
  for (const p of planes) {
    if (grupos.has(p.id_cliente)) grupos.get(p.id_cliente).planes.push(p);
  }
  for (const pr of programaciones) {
    if (grupos.has(pr.id_cliente)) grupos.get(pr.id_cliente).programaciones.push(pr);
  }

  // Ordenamiento estable por nombre de cliente
  const dataset = Array.from(grupos.values())
    .sort((a, b) => (a.cliente?.nombre || '').localeCompare(b.cliente?.nombre || ''));
  return dataset;
}

/**
 * Exporta el listado de programaciones de mantenimiento agrupado por cliente,
 * en formato Excel, PDF o JSON (este último alimenta el PDF cliente-side con
 * la carátula corporativa de utils/pdfReport.js).
 */
const exportar = async (req, res) => {
  try {
    const formato = String(req.query.formato || 'excel').toLowerCase();
    if (!['excel', 'pdf', 'json'].includes(formato)) {
      return res.status(400).json({ error: 'Formato debe ser "excel", "pdf" o "json"' });
    }
    const { id_cliente, ids_cliente, id_ascensor, ids_ascensor, estado_ejecucion, desde, hasta } = req.query;
    const idsCliente = _normalizarIds(ids_cliente, id_cliente);
    const idsAscensor = _normalizarIds(ids_ascensor, id_ascensor);

    const dataset = await _construirDatasetReporte({
      idsCliente, idsAscensor, estadoEjecucion: estado_ejecucion || null, desde, hasta
    });

    const filtros = {
      ids_cliente: idsCliente, ids_ascensor: idsAscensor,
      estado_ejecucion: estado_ejecucion || null,
      desde: desde || null, hasta: hasta || null
    };
    const stamp = ymdLima();

    if (formato === 'json') {
      return res.json({
        data: { grupos: dataset, filtros, generado: stamp }
      });
    }

    const { generarExcelMantenimientos, generarPdfMantenimientos } = require('../utils/mantenimientosExport');

    if (formato === 'excel') {
      const buffer = await generarExcelMantenimientos({ dataset, filtros });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="mantenimientos-${stamp}.xlsx"`);
      return res.end(buffer);
    }

    const buffer = await generarPdfMantenimientos({ dataset, filtros });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mantenimientos-${stamp}.pdf"`);
    return res.end(buffer);
  } catch (err) {
    console.error('[mantenimientos.exportar]', err);
    res.status(500).json({ error: 'Error al exportar mantenimientos: ' + err.message });
  }
};

/**
 * Reúne lo que se llevaría por delante el borrado de un plan: servicios
 * generados (ejecutados vs. pendientes), dinero ya cobrado, facturas y eventos
 * futuros aún sin materializar.
 *
 * Punto único de la verdad compartido por `impactoEliminacion` (el preview que
 * alimenta el modal de confirmación) y `eliminar` (que ejecuta la cascada), para
 * que lo que se le muestra al Super Admin no pueda divergir de lo que realmente
 * se borra.
 *
 * @returns null si el plan no existe o ya está de baja.
 */
async function _calcularImpactoEliminacion(id) {
  const plan = await prisma.tbl_mantenimientos_planes.findUnique({ where: { id } });
  if (!plan || plan.estado === 0) return null;

  const serviciosGenerados = await prisma.tbl_servicios_proyectos.findMany({
    where: { id_mantenimiento_plan: id, estado: 1 },
    include: { cobro: { include: { pagos: { where: { estado: 1 } } } } }
  });
  // Cobro ÚNICO del plan (la facturación es a nivel de plan, no por servicio).
  const cobroPlan = await prisma.tbl_cobros.findFirst({
    where: { id_mantenimiento_plan: id, estado: 1 },
    include: { pagos: { where: { estado: 1 } } }
  });

  const ejecutados = serviciosGenerados.filter(s => estaServicioFinalizado(s.estado_servicio));

  // Dinero real: abonos del cobro del plan + los de cobros por servicio (legacy).
  const abonadoPlan = cobroPlan ? Number(cobroPlan.total_abonado || 0) : 0;
  const abonadoServicios = serviciosGenerados
    .reduce((acc, s) => acc + Number(s.cobro?.total_abonado || 0), 0);
  const pagos = (cobroPlan?.pagos?.length || 0) +
    serviciosGenerados.reduce((acc, s) => acc + (s.cobro?.pagos?.length || 0), 0);

  const facturas = await prisma.tbl_facturas.count({
    where: {
      estado: 1,
      OR: [
        { id_mantenimiento_plan: id },
        { id_servicio: { in: serviciosGenerados.map(s => s.id) } }
      ]
    }
  });
  // Eventos del plan que todavía no tienen servicio materializado: se cancelan
  // sin pasar por la cascada de servicio, así que se cuentan aparte.
  const eventosFuturos = await prisma.tbl_calendario_eventos.count({
    where: { id_mantenimiento_plan: id, estado: 1, id_servicio: null }
  });

  return {
    plan,
    serviciosGenerados,
    cobroPlan,
    resumen: {
      plan: { id: plan.id, estado_plan: plan.estado_plan },
      servicios: {
        total: serviciosGenerados.length,
        ejecutados: ejecutados.length,
        pendientes: serviciosGenerados.length - ejecutados.length,
        codigos_ejecutados: ejecutados.map(s => s.codigo).filter(Boolean)
      },
      cobros: {
        total_abonado: Number((abonadoPlan + abonadoServicios).toFixed(2)),
        // La moneda sale del cobro real (nunca se asume): la del cobro del plan
        // o, si no hay, la del primer cobro por servicio.
        moneda: cobroPlan?.moneda || serviciosGenerados.find(s => s.cobro)?.cobro?.moneda || null,
        pagos,
        facturas
      },
      eventos: { futuros: eventosFuturos }
    }
  };
}

/**
 * Preview del borrado en cascada de un plan. Solo lectura, sin efectos.
 *
 * El modal de confirmación lo consulta al abrirse para que el Super Admin vea
 * cuántos mantenimientos ejecutados y cuánto dinero cobrado se va a dar de baja
 * ANTES de escribir la palabra clave.
 */
const impactoEliminacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const impacto = await _calcularImpactoEliminacion(id);
    if (!impacto) return res.status(404).json({ error: 'Plan no encontrado' });
    res.json({ data: impacto.resumen });
  } catch (err) {
    console.error('[mantenimientos.impactoEliminacion]', err);
    res.status(500).json({ error: 'Error al calcular el impacto: ' + err.message });
  }
};

/**
 * Soft-delete de un plan de mantenimiento (estado = 0). Solo Super Admin.
 *
 * Da de baja TODO en cascada, sin excepción: cada servicio generado —incluidos
 * los ya ejecutados y los que tienen abonos— vía el motor de reversión, el cobro
 * único del plan con su cadena (cuotas, pagos, recordatorios, facturas), TODOS
 * los eventos de calendario del plan (incluidos los futuros aún sin servicio
 * materializado), sus recordatorios y la junction de ascensores.
 *
 * Los archivos de Wasabi NO se purgan: se da de baja la fila de `tbl_archivos`
 * (dejan de verse en la operación) pero el objeto sobrevive en el bucket, para
 * que el borrado sea realmente reversible y no se destruya evidencia de trabajo
 * ya ejecutado ni respaldo contable. El resto de módulos conserva su purga.
 *
 * ADVERTENCIA: los abonos y facturas pasan a estado 0, con lo que ese ingreso
 * desaparece de los reportes contables. Por eso el modal exige confirmación con
 * el monto a la vista (ver `impactoEliminacion`). Queda auditado y recuperable.
 */
const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const impacto = await _calcularImpactoEliminacion(id);
    if (!impacto) return res.status(404).json({ error: 'Plan no encontrado' });
    const { plan, serviciosGenerados, cobroPlan } = impacto;

    const tecnicoIds = [];
    await prisma.$transaction(async (tx) => {
      const stamp = { user_id_modification: req.user.id, date_time_modification: new Date() };

      for (const s of serviciosGenerados) {
        const r = await bajaServicioCascadaEnTx(tx, s.id, req.user.id);
        tecnicoIds.push(...r.tecnicoIds);
      }

      // Eventos de calendario del plan: incluye los futuros aún sin id_servicio.
      await tx.tbl_calendario_eventos.updateMany({
        where: { id_mantenimiento_plan: id, estado: 1 },
        data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, ...stamp }
      });
      await tx.tbl_recordatorios.updateMany({
        where: { id_mantenimiento_plan: id, estado: 1 },
        data: { estado: 0, ...stamp }
      });
      // Ascensores del plan (junction): baja lógica para no dejar filas activas
      // colgando de un plan eliminado.
      await tx.tbl_mantenimientos_planes_ascensores.updateMany({
        where: { id_plan: id, estado: 1 },
        data: { estado: 0, ...stamp }
      });

      // Cobro único del plan + su cadena (cuotas, pagos, recordatorios, facturas).
      // Los abonos, si los hay, se dan de baja con el resto. Los PDF de factura
      // se desvinculan (fila de archivo a estado 0) pero NO se purgan del bucket.
      if (cobroPlan) {
        const facturasPlan = await tx.tbl_facturas.findMany({ where: { id_mantenimiento_plan: id, estado: 1 } });
        for (const f of facturasPlan) {
          await bajaArchivoEnTx(tx, f.id_archivo, req.user.id);
        }
        await tx.tbl_cobros_cuotas.updateMany({ where: { id_cobro: cobroPlan.id, estado: 1 }, data: { estado: 0, ...stamp } });
        await tx.tbl_pagos.updateMany({ where: { id_cobro: cobroPlan.id, estado: 1 }, data: { estado: 0, ...stamp } });
        await tx.tbl_cobros_recordatorios.updateMany({ where: { id_cobro: cobroPlan.id, estado: 1 }, data: { estado: 0, ...stamp } });
        await tx.tbl_facturas.updateMany({ where: { id_mantenimiento_plan: id, estado: 1 }, data: { estado: 0, ...stamp } });
        await tx.tbl_cobros.update({ where: { id: cobroPlan.id }, data: { estado: 0, ...stamp } });
      }

      const planActualizado = await tx.tbl_mantenimientos_planes.update({
        where: { id },
        data: { estado: 0, estado_plan: ESTADO_PLAN_CANCELADO, ...stamp }
      });
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_mantenimientos_planes', id_entidad: id,
        accion: 'DELETE', valor_anterior: plan, valor_nuevo: planActualizado, ip: req.ip
      });
    });

    // Sin purga de Wasabi: los objetos quedan en el bucket para que el borrado
    // sea reversible (ver cabecera). Solo se liberan los técnicos asignados.
    await liberarTecnicos(tecnicoIds, -1);

    res.json({ ok: true, impacto: impacto.resumen });
  } catch (err) {
    console.error('[mantenimientos.eliminar]', err);
    res.status(500).json({ error: 'Error al eliminar plan: ' + err.message });
  }
};

/**
 * GET /:id/periodos — estado de facturación por periodo de un plan (para la UI
 * de aprobación). Solo lectura.
 */
const listarPeriodos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const plan = await prisma.tbl_mantenimientos_planes.findUnique({ where: { id }, select: { id: true } });
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
    const data = await _periodosDelPlan(prisma, id);
    res.json({ data });
  } catch (err) {
    console.error('[mantenimientos.listarPeriodos]', err);
    res.status(500).json({ error: 'Error al obtener periodos del plan' });
  }
};

/**
 * POST /:id/periodos/aprobar — aprueba un PERIODO del plan para facturación.
 * El periodo es la unidad de cobro: se le crea UNA cuota (por el total de todos
 * los ascensores) en el cobro único del plan, y el cobro sube su total.
 *
 * Body: { fecha_ocurrencia?: 'YYYY-MM-DD', ordinal?: number, forzar?: bool, modo?: 'total'|'equivalente' }
 *  - Normal: solo si el periodo está completo (todos los servicios finalizados).
 *  - Forzado: con periodo incompleto, el admin elige facturar el TOTAL o el
 *    EQUIVALENTE proporcional (done/total × total).
 * Devuelve la cuota creada → el front abre el modal de factura con id_cuota.
 */
const aprobarPeriodo = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { fecha_ocurrencia, ordinal, forzar, modo } = req.body || {};

    const info = await _periodosDelPlan(prisma, id);
    if (!info.id_cobro) return res.status(400).json({ error: 'El plan no tiene un cobro asociado' });

    const p = info.periodos.find(x =>
      (fecha_ocurrencia && x.fecha === String(fecha_ocurrencia).substring(0, 10)) ||
      (ordinal && x.ordinal === Number(ordinal))
    );
    if (!p) return res.status(404).json({ error: 'Periodo no encontrado' });
    if (p.cuota) return res.status(409).json({ error: 'El periodo ya fue aprobado' });

    if (!p.completo && !forzar) {
      return res.status(409).json({
        error: 'El periodo tiene mantenimientos pendientes. Requiere aprobación forzada.',
        requiere_forzar: true, done: p.done, total: p.total_servicios, total_monto: p.total_monto
      });
    }

    // Monto de la cuota del periodo.
    let monto;
    if (p.es_gratuito) {
      monto = 0;
    } else if (p.completo || (forzar && modo === 'total')) {
      monto = p.total_monto;
    } else if (forzar && modo === 'equivalente') {
      monto = p.total_servicios > 0 ? round2(p.total_monto * p.done / p.total_servicios) : 0;
    } else {
      return res.status(400).json({ error: 'Indica el modo de facturación forzada: "total" o "equivalente"' });
    }

    const cobro = await prisma.tbl_cobros.findUnique({
      where: { id: info.id_cobro },
      select: { id: true, estado_cobro: true, fecha_proximo_abono: true }
    });
    const fechaVenc = parseYMDLima(p.fecha);

    const resultado = await prisma.$transaction(async (tx) => {
      const cuota = await tx.tbl_cobros_cuotas.create({
        data: {
          id_cobro: info.id_cobro,
          numero_cuota: p.ordinal,
          fecha_vencimiento: fechaVenc,
          monto,
          estado_cuota: monto > 0 ? 'Pendiente' : 'Pagada',
          fecha_pago: monto > 0 ? null : new Date(),
          user_id_registration: req.user.id
        }
      });
      await tx.tbl_cobros.update({
        where: { id: info.id_cobro },
        data: {
          monto_total: { increment: monto },
          saldo_pendiente: { increment: monto },
          numero_cuotas: { increment: 1 },
          // Una cuota gratuita (monto 0) nace 'Pagada': no suma a las faltantes.
          cuotas_faltantes: monto > 0 ? { increment: 1 } : undefined,
          ...(monto > 0 && cobro.estado_cobro === 'Sin cobro' ? { estado_cobro: 'Pendiente de iniciar' } : {}),
          ...(monto > 0 && !cobro.fecha_proximo_abono ? { fecha_proximo_abono: fechaVenc } : {}),
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });
      return cuota;
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cobros_cuotas', id_entidad: resultado.id,
      accion: 'CREATE',
      valor_nuevo: { plan: id, periodo: p.ordinal, fecha: p.fecha, monto, forzado: !!forzar, modo: forzar ? modo : null, done: p.done, total: p.total_servicios },
      ip: req.ip
    });

    res.status(201).json({ data: { cuota: resultado, id_cobro: info.id_cobro, periodo: { ordinal: p.ordinal, fecha: p.fecha, monto } } });
  } catch (err) {
    console.error('[mantenimientos.aprobarPeriodo]', err);
    res.status(500).json({ error: 'Error al aprobar periodo: ' + err.message });
  }
};

/**
 * POST /:id/periodos/ajustar — sube el monto de la cuota de un periodo ya
 * aprobado de forma parcial (equivalente) cuando después se completan los
 * mantenimientos faltantes. Solo si la cuota NO está facturada ni pagada.
 * Body: { fecha_ocurrencia?, ordinal? }
 */
const ajustarPeriodo = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { fecha_ocurrencia, ordinal } = req.body || {};
    const info = await _periodosDelPlan(prisma, id);
    const p = info.periodos.find(x =>
      (fecha_ocurrencia && x.fecha === String(fecha_ocurrencia).substring(0, 10)) ||
      (ordinal && x.ordinal === Number(ordinal))
    );
    if (!p) return res.status(404).json({ error: 'Periodo no encontrado' });
    if (!p.cuota) return res.status(400).json({ error: 'El periodo aún no está aprobado' });
    if (p.estado_periodo === 'facturado' || p.estado_periodo === 'pagado' || p.cuota.monto_pagado > 0) {
      return res.status(400).json({ error: 'La cuota ya fue facturada o tiene pagos; ajústela manualmente (nota de crédito/débito)' });
    }
    const delta = round2(p.total_monto - p.cuota.monto);
    if (delta <= 0) return res.status(400).json({ error: 'No hay monto adicional que ajustar' });

    await prisma.$transaction(async (tx) => {
      await tx.tbl_cobros_cuotas.update({
        where: { id: p.cuota.id },
        data: { monto: p.total_monto, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      await tx.tbl_cobros.update({
        where: { id: info.id_cobro },
        data: {
          monto_total: { increment: delta },
          saldo_pendiente: { increment: delta },
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cobros_cuotas', id_entidad: p.cuota.id,
      accion: 'UPDATE', valor_nuevo: { plan: id, periodo: p.ordinal, delta, monto_nuevo: p.total_monto }, ip: req.ip
    });
    res.json({ data: { id_cuota: p.cuota.id, monto: p.total_monto, delta } });
  } catch (err) {
    console.error('[mantenimientos.ajustarPeriodo]', err);
    res.status(500).json({ error: 'Error al ajustar periodo: ' + err.message });
  }
};

/**
 * Servicios del plan cuyo PRECIO todavía se puede tocar: los que están en estado
 * pre-campo y cuyo periodo aún NO fue aprobado para facturación (sin cuota en el
 * cobro del plan). Aprobado el periodo, el monto ya vive en la cuota y el ajuste
 * corresponde a Cobros (`ajustarPeriodo` / nota de crédito), no aquí.
 *
 * @returns {Promise<{ids:Set<number>, periodosBloqueados:number}>}
 */
async function _serviciosConPrecioEditable(client, idPlan) {
  const info = await _periodosDelPlan(client, idPlan);
  const ids = new Set();
  let periodosBloqueados = 0;
  for (const p of info.periodos) {
    if (p.cuota) { periodosBloqueados++; continue; }
    for (const s of p.servicios) {
      if (esServicioEditable(s.estado_servicio)) ids.add(s.id);
    }
  }
  return { ids, periodosBloqueados };
}

/**
 * Aplica los montos por ascensor a los servicios ya materializados que aún son
 * editables. Cada servicio del plan cubre UN ascensor, así que su `precio_interno`
 * y el monto de su junction pasan a valer lo que se pactó para ese ascensor.
 *
 * @param {Map<number, number>} montoPorAscensor  id_ascensor → monto
 * @returns {Promise<number>} cantidad de servicios actualizados
 */
async function _propagarPreciosAServicios(tx, { idPlan, montoPorAscensor, moneda, idsEditables, userId }) {
  if (idsEditables.size === 0) return 0;
  const servicios = await tx.tbl_servicios_proyectos.findMany({
    where: { id: { in: [...idsEditables] }, id_mantenimiento_plan: idPlan, estado: 1 },
    include: { ascensores: { where: { estado: 1 } } }
  });
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };
  let actualizados = 0;
  for (const s of servicios) {
    // Un mantenimiento gratuito no lleva precio: su cupo lo decide el plan.
    if (s.sin_cobro === 1) continue;
    const filas = s.ascensores;
    const montos = filas.map(f => montoPorAscensor.get(f.id_ascensor));
    if (montos.some(m => m === undefined)) continue; // ascensor ajeno al plan
    const total = round2(montos.reduce((a, b) => a + b, 0));
    await tx.tbl_servicios_proyectos.update({
      where: { id: s.id },
      data: { precio_interno: total, moneda, ...stamp }
    });
    for (let i = 0; i < filas.length; i++) {
      await tx.tbl_servicios_ascensores.update({
        where: { id: filas[i].id },
        data: { monto: montos[i], moneda, ...stamp }
      });
    }
    actualizados++;
  }
  return actualizados;
}

/**
 * PUT /:id/precios — edita el precio del plan POR ASCENSOR y/o GLOBAL.
 *
 * Body (uno de los dos):
 *   { ascensores: [{ id_ascensor, monto }, ...] }  → precio por ascensor (parcial:
 *      los ascensores no enviados conservan su monto).
 *   { precio_total: number }                       → precio global; se reparte
 *      PROPORCIONALMENTE a los montos vigentes (respeta lo pactado por ascensor).
 *   { propagar: false } para tocar solo el plan (futuras ocurrencias) y dejar
 *      intactos los mantenimientos ya generados. Por defecto propaga.
 *
 * El nuevo desglose queda en la junction del plan (base de las próximas
 * ocurrencias) y, salvo `propagar: false`, se aplica también a los mantenimientos
 * ya materializados que siguen siendo editables y cuyo periodo no fue aprobado.
 * Los periodos ya aprobados no se tocan: su monto vive en la cuota del cobro.
 */
const actualizarPrecios = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { ascensores, precio_total, propagar } = req.body || {};

    const plan = await prisma.tbl_mantenimientos_planes.findUnique({
      where: { id },
      include: {
        ascensores: {
          where: { estado: 1 },
          orderBy: { id: 'asc' },
          include: { ascensor: { select: { id: true, codigo: true } } }
        }
      }
    });
    if (!plan || plan.estado === 0) return res.status(404).json({ error: 'Plan no encontrado' });
    const filas = plan.ascensores;
    if (filas.length === 0) return res.status(400).json({ error: 'El plan no tiene ascensores asociados' });

    const moneda = filas[0].moneda || MONEDA_POR_DEFECTO;
    // Montos finales por fila de la junction (parte del vigente y se sobrescribe).
    const montoPorFila = new Map(filas.map(f => [f.id, Number(f.monto)]));

    if (Array.isArray(ascensores) && ascensores.length > 0) {
      const porAscensor = new Map(filas.map(f => [f.id_ascensor, f]));
      for (const it of ascensores) {
        const idAsc = Number(it?.id_ascensor);
        const monto = Number(it?.monto);
        const fila = porAscensor.get(idAsc);
        if (!fila) return res.status(400).json({ error: `El ascensor ${idAsc} no pertenece a este plan` });
        if (!Number.isFinite(monto) || monto < 0) {
          return res.status(400).json({ error: `Monto inválido para el ascensor ${fila.ascensor?.codigo || idAsc}` });
        }
        montoPorFila.set(fila.id, round2(monto));
      }
    } else if (precio_total !== undefined && precio_total !== null && precio_total !== '') {
      const total = Number(precio_total);
      if (!Number.isFinite(total) || total < 0) return res.status(400).json({ error: 'Precio total inválido' });
      const montos = repartirProporcional(total, filas.map(f => Number(f.monto)));
      filas.forEach((f, i) => montoPorFila.set(f.id, montos[i]));
    } else {
      return res.status(400).json({ error: 'Indique los montos por ascensor o un precio total' });
    }

    const montoPorAscensor = new Map(filas.map(f => [f.id_ascensor, montoPorFila.get(f.id)]));
    const debePropagar = propagar !== false;
    const editables = debePropagar
      ? await _serviciosConPrecioEditable(prisma, id)
      : { ids: new Set(), periodosBloqueados: 0 };

    const anterior = filas.map(f => ({ id_ascensor: f.id_ascensor, codigo: f.ascensor?.codigo, monto: Number(f.monto) }));
    const stamp = { user_id_modification: req.user.id, date_time_modification: new Date() };

    const resultado = await prisma.$transaction(async (tx) => {
      for (const f of filas) {
        const nuevo = montoPorFila.get(f.id);
        if (round2(Number(f.monto)) === round2(nuevo)) continue;
        await tx.tbl_mantenimientos_planes_ascensores.update({
          where: { id: f.id }, data: { monto: nuevo, ...stamp }
        });
      }
      const serviciosActualizados = debePropagar
        ? await _propagarPreciosAServicios(tx, {
            idPlan: id, montoPorAscensor, moneda, idsEditables: editables.ids, userId: req.user.id
          })
        : 0;
      return { serviciosActualizados };
    });

    const nuevoDesglose = filas.map(f => ({
      id_ascensor: f.id_ascensor, codigo: f.ascensor?.codigo, monto: montoPorFila.get(f.id), moneda
    }));
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_mantenimientos_planes', id_entidad: id,
      accion: 'UPDATE',
      valor_anterior: { precios: anterior },
      valor_nuevo: { precios: nuevoDesglose, servicios_actualizados: resultado.serviciosActualizados },
      ip: req.ip
    });

    res.json({
      data: {
        ascensores: nuevoDesglose,
        total: round2(nuevoDesglose.reduce((a, x) => a + Number(x.monto), 0)),
        moneda,
        servicios_actualizados: resultado.serviciosActualizados,
        periodos_bloqueados: editables.periodosBloqueados
      }
    });
  } catch (err) {
    console.error('[mantenimientos.actualizarPrecios]', err);
    res.status(500).json({ error: 'Error al actualizar precios del plan: ' + err.message });
  }
};

/**
 * PUT /servicios/:idServicio/precio — edita el precio de UNA instancia concreta
 * del plan (el mantenimiento de un ascensor en una fecha), sin alterar el precio
 * pactado del plan ni el resto de ocurrencias. Es la vía correcta para corregir
 * el monto de un mantenimiento puntual: el módulo Proyectos no aplica a estos
 * servicios (su formulario reclasificaría el registro).
 *
 * Solo si el servicio sigue en estado pre-campo y su periodo aún no fue aprobado.
 */
const actualizarPrecioServicio = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const monto = Number(req.body?.monto);
    if (!Number.isFinite(monto) || monto < 0) return res.status(400).json({ error: 'Monto inválido' });

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio },
      include: { ascensores: { where: { estado: 1 } } }
    });
    if (!servicio || servicio.estado === 0) return res.status(404).json({ error: 'Mantenimiento no encontrado' });
    if (!servicio.id_mantenimiento_plan) {
      return res.status(400).json({ error: 'El servicio no pertenece a un plan de mantenimiento' });
    }
    if (servicio.sin_cobro === 1) {
      return res.status(400).json({ error: 'Es un mantenimiento gratuito (sin cobro): no lleva precio.' });
    }
    if (!esServicioEditable(servicio.estado_servicio)) {
      return res.status(409).json({
        error: `No se puede cambiar el precio de un mantenimiento en estado "${servicio.estado_servicio}". Solo antes de salir a campo.`
      });
    }
    const info = await _periodosDelPlan(prisma, servicio.id_mantenimiento_plan);
    const periodo = info.periodos.find(p => p.servicios.some(s => s.id === idServicio));
    if (periodo?.cuota) {
      return res.status(409).json({
        error: `El periodo N° ${periodo.ordinal} ya fue aprobado para facturación. Ajuste el monto desde el cobro del plan.`
      });
    }

    const filas = servicio.ascensores;
    const montos = repartirProporcional(monto, filas.map(f => Number(f.monto)));
    const moneda = req.body?.moneda || servicio.moneda || MONEDA_POR_DEFECTO;
    const stamp = { user_id_modification: req.user.id, date_time_modification: new Date() };
    const precioAnterior = Number(servicio.precio_interno);

    await prisma.$transaction(async (tx) => {
      await tx.tbl_servicios_proyectos.update({
        where: { id: idServicio }, data: { precio_interno: round2(monto), moneda, ...stamp }
      });
      for (let i = 0; i < filas.length; i++) {
        await tx.tbl_servicios_ascensores.update({
          where: { id: filas[i].id }, data: { monto: montos[i], moneda, ...stamp }
        });
      }
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: idServicio,
      accion: 'UPDATE',
      valor_anterior: { precio_interno: precioAnterior },
      valor_nuevo: { precio_interno: round2(monto), moneda, origen: 'plan de mantenimiento' },
      ip: req.ip
    });

    res.json({ data: { id_servicio: idServicio, precio_interno: round2(monto), moneda } });
  } catch (err) {
    console.error('[mantenimientos.actualizarPrecioServicio]', err);
    res.status(500).json({ error: 'Error al actualizar el precio del mantenimiento: ' + err.message });
  }
};

module.exports = {
  listar, crear, actualizar, materializarEvento, listarFrecuencias,
  actualizarPrecios, actualizarPrecioServicio,
  materializarSiguienteEventoDelPlan, listarInstancias, exportar,
  impactoEliminacion, eliminar,
  listarPeriodos, aprobarPeriodo, ajustarPeriodo,
  // Reutilizado por el reporte "Mantenimientos por cliente" (reportesController)
  // para no duplicar la lógica de instancias + proyecciones por rango de fechas.
  construirDatasetReporteMantenimientos: _construirDatasetReporte
};

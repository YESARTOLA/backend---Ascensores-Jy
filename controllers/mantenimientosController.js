const prisma = require('../config/prisma');
const { ESTADO_EVENTO_PROGRAMADO, ESTADO_EVENTO_CANCELADO } = require('../utils/estadoEvento');
const { registrarAuditoria } = require('../utils/auditoria');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { datosSitioParaServicio } = require('../utils/datosSitioAscensor');
const { combinarFechaHoraLima, parseYMDLima, parseYMDFinDiaLima, parseYMDUTC, ymdLima, ymdDeFecha, finDelDiaLima, inicioDelDiaLima } = require('../utils/tiempo');
const { sincronizarRecordatorioMantenimientoPlan, sincronizarRecordatorioServicio, COLORES } = require('../utils/recordatoriosAuto');
const { paginar, paginarArray } = require('../utils/paginacion');
const { FRECUENCIAS, obtenerFrecuencia, calcularFechasProgramacion, visitasEnMeses } = require('../utils/frecuenciaMantenimiento');
const {
  generarProgramacion, mesesDelPlan, tituloBasePlan, eventoDeVisita, frecuenciaDeAscensor
} = require('../utils/planMantenimientoMensual');
const { derivarEjecucion } = require('../utils/ejecucionFechas');
const { validarPertenenciaAscensores } = require('../utils/ascensoresMonto');
const { MONEDA_POR_DEFECTO } = require('../utils/catalogosBancarios');
const { crearCobroInicial } = require('../utils/crearCobroInicial');
const { estaServicioFinalizado, esServicioEditable } = require('../utils/estadoServicio');
const { ESTADO_PLAN_ACTIVO, ESTADO_PLAN_CANCELADO } = require('../utils/estadoPlanMantenimiento');
const { bajaServicioCascadaEnTx, bajaArchivoEnTx, liberarTecnicos } = require('../utils/reversionEliminacion');
const { sincronizarDiasYEventos } = require('../utils/diasServicio');
const { normalizarProgramacion } = require('../utils/programacionDias');

// Un plan admite cupo de mantenimientos gratuitos solo si su subtipo pertenece
// al módulo Mantenimientos (preventivo). SSoT: se deriva de modulo_asociado.
const esModuloMantenimiento = (tipoServicio) => tipoServicio?.modulo_asociado === 'mantenimiento';
const { idTecnicoFiltro, whereServicioGeneradoAsignadoSiTecnico } = require('../utils/visibilidadCalendario');
const { visibilidadPorJunctionWhere, aplicarVisibilidadWhere } = require('../utils/visibilidadEdificio');
const { porJunctionAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');
const { puedeVerPrecio } = require('../middleware/rbacMiddleware');
const { planMantenimientoSinFinanzas } = require('../utils/visibilidadFinanzas');

const COLOR_MANTENIMIENTO = COLORES.mantenimiento;

/**
 * Catálogo de frecuencias. Además de código y etiqueta expone el RENDIMIENTO
 * mensual (`por_mes` / `cada_meses`) para que el formulario pueda anticipar
 * cuántas visitas genera cada ascensor sin duplicar la regla: es el mismo
 * metadato que usa el generador del cronograma.
 */
const listarFrecuencias = (_req, res) => {
  res.json({
    data: FRECUENCIAS.map(({ codigo, etiqueta, unidad, por_mes, cada_meses }) => ({
      codigo, etiqueta, unidad, por_mes, cada_meses
    }))
  });
};

const listar = async (req, res) => {
  try {
    const { q, id } = req.query || {};
    const where = { estado: 1 };
    // Filtro por id: lo usa el enlace de una notificación de plan
    // (/mantenimientos?plan=N) para traer ese plan y abrir su detalle sin
    // depender de que caiga en la página que se esté mostrando.
    if (id !== undefined && id !== '' && Number.isFinite(Number(id))) {
      where.id = Number(id);
    }
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
    // El cobro del plan y el monto pactado por ascensor son datos financieros:
    // se retiran para los roles que no pueden verlos (Coordinador, Técnico…).
    const salida = puedeVerPrecio(req) ? data : data.map(p => planMantenimientoSinFinanzas(p, req.user));
    res.json({ ...result, data: salida });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar mantenimientos' });
  }
};

/**
 * Crea el SERVICIO de una visita del cronograma. Cada visita cubre UN ascensor
 * en UNA fecha, así que genera exactamente un servicio, listo para asignarle su
 * técnico.
 *
 * Estos servicios NO llevan precio propio ni generan cobro: el importe del plan
 * es el `monto_mensual`, que se cobra una vez al mes en el cobro único del plan
 * (gate por id_mantenimiento_plan en serviciosController).
 *
 * @returns {Promise<object>} el servicio creado
 */
async function _crearServicioDeVisita(tx, { plan, tituloBase, idAscensor, codigoAscensor, fechaProgramada, horaProgramada, esGratuito, userId }) {
  // tx-aware: ve los servicios ya creados en esta misma transacción → sin colisión
  // de correlativo al crear varios servicios en el mismo tx.
  const codigo = await generarCodigoServicio('servicio', tx);
  // Título por servicio: distingue el ascensor para que el coordinador asigne el
  // técnico al servicio correcto. Sin código de ascensor, cae a tituloBase.
  const titulo = codigoAscensor ? `${tituloBase} · ${codigoAscensor}` : tituloBase;
  // Contacto en sitio y cuarto de máquinas heredados de la ficha del ascensor.
  const datosSitio = await datosSitioParaServicio(tx, [idAscensor]);
  return tx.tbl_servicios_proyectos.create({
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
      // El precio vive en el plan (monto_mensual), no en la visita: el importe
      // del mes no varía con el número de mantenimientos realizados.
      precio_interno: 0,
      moneda: plan.moneda || MONEDA_POR_DEFECTO,
      sin_cobro: esGratuito ? 1 : 0,
      es_mantenimiento_gratuito: esGratuito ? 1 : 0,
      // La factura del plan es ÚNICA por mes (cuota del cobro del plan): estos
      // servicios no se facturan uno a uno, así que no deben contarse como
      // "pendientes por facturar" en Contabilidad ni en el dashboard.
      requiere_factura: 0,
      ...datosSitio,
      user_id_registration: userId,
      ascensores: {
        create: [{ id_ascensor: idAscensor, monto: 0, moneda: plan.moneda || MONEDA_POR_DEFECTO, user_id_registration: userId }]
      }
    }
  });
}

/**
 * Materializa una fila del cronograma: crea su servicio y engancha el evento de
 * calendario ya existente al servicio recién creado (una visita ↔ un evento ↔
 * un servicio). Devuelve el servicio.
 */
async function _materializarVisita(tx, { visita, plan, tituloBase, esGratuito, userId, fechaOverrideYMD, horaOverride }) {
  const horaProgramada = horaOverride || plan.hora_programada || null;
  const ymd = fechaOverrideYMD || ymdDeFecha(visita.fecha_programada);
  const fechaProgramada = parseYMDLima(ymd);
  const codigoAscensor = visita.ascensor?.codigo || null;

  const servicio = await _crearServicioDeVisita(tx, {
    plan, tituloBase, idAscensor: visita.id_ascensor, codigoAscensor,
    fechaProgramada, horaProgramada, esGratuito, userId
  });

  const tituloEvento = `${servicio.codigo} – ${codigoAscensor ? `${tituloBase} · ${codigoAscensor}` : tituloBase}`;
  const fechaEvento = combinarFechaHoraLima(ymd, horaProgramada);
  if (visita.id_evento) {
    await tx.tbl_calendario_eventos.update({
      where: { id: visita.id_evento },
      data: {
        id_servicio: servicio.id,
        titulo: tituloEvento,
        fecha_inicio: fechaEvento,
        user_id_modification: userId,
        date_time_modification: new Date()
      }
    });
  } else {
    const evento = await tx.tbl_calendario_eventos.create({
      data: eventoDeVisita({
        plan, fechaYMD: ymd, tituloBase, codigoAscensor,
        codigoServicio: servicio.codigo, idServicio: servicio.id
      })
    });
    visita.id_evento = evento.id;
  }

  await tx.tbl_mantenimientos_programacion.update({
    where: { id: visita.id },
    data: {
      id_servicio: servicio.id,
      id_evento: visita.id_evento,
      ...(fechaOverrideYMD ? { fecha_programada: fechaProgramada } : {}),
      user_id_modification: userId,
      date_time_modification: new Date()
    }
  });
  return servicio;
}

/**
 * Materializa la primera visita ACTIVA de cada ascensor del plan, para que el
 * coordinador tenga algo que asignar desde el minuto cero. El resto del
 * cronograma queda como eventos programados.
 */
async function _materializarPrimeraVisitaPorAscensor(tx, { plan, filasJunction, esGratuito, userId }) {
  const tituloBase = tituloBasePlan(
    (filasJunction || []).map(f => f.ascensor?.edificio?.nombre).find(Boolean) || null
  );
  const servicios = [];
  for (const fila of (filasJunction || []).filter(f => f.estado === 1)) {
    const visita = await tx.tbl_mantenimientos_programacion.findFirst({
      where: { id_plan: plan.id, id_ascensor: fila.id_ascensor, estado: 1, activo: 1, id_servicio: null },
      orderBy: { fecha_programada: 'asc' },
      include: { ascensor: { select: { codigo: true } } }
    });
    if (!visita) continue;
    servicios.push(await _materializarVisita(tx, { visita, plan, tituloBase, esGratuito, userId }));
  }
  return servicios;
}

/**
 * Valida y normaliza la frecuencia de UN ascensor del plan. Cada ascensor lleva
 * la suya: un plan puede tener uno mensual, otro trimestral y otro quincenal.
 * Sin frecuencia propia se cae a la del plan (valor por defecto del formulario).
 *
 * @returns {{frecuencia:string|null, frecuencia_dias_custom:number|null}}
 */
function _normalizarFrecuencia(entrada, porDefecto, etiqueta) {
  const frecuencia = entrada?.frecuencia || porDefecto?.frecuencia || null;
  if (!obtenerFrecuencia(frecuencia)) {
    throw new Error(`Frecuencia inválida para ${etiqueta}`);
  }
  let frecuencia_dias_custom = null;
  if (frecuencia === 'custom') {
    const dc = Number(entrada?.frecuencia_dias_custom ?? porDefecto?.frecuencia_dias_custom);
    if (!Number.isInteger(dc) || dc <= 0) {
      throw new Error(`Indique los días entre mantenimientos (frecuencia personalizada) para ${etiqueta}`);
    }
    frecuencia_dias_custom = dc;
  }
  return { frecuencia, frecuencia_dias_custom };
}

/**
 * Valida y normaliza el body de creación/actualización de plan.
 *
 * El plan se dimensiona en MESES (`duracion_meses`) y lleva un `monto_mensual`
 * global: ese es el único importe facturable, uno por mes, invariable respecto
 * del número de visitas. `cantidad_mantenimientos` pasa a ser un DERIVADO (el
 * total de visitas de todos los ascensores) que se recalcula al programar.
 *
 * Para tipo_plan = eventual no hay serie: una visita por ascensor, un mes.
 *
 * `tipoServicio` se usa para validar el cupo gratuito (solo permitido en planes
 * cuyo subtipo pertenece al módulo Mantenimientos). En el modelo mensual el
 * cupo cuenta MESES gratuitos, no visitas sueltas.
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
    throw new Error('Solo los planes del módulo Mantenimientos pueden tener meses gratuitos');
  }

  // Monto mensual global: el importe del cobro de CADA mes del plan.
  const montoRaw = d.monto_mensual;
  let monto_mensual = 0;
  if (montoRaw !== undefined && montoRaw !== null && montoRaw !== '') {
    const m = Number(montoRaw);
    if (!Number.isFinite(m) || m < 0) throw new Error('El monto mensual debe ser un número >= 0');
    monto_mensual = round2(m);
  }

  if (tipo_plan === 'eventual') {
    if (cantidad_mantenimientos_gratuitos > 1) {
      throw new Error('Un plan eventual puede tener como máximo 1 mes gratuito');
    }
    return {
      tipo_plan,
      frecuencia: null,
      frecuencia_dias_custom: null,
      duracion_meses: 1,
      cantidad_mantenimientos: null,
      cantidad_mantenimientos_gratuitos,
      monto_mensual
    };
  }

  const meses = Number(d.duracion_meses);
  if (!Number.isInteger(meses) || meses < 1) {
    throw new Error('La duración del plan debe ser un entero de meses >= 1');
  }
  if (meses > 120) {
    throw new Error('La duración del plan no puede superar los 120 meses');
  }
  if (cantidad_mantenimientos_gratuitos > meses) {
    throw new Error('Los meses gratuitos no pueden superar la duración del plan');
  }
  // Frecuencia del plan = la propuesta por defecto para sus ascensores.
  const { frecuencia, frecuencia_dias_custom } = _normalizarFrecuencia(d, null, 'el plan');
  return {
    tipo_plan,
    frecuencia,
    frecuencia_dias_custom,
    duracion_meses: meses,
    cantidad_mantenimientos: null,  // derivado: lo fija la programación generada
    cantidad_mantenimientos_gratuitos,
    monto_mensual
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

    // Cada entrada de `ascensores` trae el ascensor y SU frecuencia: un plan
    // admite frecuencias distintas por ascensor (uno mensual, otro trimestral…).
    // El precio ya NO se toma del catálogo por ascensor: el importe del plan es
    // el `monto_mensual` global, uno por mes.
    const entradas = Array.isArray(d.ascensores) ? d.ascensores : [];
    const idsAscensores = entradas.map(a => Number(a?.id_ascensor)).filter(Number.isFinite);
    if (idsAscensores.length === 0) {
      return res.status(400).json({ error: 'Debe seleccionar al menos un ascensor' });
    }
    if (new Set(idsAscensores).size !== idsAscensores.length) {
      return res.status(400).json({ error: 'No se puede repetir un mismo ascensor en el plan' });
    }

    const pertenencia = await validarPertenenciaAscensores(idsAscensores, d.id_cliente);
    if (!pertenencia.ok) return res.status(400).json({ error: pertenencia.error });

    let normalizado;
    const frecuenciasPorAscensor = new Map();
    try {
      normalizado = _normalizarPlanInput(d, tipoServicio);
      // Un plan eventual no tiene serie: una sola visita por ascensor.
      if (normalizado.tipo_plan === 'continuo') {
        const codigos = await prisma.tbl_ascensores.findMany({
          where: { id: { in: idsAscensores } }, select: { id: true, codigo: true }
        });
        const codigoDe = new Map(codigos.map(c => [c.id, c.codigo]));
        for (const e of entradas) {
          const idAsc = Number(e.id_ascensor);
          frecuenciasPorAscensor.set(
            idAsc,
            _normalizarFrecuencia(e, normalizado, `el ascensor ${codigoDe.get(idAsc) || idAsc}`)
          );
        }
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const moneda = d.moneda || MONEDA_POR_DEFECTO;
    // El mes 1 es gratuito si el plan tiene cupo: su cobro no se genera.
    const primerMesGratuito = normalizado.cantidad_mantenimientos_gratuitos >= 1;

    const resultado = await prisma.$transaction(async (tx) => {
      const plan = await tx.tbl_mantenimientos_planes.create({
        data: {
          id_cliente: Number(d.id_cliente),
          id_tipo_servicio: Number(d.id_tipo_servicio),
          ...normalizado,
          moneda,
          fecha_inicio: parseYMDLima(d.fecha_inicio),
          hora_programada: d.hora_programada || null,
          estado_plan: ESTADO_PLAN_ACTIVO,
          observaciones: d.observaciones || null,
          user_id_registration: req.user.id,
          ascensores: {
            create: idsAscensores.map(idAsc => ({
              id_ascensor: idAsc,
              frecuencia: frecuenciasPorAscensor.get(idAsc)?.frecuencia || null,
              frecuencia_dias_custom: frecuenciasPorAscensor.get(idAsc)?.frecuencia_dias_custom ?? null,
              moneda,
              user_id_registration: req.user.id
            }))
          }
        }
      });

      const filasJunction = await tx.tbl_mantenimientos_planes_ascensores.findMany({
        where: { id_plan: plan.id, estado: 1 },
        include: { ascensor: { select: { id: true, codigo: true, edificio: { select: { nombre: true } } } } }
      });

      // Cronograma completo del plan por adelantado: todas las fechas de todos
      // los ascensores, cada una con su evento de calendario. Desde aquí se
      // pueden ver y omitir fechas concretas antes de que existan servicios.
      const prog = await generarProgramacion(tx, { plan, filasJunction, userId: req.user.id });

      // `cantidad_mantenimientos` es derivado: total de visitas programadas.
      const planActualizado = await tx.tbl_mantenimientos_planes.update({
        where: { id: plan.id },
        data: { cantidad_mantenimientos: prog.creadas }
      });

      // Se materializa la PRIMERA visita de cada ascensor para que el coordinador
      // pueda asignar técnico de inmediato. El resto del cronograma queda como
      // eventos programados, materializables desde el calendario o al cerrarse la
      // visita anterior del mismo ascensor.
      const servicios = await _materializarPrimeraVisitaPorAscensor(tx, {
        plan: planActualizado, filasJunction, esGratuito: primerMesGratuito, userId: req.user.id
      });

      // Cobro ÚNICO del plan que CRECE un mes por vez. Nace VACÍO (monto 0, sin
      // cuotas): cada MES que el admin aprueba desde `aprobarPeriodo` le añade
      // una cuota por `monto_mensual` y sube el total del cobro. Así el cliente
      // nunca aparece debiendo meses que aún no transcurrieron, y por mes se
      // genera una sola factura y un solo pago.
      await crearCobroInicial(tx, {
        idMantenimientoPlan: plan.id,
        idCliente: plan.id_cliente,
        monto: 0,
        moneda,
        fechaCuotaUnica: plan.fecha_inicio,
        sinCuotas: true,
        idUsuario: req.user.id
      });

      return {
        plan: planActualizado,
        servicios,
        servicio: servicios[0] || null,
        visitas_programadas: prog.creadas,
        visitas_por_ascensor: prog.porAscensor
      };
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

/**
 * Borra del cronograma las visitas AÚN NO MATERIALIZADAS (sin servicio) junto
 * con sus eventos de calendario. Es el paso previo a regenerar la programación
 * cuando cambian duración, frecuencias o fecha de inicio: lo ya ejecutado o en
 * curso se conserva intacto.
 *
 * @returns {Promise<number>} visitas eliminadas
 */
async function _limpiarProgramacionNoMaterializada(tx, idPlan) {
  const pendientes = await tx.tbl_mantenimientos_programacion.findMany({
    where: { id_plan: idPlan, id_servicio: null },
    select: { id: true, id_evento: true }
  });
  if (pendientes.length === 0) return 0;
  await tx.tbl_mantenimientos_programacion.deleteMany({
    where: { id: { in: pendientes.map(p => p.id) } }
  });
  const idsEvento = pendientes.map(p => p.id_evento).filter(Boolean);
  if (idsEvento.length > 0) {
    await tx.tbl_calendario_eventos.deleteMany({ where: { id: { in: idsEvento }, id_servicio: null } });
  }
  return pendientes.length;
}

/**
 * Regenera el cronograma del plan conservando lo ya materializado.
 *
 * Recalcula la serie teórica de cada ascensor con su frecuencia y la duración
 * vigentes, y crea solo las visitas cuya fecha no esté ya ocupada por una visita
 * materializada de ESE ascensor. Sin ese filtro, ampliar la duración de un plan
 * con mantenimientos ya ejecutados duplicaría entradas en la misma fecha.
 *
 * @returns {Promise<{creadas:number, eliminadas:number, total:number}>}
 */
async function _regenerarProgramacion(tx, plan, userId) {
  const eliminadas = await _limpiarProgramacionNoMaterializada(tx, plan.id);

  const filasJunction = await tx.tbl_mantenimientos_planes_ascensores.findMany({
    where: { id_plan: plan.id, estado: 1 },
    include: { ascensor: { select: { id: true, codigo: true, edificio: { select: { nombre: true } } } } }
  });

  // Lo que sobrevive: visitas con servicio. Se respetan su fecha y su ordinal.
  const materializadas = await tx.tbl_mantenimientos_programacion.findMany({
    where: { id_plan: plan.id },
    select: { id: true, id_ascensor: true, ordinal: true, fecha_programada: true }
  });
  const ocupadas = new Set(materializadas.map(v => `${v.id_ascensor}|${ymdDeFecha(v.fecha_programada)}`));
  const ordinalesUsados = new Map();
  for (const v of materializadas) {
    const actual = ordinalesUsados.get(v.id_ascensor) || new Set();
    actual.add(v.ordinal);
    ordinalesUsados.set(v.id_ascensor, actual);
  }

  const fechaInicioYMD = ymdDeFecha(plan.fecha_inicio);
  const esEventual = plan.tipo_plan === 'eventual';
  const duracionMeses = esEventual ? 1 : Number(plan.duracion_meses || 12);
  const activos = filasJunction.filter(f => f.estado === 1);

  const teoricas = esEventual
    ? activos.map(f => ({ id_ascensor: f.id_ascensor, ordinal: 1, numero_mes: 1, fecha: fechaInicioYMD }))
    : programacionDelPlan({
        fechaInicioYMD,
        duracionMeses,
        ascensores: activos.map(f => ({ id_ascensor: f.id_ascensor, ...frecuenciaDeAscensor(f, plan) }))
      });

  const junctionPorAscensor = new Map(activos.map(f => [f.id_ascensor, f]));
  const tituloBase = tituloBasePlan(activos.map(f => f.ascensor?.edificio?.nombre).find(Boolean) || null);

  let creadas = 0;
  for (const t of teoricas) {
    if (ocupadas.has(`${t.id_ascensor}|${t.fecha}`)) continue;
    const junction = junctionPorAscensor.get(t.id_ascensor);
    if (!junction) continue;
    // El ordinal debe seguir siendo único por (plan, ascensor): si el teórico ya
    // lo consumió una visita materializada, se corre al siguiente libre.
    const usados = ordinalesUsados.get(t.id_ascensor) || new Set();
    let ordinal = t.ordinal;
    while (usados.has(ordinal)) ordinal++;
    usados.add(ordinal);
    ordinalesUsados.set(t.id_ascensor, usados);

    const evento = await tx.tbl_calendario_eventos.create({
      data: eventoDeVisita({
        plan, fechaYMD: t.fecha, tituloBase, codigoAscensor: junction.ascensor?.codigo || null
      })
    });
    await tx.tbl_mantenimientos_programacion.create({
      data: {
        id_plan: plan.id,
        id_plan_ascensor: junction.id,
        id_ascensor: t.id_ascensor,
        numero_mes: t.numero_mes,
        ordinal,
        fecha_programada: parseYMDLima(t.fecha),
        id_evento: evento.id,
        user_id_registration: userId
      }
    });
    creadas++;
  }

  const total = await tx.tbl_mantenimientos_programacion.count({ where: { id_plan: plan.id, estado: 1 } });
  await tx.tbl_mantenimientos_planes.update({
    where: { id: plan.id }, data: { cantidad_mantenimientos: total }
  });
  return { creadas, eliminadas, total };
}

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_mantenimientos_planes.findUnique({
      where: { id },
      include: {
        tipo_servicio: true,
        ascensores: { where: { estado: 1 }, include: { ascensor: { select: { id: true, codigo: true } } } }
      }
    });
    if (!previo) return res.status(404).json({ error: 'No encontrado' });

    // Cliente y conjunto de ascensores son inmutables: ya existen servicios
    // materializados apuntando a ellos. Cambiarlos rompería historial y
    // reportes; para otro cliente o conjunto se crea un plan nuevo. La
    // FRECUENCIA de cada ascensor sí es editable (ver `ascensores_frecuencias`).
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
      duracion_meses: d.duracion_meses ?? previo.duracion_meses,
      cantidad_mantenimientos_gratuitos: d.cantidad_mantenimientos_gratuitos ?? previo.cantidad_mantenimientos_gratuitos,
      monto_mensual: d.monto_mensual ?? previo.monto_mensual
    };
    let normalizado;
    // Frecuencia por ascensor: llega como [{ id_ascensor, frecuencia, frecuencia_dias_custom }].
    // Solo se aceptan ascensores que ya pertenecen al plan.
    const nuevasFrecuencias = new Map();
    try {
      normalizado = _normalizarPlanInput(mergeInput, tipoServicioFinal);
      if (Array.isArray(d.ascensores_frecuencias)) {
        const porAscensor = new Map(previo.ascensores.map(f => [f.id_ascensor, f]));
        for (const e of d.ascensores_frecuencias) {
          const idAsc = Number(e?.id_ascensor);
          const fila = porAscensor.get(idAsc);
          if (!fila) throw new Error(`El ascensor ${idAsc} no pertenece a este plan`);
          nuevasFrecuencias.set(
            fila.id,
            _normalizarFrecuencia(e, normalizado, `el ascensor ${fila.ascensor?.codigo || idAsc}`)
          );
        }
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const nuevaFechaInicio = d.fecha_inicio ? parseYMDLima(d.fecha_inicio) : previo.fecha_inicio;
    const cambioFrecuenciaAscensor = [...nuevasFrecuencias.entries()].some(([idFila, f]) => {
      const fila = previo.ascensores.find(x => x.id === idFila);
      return !fila
        || fila.frecuencia !== f.frecuencia
        || Number(fila.frecuencia_dias_custom || 0) !== Number(f.frecuencia_dias_custom || 0);
    });
    // Cambios que invalidan el cronograma futuro y obligan a recalcularlo.
    const requiereRegenerar =
      normalizado.tipo_plan !== previo.tipo_plan ||
      Number(normalizado.duracion_meses || 0) !== Number(previo.duracion_meses || 0) ||
      normalizado.frecuencia !== previo.frecuencia ||
      Number(normalizado.frecuencia_dias_custom || 0) !== Number(previo.frecuencia_dias_custom || 0) ||
      nuevaFechaInicio.getTime() !== previo.fecha_inicio.getTime() ||
      cambioFrecuenciaAscensor;

    const resultado = await prisma.$transaction(async (tx) => {
      const stamp = { user_id_modification: req.user.id, date_time_modification: new Date() };
      for (const [idFila, f] of nuevasFrecuencias) {
        await tx.tbl_mantenimientos_planes_ascensores.update({
          where: { id: idFila },
          data: { frecuencia: f.frecuencia, frecuencia_dias_custom: f.frecuencia_dias_custom, ...stamp }
        });
      }
      const plan = await tx.tbl_mantenimientos_planes.update({
        where: { id },
        data: {
          id_tipo_servicio: idTipoFinal,
          ...normalizado,
          // `cantidad_mantenimientos` es derivado del cronograma: lo fija la
          // regeneración, no el body.
          cantidad_mantenimientos: previo.cantidad_mantenimientos,
          fecha_inicio: nuevaFechaInicio,
          hora_programada: d.hora_programada ?? previo.hora_programada,
          estado_plan: d.estado_plan ?? previo.estado_plan,
          observaciones: d.observaciones ?? previo.observaciones,
          ...stamp
        }
      });

      const prog = requiereRegenerar
        ? await _regenerarProgramacion(tx, plan, req.user.id)
        : { creadas: 0, eliminadas: 0, total: previo.cantidad_mantenimientos };

      // El importe de un mes depende del monto mensual Y del cupo gratuito
      // (los meses gratuitos valen 0). Si cambia cualquiera de los dos hay que
      // rehacer las cuotas aún no facturadas ni pagadas, y reetiquetar los
      // mantenimientos pendientes de los meses afectados.
      const cambioMonto = round2(normalizado.monto_mensual) !== round2(previo.monto_mensual);
      const cambioCupo = Number(normalizado.cantidad_mantenimientos_gratuitos) !== Number(previo.cantidad_mantenimientos_gratuitos);
      const cuotas = (cambioMonto || cambioCupo)
        ? await _reflejarMontoMensualEnCuotas(tx, id, normalizado.monto_mensual, req.user.id)
        : null;
      const servicios = cambioCupo
        ? await _sincronizarGratuitosDeServicios(tx, id, normalizado.cantidad_mantenimientos_gratuitos, req.user.id)
        : null;

      return { plan, prog, cuotas, servicios };
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_mantenimientos_planes', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: resultado.plan, ip: req.ip
    });
    sincronizarRecordatorioMantenimientoPlan(id).catch(err => console.error('Sync rec mant:', err));
    res.json({ data: { ...resultado.plan, programacion: resultado.prog, cuotas_ajustadas: resultado.cuotas, servicios_gratuitos: resultado.servicios } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar mantenimiento: ' + err.message });
  }
};


function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Convierte un evento de calendario de un plan de mantenimiento (sin servicio
 * asociado) en un servicio real listo para asignar técnico y checklist.
 *
 * Un evento del plan corresponde a UNA visita del cronograma — un ascensor en
 * una fecha —, así que produce exactamente un servicio.
 *
 * `overrides` admitidos:
 *   - `fecha_programada` / `hora_programada`: reagendan SOLO esta visita, sin
 *     alterar el resto del plan; la fila del cronograma y el evento se mueven.
 *   - `dias`: días de trabajo de ESTA visita (rango, fechas sueltas o ambos; ver
 *     utils/programacionDias). Con más de un día el servicio despliega su grilla
 *     y un evento por día; la fecha programada pasa a ser el primero.
 *
 * El precio NO es un override: el importe del plan es el monto mensual.
 */
async function _materializarVisitaEnTx(tx, visita, plan, userId, overrides = {}) {
  const tituloBase = tituloBasePlan(_edificioNombrePlan(plan.ascensores));
  const horaProgramada = overrides.hora_programada || plan.hora_programada || null;

  // Días de trabajo de esta visita (opcional). Si vienen, el primero manda sobre
  // la fecha programada.
  const fechasProgramacion = normalizarProgramacion(overrides.dias ?? null);
  const ymdOriginal = ymdDeFecha(visita.fecha_programada);
  const ymdFinal = fechasProgramacion
    ? fechasProgramacion[0]
    : (overrides.fecha_programada ? String(overrides.fecha_programada).substring(0, 10) : ymdOriginal);

  // Mes gratuito: los primeros N meses del plan no generan cobro.
  const cupoGratuito = Number(plan.cantidad_mantenimientos_gratuitos || 0);
  const esPreventivo = esModuloMantenimiento(plan.tipo_servicio);
  const esGratuito = esPreventivo && cupoGratuito > 0 && visita.numero_mes <= cupoGratuito;

  const servicio = await _materializarVisita(tx, {
    visita, plan, tituloBase, esGratuito, userId,
    fechaOverrideYMD: ymdFinal !== ymdOriginal ? ymdFinal : null,
    horaOverride: horaProgramada
  });

  // Visita programada en varios días: el servicio despliega su grilla y un
  // evento por día, reutilizando el evento que acaba de quedarle asignado.
  if (fechasProgramacion && fechasProgramacion.length > 1) {
    await sincronizarDiasYEventos(tx, servicio.id, {
      userId,
      fechas: fechasProgramacion,
      tituloBase: `${servicio.codigo} – ${tituloBase}`,
      tipoEvento: 'mantenimiento',
      color: COLOR_MANTENIMIENTO
    });
  }
  return servicio;
}

/**
 * POST /eventos/:id/crear-servicio — materializa la visita del cronograma
 * asociada a un evento de calendario del plan.
 */
const materializarEvento = async (req, res) => {
  try {
    const idEvento = Number(req.params.id);
    const evento = await prisma.tbl_calendario_eventos.findUnique({
      where: { id: idEvento },
      select: { id: true, id_servicio: true, id_mantenimiento_plan: true, fecha_inicio: true }
    });
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });
    if (!evento.id_mantenimiento_plan) {
      return res.status(400).json({ error: 'El evento no pertenece a un plan de mantenimiento' });
    }
    if (evento.id_servicio) {
      return res.status(409).json({ error: 'Este evento ya está materializado en un servicio' });
    }

    const plan = await prisma.tbl_mantenimientos_planes.findUnique({
      where: { id: evento.id_mantenimiento_plan },
      include: {
        tipo_servicio: true,
        ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: { select: { nombre: true } } } } } }
      }
    });
    if (!plan || plan.estado !== 1) {
      return res.status(400).json({ error: 'El plan asociado no está activo' });
    }

    const visita = await prisma.tbl_mantenimientos_programacion.findFirst({
      where: { id_evento: idEvento, id_plan: plan.id, estado: 1 },
      include: { ascensor: { select: { codigo: true } } }
    });
    if (!visita) {
      return res.status(404).json({ error: 'El evento no tiene una visita del cronograma asociada' });
    }
    if (visita.activo === 0) {
      return res.status(409).json({ error: 'Esta fecha fue omitida del plan. Reactívela antes de crear el servicio.' });
    }
    if (visita.id_servicio) {
      return res.status(409).json({ error: 'Esta visita ya tiene un servicio creado' });
    }

    const overrides = {
      fecha_programada: req.body?.fecha_programada,
      hora_programada: req.body?.hora_programada,
      dias: req.body?.dias
    };

    let servicio;
    try {
      servicio = await prisma.$transaction(tx => _materializarVisitaEnTx(tx, visita, plan, req.user.id, overrides));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: servicio.id,
      accion: 'CREATE', valor_nuevo: servicio, ip: req.ip
    });
    sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync rec servicio:', err));
    res.status(201).json({ data: { servicios: [servicio], servicio } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al materializar evento: ' + err.message });
  }
};

/**
 * Auto-materializa la SIGUIENTE visita del MISMO ascensor. Se llama desde
 * `finalizarServicio` al cerrar un mantenimiento de un plan.
 *
 * Con frecuencias distintas por ascensor cada uno lleva su propia serie: tomar
 * "el siguiente evento del plan" encadenaría ascensores equivocados (el
 * quincenal empujaría al trimestral). Por eso el avance es por ascensor.
 *
 * Devuelve el servicio creado, o null si ese ascensor no tiene más visitas.
 */
async function materializarSiguienteEventoDelPlan({ idPlan, idServicioFinalizado, fechaServicioFinalizado, userId }) {
  const plan = await prisma.tbl_mantenimientos_planes.findUnique({
    where: { id: idPlan },
    include: {
      tipo_servicio: true,
      ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: { select: { nombre: true } } } } } }
    }
  });
  if (!plan || plan.estado !== 1 || plan.estado_plan !== ESTADO_PLAN_ACTIVO || plan.tipo_plan !== 'continuo') {
    return null;
  }

  // Ascensor cuya visita se acaba de cerrar: la cadena avanza dentro de su serie.
  const visitaCerrada = idServicioFinalizado
    ? await prisma.tbl_mantenimientos_programacion.findFirst({
        where: { id_plan: idPlan, id_servicio: Number(idServicioFinalizado), estado: 1 },
        select: { id_ascensor: true, ordinal: true, fecha_programada: true }
      })
    : null;
  if (!visitaCerrada) return null;

  const siguiente = await prisma.tbl_mantenimientos_programacion.findFirst({
    where: {
      id_plan: idPlan,
      id_ascensor: visitaCerrada.id_ascensor,
      estado: 1,
      activo: 1,
      id_servicio: null,
      ordinal: { gt: visitaCerrada.ordinal }
    },
    orderBy: { ordinal: 'asc' },
    include: { ascensor: { select: { codigo: true } } }
  });
  if (!siguiente) return null;

  const servicio = await prisma.$transaction(tx => _materializarVisitaEnTx(tx, siguiente, plan, userId));
  sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync rec servicio:', err));
  return servicio;
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
      // Días programados de la ocurrencia: pueden no ser corridos, así que la
      // vista necesita la grilla y no solo `fecha_programada` (el primer día).
      dias: { where: { estado: 1 }, orderBy: { fecha: 'asc' }, select: { id: true, orden: true, fecha: true } },
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
        // Días programados de la ocurrencia (pueden no ser corridos).
        dias: s.dias,
        estado_ejecucion: ej.estado_ejecucion,
        fecha_inicio_real: ej.fecha_inicio_real,
        fecha_fin_real: ej.fecha_fin_real,
        dias_ejecucion: ej.dias_ejecucion
      };
    });

  // 2. Visitas del cronograma aún sin servicio (programación pendiente).
  //    Se leen de tbl_mantenimientos_programacion y no del calendario, porque
  //    cada visita pertenece a UN ascensor concreto: el evento por sí solo no
  //    dice a cuál de los ascensores del plan corresponde. Las omitidas
  //    (activo = 0) no son programación vigente y quedan fuera.
  //    Excepción: para el técnico no aplican (aún no hay servicio ni asignación).
  const whereVisitas = {
    estado: 1,
    activo: 1,
    id_servicio: null,
    plan: { is: { estado: 1 } }
  };
  if (id_plan) whereVisitas.id_plan = Number(id_plan);
  if (ids_cliente && ids_cliente.length > 0) {
    whereVisitas.plan = { is: { estado: 1, id_cliente: { in: ids_cliente } } };
  }
  if (ids_ascensor && ids_ascensor.length > 0) {
    whereVisitas.id_ascensor = { in: ids_ascensor };
  }
  if (desde || hasta) {
    whereVisitas.fecha_programada = {};
    if (desde) whereVisitas.fecha_programada.gte = parseYMDUTC(desde);
    if (hasta) whereVisitas.fecha_programada.lte = parseYMDUTC(hasta);
  }
  const visitasPendientes = id_tecnico_filtro
    ? []
    : await prisma.tbl_mantenimientos_programacion.findMany({
        where: whereVisitas,
        orderBy: { fecha_programada: 'asc' },
        include: {
          ascensor: { select: { id: true, codigo: true, ubicacion: true, tipo: true, edificio: { select: { id: true, nombre: true } } } },
          plan: {
            select: {
              id: true, id_cliente: true,
              cliente: { select: { id: true, nombre: true } },
              tipo_servicio: { select: { id: true, nombre: true } },
              cantidad_mantenimientos_gratuitos: true
            }
          }
        }
      });

  const instanciasFuturas = visitasPendientes
    .filter(v => v.plan)
    .map(v => {
      const resumen = _resumenAscensores([{ ascensor: v.ascensor }]);
      return {
        tipo_instancia: 'evento_futuro',
        id_servicio: null,
        codigo_servicio: null,
        id_evento: v.id_evento,
        id_programacion: v.id,
        numero_mes: v.numero_mes,
        id_plan: v.id_plan,
        id_cliente: v.plan.id_cliente,
        cliente_nombre: resumen.edificio_nombre || v.plan.cliente?.nombre || null,
        ascensores: resumen.ascensores,
        ascensor_codigo: resumen.ascensor_codigo,
        ascensor_ubicacion: resumen.ascensor_ubicacion,
        ascensor_tipo: resumen.ascensor_tipo,
        tipo_servicio: v.plan.tipo_servicio?.nombre || null,
        es_mantenimiento_gratuito: v.numero_mes <= Number(v.plan.cantidad_mantenimientos_gratuitos || 0),
        fecha_programada: v.fecha_programada,
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
      // Cuántas visitas tiene ya materializadas el cronograma: si el plan tiene
      // programación real no hace falta proyectar fechas teóricas.
      _count: { select: { programacion: { where: { estado: 1 } } } },
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
    const { servicios_generados, _count, ...rest } = p;
    return {
      ...rest,
      visitas_programadas: _count?.programacion || 0,
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
 *
 * Acepta `page`/`pageSize`. Como las ocurrencias futuras son proyecciones que
 * no existen como filas en la base, el filtrado y el orden ocurren en memoria
 * y la página se recorta con `paginarArray`. Sin `page` devuelve `{ data }`
 * con todas las ocurrencias, que es lo que consumen el detalle de un plan y
 * los reportes.
 */
const listarInstancias = async (req, res) => {
  try {
    const { id_plan, id_cliente, id_ascensor, estado_ejecucion, desde, hasta, q } = req.query;
    const ids_cliente = _normalizarIds(id_cliente);
    const ids_ascensor = _normalizarIds(id_ascensor);
    const id_tecnico_filtro = idTecnicoFiltro(req.user);
    const todas = await _obtenerInstanciasMantenimiento({
      id_plan: id_plan ? Number(id_plan) : null,
      ids_cliente, ids_ascensor, estado_ejecucion, desde, hasta, q,
      id_tecnico_filtro
    });
    const resultado = paginarArray(todas, req.query);
    // El precio de cada ocurrencia solo viaja a los roles que pueden verlo
    // (mismo criterio que el resto de módulos): el técnico recibe la instancia
    // sin datos económicos. Se sanea solo la página devuelta.
    if (!puedeVerPrecio(req)) {
      resultado.data = resultado.data.map(({ precio_interno, moneda, sin_cobro, ...resto }) => resto);
    }
    res.json(resultado);
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
    // Con cronograma materializado no hay nada que proyectar: sus fechas ya
    // vinieron como instancias (servicios + visitas pendientes). Proyectar
    // encima duplicaría filas en el reporte.
    if (Number(plan.visitas_programadas || 0) > 0) continue;
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

    const datasetCrudo = await _construirDatasetReporte({
      idsCliente, idsAscensor, estadoEjecucion: estado_ejecucion || null, desde, hasta
    });
    // El archivo exportado no puede llevar lo que el rol no ve en pantalla: sin
    // visibilidad financiera se van el precio de cada ocurrencia y el monto
    // pactado por ascensor del plan (de donde sale la columna "Precio").
    const dataset = puedeVerPrecio(req)
      ? datasetCrudo
      : datasetCrudo.map(g => ({
          ...g,
          planes: (g.planes || []).map(pl => planMantenimientoSinFinanzas(pl, req.user)),
          programaciones: (g.programaciones || [])
            .map(({ precio_interno, moneda, sin_cobro, ...resto }) => resto)
        }));

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
      // Cronograma del plan: baja lógica de todas las visitas programadas.
      await tx.tbl_mantenimientos_programacion.updateMany({
        where: { id_plan: id, estado: 1 },
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
 * GET /:id/periodos — estado de facturación MES A MES de un plan.
 *
 * Cada entrada es un mes del plan con: el detalle de visitas (qué ascensor,
 * cuántas veces y en qué fechas), el avance de ejecución, el importe (siempre
 * `monto_mensual`) y la cuota del cobro único del plan si ya fue aprobado.
 * Es la fuente que consumen la UI del plan y el desglose de Contabilidad.
 */
const listarPeriodos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const plan = await prisma.tbl_mantenimientos_planes.findUnique({ where: { id }, select: { id: true } });
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
    const data = await mesesDelPlan(prisma, id);
    // El avance por mes (visitas hechas / totales) es operativo y lo ve todo el
    // mundo; el importe del mes y su cuota, no.
    if (!puedeVerPrecio(req)) {
      return res.json({
        data: {
          ...data,
          id_cobro: null,
          monto_mensual: null,
          meses: (data.meses || []).map(({ monto, cuota, ...resto }) => resto)
        }
      });
    }
    res.json({ data });
  } catch (err) {
    console.error('[mantenimientos.listarPeriodos]', err);
    res.status(500).json({ error: 'Error al obtener periodos del plan' });
  }
};

/**
 * GET /:id/programacion — cronograma completo del plan, agrupado por ascensor.
 *
 * Devuelve todas las fechas (activas y omitidas) para que el usuario vea la
 * programación y pueda desactivar las que no se ejecutarán.
 */
const listarProgramacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const plan = await prisma.tbl_mantenimientos_planes.findUnique({
      where: { id },
      select: {
        id: true, fecha_inicio: true, duracion_meses: true, tipo_plan: true,
        frecuencia: true, frecuencia_dias_custom: true,
        ascensores: {
          where: { estado: 1 },
          orderBy: { id: 'asc' },
          include: { ascensor: { select: { id: true, codigo: true, ubicacion: true, edificio: { select: { nombre: true } } } } }
        }
      }
    });
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });

    const visitas = await prisma.tbl_mantenimientos_programacion.findMany({
      where: { id_plan: id, estado: 1 },
      orderBy: [{ id_ascensor: 'asc' }, { ordinal: 'asc' }],
      include: { servicio: { select: { id: true, codigo: true, estado_servicio: true, estado: true } } }
    });

    const porAscensor = plan.ascensores.map(fila => {
      const frec = frecuenciaDeAscensor(fila, plan);
      const suyas = visitas.filter(v => v.id_ascensor === fila.id_ascensor);
      return {
        id_plan_ascensor: fila.id,
        id_ascensor: fila.id_ascensor,
        codigo: fila.ascensor?.codigo || null,
        ubicacion: fila.ascensor?.ubicacion || null,
        edificio: fila.ascensor?.edificio?.nombre || null,
        frecuencia: frec.frecuencia,
        frecuencia_dias_custom: frec.frecuencia_dias_custom,
        etiqueta_frecuencia: obtenerFrecuencia(frec.frecuencia)?.etiqueta || frec.frecuencia,
        total: suyas.length,
        activas: suyas.filter(v => v.activo === 1).length,
        omitidas: suyas.filter(v => v.activo === 0).length,
        visitas: suyas.map(v => {
          const servicioVivo = v.servicio && v.servicio.estado === 1 ? v.servicio : null;
          return {
            id: v.id,
            ordinal: v.ordinal,
            numero_mes: v.numero_mes,
            fecha: ymdDeFecha(v.fecha_programada),
            activo: v.activo,
            motivo_omision: v.motivo_omision,
            // Evento del calendario de esta visita: es el que se materializa en
            // servicio desde el calendario o desde el propio cronograma.
            id_evento: v.id_evento,
            id_servicio: servicioVivo?.id || null,
            codigo_servicio: servicioVivo?.codigo || null,
            estado_servicio: servicioVivo?.estado_servicio || null,
            materializada: !!servicioVivo,
            realizada: !!servicioVivo && estaServicioFinalizado(servicioVivo.estado_servicio)
          };
        })
      };
    });

    res.json({
      data: {
        id_plan: id,
        fecha_inicio: ymdDeFecha(plan.fecha_inicio),
        duracion_meses: plan.tipo_plan === 'eventual' ? 1 : plan.duracion_meses,
        total_visitas: visitas.length,
        total_activas: visitas.filter(v => v.activo === 1).length,
        ascensores: porAscensor
      }
    });
  } catch (err) {
    console.error('[mantenimientos.listarProgramacion]', err);
    res.status(500).json({ error: 'Error al obtener la programación del plan' });
  }
};

/**
 * PUT /:id/programacion — activa u omite fechas del cronograma.
 *
 * Body: { ids: number[], activo: 0|1, motivo?: string }
 *
 * Omitir (activo = 0) retira la visita del cronograma: deja de programarse y no
 * aparece en el detalle del mes. Si la visita todavía no tiene servicio, se
 * cancela también su evento de calendario; si ya lo tiene, solo se admite
 * mientras el servicio esté Pendiente (y se da de baja en cascada), porque un
 * mantenimiento en curso o ejecutado ya es un hecho.
 *
 * El MONTO MENSUAL NO CAMBIA: el mes se sigue cobrando igual aunque se omitan
 * visitas — es lo pactado con el cliente.
 */
const cambiarActivoProgramacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { ids, activo, motivo } = req.body || {};
    const listaIds = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
    if (listaIds.length === 0) return res.status(400).json({ error: 'Indique al menos una fecha' });
    const nuevoActivo = Number(activo) === 1 ? 1 : 0;

    const visitas = await prisma.tbl_mantenimientos_programacion.findMany({
      where: { id: { in: listaIds }, id_plan: id, estado: 1 },
      include: { servicio: { select: { id: true, estado_servicio: true, estado: true } } }
    });
    if (visitas.length === 0) return res.status(404).json({ error: 'Fechas no encontradas en este plan' });

    // Un mantenimiento que ya salió a campo no se puede omitir.
    if (nuevoActivo === 0) {
      const bloqueadas = visitas.filter(v => {
        const s = v.servicio;
        return s && s.estado === 1 && !esServicioEditable(s.estado_servicio);
      });
      if (bloqueadas.length > 0) {
        return res.status(409).json({
          error: `No se pueden omitir ${bloqueadas.length} fecha(s): su mantenimiento ya está en curso o finalizado.`
        });
      }
    }

    const stamp = { user_id_modification: req.user.id, date_time_modification: new Date() };
    const resultado = await prisma.$transaction(async (tx) => {
      let serviciosDeBaja = 0;
      for (const v of visitas) {
        if (nuevoActivo === 0) {
          // Da de baja el servicio pendiente (si lo hay) y su evento.
          if (v.servicio && v.servicio.estado === 1) {
            await bajaServicioCascadaEnTx(tx, v.servicio.id, req.user.id);
            serviciosDeBaja++;
          }
          if (v.id_evento) {
            await tx.tbl_calendario_eventos.updateMany({
              where: { id: v.id_evento },
              data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, ...stamp }
            });
          }
          await tx.tbl_mantenimientos_programacion.update({
            where: { id: v.id },
            data: { activo: 0, motivo_omision: motivo || null, id_servicio: null, ...stamp }
          });
        } else {
          // Reactivar: se recrea el evento si el anterior quedó cancelado.
          const evento = v.id_evento
            ? await tx.tbl_calendario_eventos.findUnique({ where: { id: v.id_evento } })
            : null;
          let idEvento = v.id_evento;
          if (!evento || evento.estado === 0) {
            const plan = await tx.tbl_mantenimientos_planes.findUnique({
              where: { id },
              select: {
                id: true, hora_programada: true,
                ascensores: { where: { estado: 1 }, include: { ascensor: { select: { id: true, codigo: true, edificio: { select: { nombre: true } } } } } }
              }
            });
            const tituloBase = tituloBasePlan(_edificioNombrePlan(plan.ascensores));
            const codigoAsc = plan.ascensores.find(a => a.id_ascensor === v.id_ascensor)?.ascensor?.codigo || null;
            const nuevo = await tx.tbl_calendario_eventos.create({
              data: eventoDeVisita({
                plan, fechaYMD: ymdDeFecha(v.fecha_programada), tituloBase, codigoAscensor: codigoAsc
              })
            });
            idEvento = nuevo.id;
          }
          await tx.tbl_mantenimientos_programacion.update({
            where: { id: v.id },
            data: { activo: 1, motivo_omision: null, id_evento: idEvento, ...stamp }
          });
        }
      }
      return { serviciosDeBaja };
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_mantenimientos_programacion', id_entidad: id,
      accion: 'UPDATE',
      valor_nuevo: { plan: id, fechas: listaIds, activo: nuevoActivo, motivo: motivo || null, servicios_dados_de_baja: resultado.serviciosDeBaja },
      ip: req.ip
    });
    res.json({
      data: {
        actualizadas: visitas.length,
        activo: nuevoActivo,
        servicios_dados_de_baja: resultado.serviciosDeBaja
      }
    });
  } catch (err) {
    console.error('[mantenimientos.cambiarActivoProgramacion]', err);
    res.status(500).json({ error: 'Error al actualizar la programación: ' + err.message });
  }
};

/**
 * POST /:id/periodos/aprobar — aprueba un MES del plan para facturación.
 *
 * El mes es la unidad de cobro: se le crea UNA cuota por `monto_mensual` en el
 * cobro único del plan, y el cobro sube su total. El importe NO depende de
 * cuántas visitas se hayan ejecutado — por eso no hay modo "equivalente": un
 * mes incompleto se puede aprobar forzado, pero siempre por el monto pactado.
 *
 * Body: { numero_mes: number, forzar?: bool }
 * Devuelve la cuota creada → el front abre el modal de factura con id_cuota.
 */
const aprobarPeriodo = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { numero_mes, ordinal, forzar } = req.body || {};
    const mesPedido = Number(numero_mes ?? ordinal);

    const info = await mesesDelPlan(prisma, id);
    if (!info.id_cobro) return res.status(400).json({ error: 'El plan no tiene un cobro asociado' });

    const p = info.meses.find(x => x.numero_mes === mesPedido);
    if (!p) return res.status(404).json({ error: 'Mes no encontrado en el plan' });
    if (p.cuota) return res.status(409).json({ error: 'El mes ya fue aprobado' });

    if (!p.completo && !forzar) {
      return res.status(409).json({
        error: 'El mes tiene mantenimientos pendientes. Requiere aprobación forzada.',
        requiere_forzar: true, realizadas: p.realizadas, total: p.total_visitas, monto: p.monto
      });
    }

    // El importe del mes es fijo: el monto mensual pactado (0 si es mes gratuito).
    const monto = round2(p.monto);

    const cobro = await prisma.tbl_cobros.findUnique({
      where: { id: info.id_cobro },
      select: { id: true, estado_cobro: true, fecha_proximo_abono: true, numero_cuotas: true }
    });
    // Vence al cierre del mes del plan: el servicio del mes ya se prestó entero.
    const fechaVenc = parseYMDLima(p.hasta);

    const resultado = await prisma.$transaction(async (tx) => {
      const cuota = await tx.tbl_cobros_cuotas.create({
        data: {
          id_cobro: info.id_cobro,
          // `numero_cuota` es el correlativo visible del cobro; `numero_mes` es
          // el vínculo estable con el cronograma del plan.
          numero_cuota: (cobro.numero_cuotas || 0) + 1,
          numero_mes: p.numero_mes,
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
      valor_nuevo: {
        plan: id, numero_mes: p.numero_mes, etiqueta: p.etiqueta, monto,
        forzado: !!forzar, realizadas: p.realizadas, total: p.total_visitas
      },
      ip: req.ip
    });

    res.status(201).json({
      data: {
        cuota: resultado,
        id_cobro: info.id_cobro,
        periodo: { numero_mes: p.numero_mes, etiqueta: p.etiqueta, monto, moneda: info.moneda }
      }
    });
  } catch (err) {
    console.error('[mantenimientos.aprobarPeriodo]', err);
    res.status(500).json({ error: 'Error al aprobar el mes: ' + err.message });
  }
};

/**
 * Sincroniza el flag de GRATUITO de los mantenimientos ya materializados con
 * el cupo de meses gratuitos vigente del plan.
 *
 * Un servicio gratuito lleva `sin_cobro = 1`: al finalizarlo, el flujo de
 * cierre lo deja en "Sin cobro" y NO abre gestión de cobros (ver
 * serviciosController.finalizar). Cambiar el cupo tiene que reescribir ese
 * flag en los servicios de los meses afectados, o quedarían cobrándose meses
 * que ahora son gratis (o al revés).
 *
 * Los servicios que ya salieron a campo no se tocan: su condición económica
 * quedó fijada al ejecutarse.
 *
 * @returns {Promise<{marcados:number, desmarcados:number}>}
 */
async function _sincronizarGratuitosDeServicios(tx, idPlan, cupoGratuito, userId) {
  const visitas = await tx.tbl_mantenimientos_programacion.findMany({
    where: { id_plan: idPlan, estado: 1, id_servicio: { not: null } },
    select: { numero_mes: true, servicio: { select: { id: true, estado: true, estado_servicio: true, sin_cobro: true } } }
  });
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };
  let marcados = 0, desmarcados = 0;
  for (const v of visitas) {
    const s = v.servicio;
    if (!s || s.estado !== 1 || !esServicioEditable(s.estado_servicio)) continue;
    const debeSerGratuito = v.numero_mes <= Number(cupoGratuito || 0);
    const esGratuito = s.sin_cobro === 1;
    if (debeSerGratuito === esGratuito) continue;
    await tx.tbl_servicios_proyectos.update({
      where: { id: s.id },
      data: {
        sin_cobro: debeSerGratuito ? 1 : 0,
        es_mantenimiento_gratuito: debeSerGratuito ? 1 : 0,
        ...stamp
      }
    });
    if (debeSerGratuito) marcados++; else desmarcados++;
  }
  return { marcados, desmarcados };
}

/**
 * Propaga un nuevo monto mensual a las cuotas del cobro del plan que aún se
 * pueden tocar: las que no están facturadas ni tienen pagos. Los meses ya
 * cerrados conservan el importe con el que se emitieron.
 *
 * @returns {Promise<{ajustadas:number, bloqueadas:number, delta:number}>}
 */
async function _reflejarMontoMensualEnCuotas(tx, idPlan, montoMensual, userId) {
  const cobro = await tx.tbl_cobros.findFirst({
    where: { id_mantenimiento_plan: idPlan, estado: 1 },
    select: { id: true }
  });
  if (!cobro) return { ajustadas: 0, bloqueadas: 0, delta: 0 };

  const cuotas = await tx.tbl_cobros_cuotas.findMany({
    where: { id_cobro: cobro.id, estado: 1, numero_mes: { not: null } },
    include: { facturas: { where: { estado: 1 } } }
  });
  const plan = await tx.tbl_mantenimientos_planes.findUnique({
    where: { id: idPlan }, select: { cantidad_mantenimientos_gratuitos: true }
  });
  const cupo = Number(plan?.cantidad_mantenimientos_gratuitos || 0);

  let ajustadas = 0, bloqueadas = 0, delta = 0;
  for (const c of cuotas) {
    const objetivo = c.numero_mes <= cupo ? 0 : round2(montoMensual);
    if (round2(c.monto) === objetivo) continue;
    if (c.facturas.length > 0 || Number(c.monto_pagado || 0) > 0) { bloqueadas++; continue; }
    delta = round2(delta + (objetivo - Number(c.monto)));
    await tx.tbl_cobros_cuotas.update({
      where: { id: c.id },
      data: {
        monto: objetivo,
        estado_cuota: objetivo > 0 ? 'Pendiente' : 'Pagada',
        user_id_modification: userId, date_time_modification: new Date()
      }
    });
    ajustadas++;
  }
  if (delta !== 0) {
    await tx.tbl_cobros.update({
      where: { id: cobro.id },
      data: {
        monto_total: { increment: delta },
        saldo_pendiente: { increment: delta },
        user_id_modification: userId, date_time_modification: new Date()
      }
    });
  }
  return { ajustadas, bloqueadas, delta };
}

/**
 * PUT /:id/monto-mensual — cambia el importe global que se cobra cada mes.
 *
 * Body: { monto_mensual: number, moneda?: string }
 *
 * Es el ÚNICO precio del plan: no hay montos por ascensor ni por visita. El
 * nuevo importe rige para los meses aún no facturados; los meses ya facturados
 * o con pagos conservan el suyo y se informan como bloqueados.
 */
const actualizarMontoMensual = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { monto_mensual, moneda } = req.body || {};
    const monto = Number(monto_mensual);
    if (!Number.isFinite(monto) || monto < 0) {
      return res.status(400).json({ error: 'El monto mensual debe ser un número >= 0' });
    }

    const plan = await prisma.tbl_mantenimientos_planes.findUnique({
      where: { id }, select: { id: true, estado: true, monto_mensual: true, moneda: true }
    });
    if (!plan || plan.estado === 0) return res.status(404).json({ error: 'Plan no encontrado' });

    const anterior = { monto_mensual: Number(plan.monto_mensual), moneda: plan.moneda };
    const stamp = { user_id_modification: req.user.id, date_time_modification: new Date() };

    const resultado = await prisma.$transaction(async (tx) => {
      const actualizado = await tx.tbl_mantenimientos_planes.update({
        where: { id },
        data: { monto_mensual: round2(monto), ...(moneda ? { moneda } : {}), ...stamp }
      });
      const cuotas = await _reflejarMontoMensualEnCuotas(tx, id, round2(monto), req.user.id);
      return { plan: actualizado, cuotas };
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_mantenimientos_planes', id_entidad: id,
      accion: 'UPDATE',
      valor_anterior: anterior,
      valor_nuevo: { monto_mensual: round2(monto), moneda: resultado.plan.moneda, cuotas: resultado.cuotas },
      ip: req.ip
    });

    res.json({
      data: {
        monto_mensual: Number(resultado.plan.monto_mensual),
        moneda: resultado.plan.moneda,
        cuotas_ajustadas: resultado.cuotas.ajustadas,
        cuotas_bloqueadas: resultado.cuotas.bloqueadas
      }
    });
  } catch (err) {
    console.error('[mantenimientos.actualizarMontoMensual]', err);
    res.status(500).json({ error: 'Error al actualizar el monto mensual: ' + err.message });
  }
};

module.exports = {
  listar, crear, actualizar, materializarEvento, listarFrecuencias,
  actualizarMontoMensual,
  materializarSiguienteEventoDelPlan, listarInstancias, exportar,
  impactoEliminacion, eliminar,
  listarPeriodos, aprobarPeriodo,
  listarProgramacion, cambiarActivoProgramacion,
  // Reutilizado por el reporte "Mantenimientos por cliente" (reportesController)
  // para no duplicar la lógica de instancias + proyecciones por rango de fechas.
  construirDatasetReporteMantenimientos: _construirDatasetReporte
};

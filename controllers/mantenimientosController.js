const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { combinarFechaHoraLima, parseYMDLima, parseYMDFinDiaLima, ymdLima, ymdDeFecha, finDelDiaLima } = require('../utils/tiempo');
const { sincronizarRecordatorioMantenimientoPlan, sincronizarRecordatorioServicio, COLORES } = require('../utils/recordatoriosAuto');
const { paginar } = require('../utils/paginacion');
const { FRECUENCIAS, obtenerFrecuencia, calcularFechasProgramacion } = require('../utils/frecuenciaMantenimiento');
const { CATEGORIA_PREVENTIVO, esCategoriaPreventiva } = require('../utils/categoriasMantenimiento');
const { derivarEjecucion } = require('../utils/ejecucionFechas');
const { idTecnicoFiltro, whereServicioGeneradoAsignadoSiTecnico } = require('../utils/visibilidadCalendario');

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
      // Ascensor del plan: código y tipo
      { ascensor: { codigo: { contains: q, mode: 'insensitive' } } },
      { ascensor: { tipo: { contains: q, mode: 'insensitive' } } },
      // Tipo de servicio
      { tipo_servicio: { nombre: { contains: q, mode: 'insensitive' } } },
      // Algún servicio generado por este plan
      { servicios_generados: { some: { estado: 1, codigo: { contains: q, mode: 'insensitive' } } } }
    ];
    // Técnico: solo planes con al menos una instancia (servicio generado) donde
    // tenga asignación activa.
    const filtroPlanesTecnico = whereServicioGeneradoAsignadoSiTecnico(req.user);
    if (filtroPlanesTecnico) where.servicios_generados = filtroPlanesTecnico;
    const result = await paginar(
      prisma.tbl_mantenimientos_planes,
      {
        where,
        orderBy: { id: 'desc' },
        include: {
          cliente: true,
          ascensor: true,
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
          ? { ...plan.tipo_servicio, es_preventivo: esCategoriaPreventiva(plan.tipo_servicio.categoria) }
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
function _eventoPlan({ plan, fecha, codigoServicio, idServicio, tituloBase }) {
  const titulo = codigoServicio
    ? `${codigoServicio} – ${tituloBase}`
    : tituloBase;
  return {
    id_servicio: idServicio || null,
    id_mantenimiento_plan: plan.id,
    titulo,
    tipo_evento: 'mantenimiento',
    fecha_inicio: combinarFechaHoraLima(fecha, plan.hora_programada),
    estado_evento: 'programado',
    color: COLOR_MANTENIMIENTO
  };
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
 * `categoriaTipoServicio` se usa para validar el cupo gratuito (solo permitido
 * en planes cuyo tipo de servicio es de categoría preventiva).
 */
function _normalizarPlanInput(d, categoriaTipoServicio) {
  const tipo_plan = d.tipo_plan === 'eventual' ? 'eventual' : 'continuo';
  const esPreventivo = esCategoriaPreventiva(categoriaTipoServicio);

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
    throw new Error(`Solo planes de categoría "${CATEGORIA_PREVENTIVO}" pueden tener mantenimientos gratuitos`);
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

function _tituloBase(plan, tipoServicioNombre) {
  if (plan.tipo_plan === 'eventual') {
    return `Mantenimiento eventual${tipoServicioNombre ? ' · ' + tipoServicioNombre : ''}`;
  }
  const fr = obtenerFrecuencia(plan.frecuencia);
  const etiqueta = fr ? fr.etiqueta.toLowerCase() : plan.frecuencia;
  return `Mantenimiento ${etiqueta}${tipoServicioNombre ? ' · ' + tipoServicioNombre : ''}`;
}

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_cliente || !d.id_ascensor || !d.id_tipo_servicio || !d.fecha_inicio) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const tipoServicio = await prisma.tbl_tipos_servicio.findUnique({ where: { id: Number(d.id_tipo_servicio) } });

    // El precio se hereda del cliente (tbl_clientes_precios por tipo de servicio).
    // Si no hay precio configurado para ese par, no se permite crear el plan:
    // primero hay que registrarlo en el módulo de Clientes.
    const precioCliente = await prisma.tbl_clientes_precios.findUnique({
      where: { id_cliente_id_tipo_servicio: { id_cliente: Number(d.id_cliente), id_tipo_servicio: Number(d.id_tipo_servicio) } }
    });
    if (!precioCliente) {
      return res.status(400).json({
        error: `Configure primero el precio del cliente para el tipo de servicio "${tipoServicio?.nombre || ''}" en el módulo de Clientes.`
      });
    }

    let normalizado;
    try {
      normalizado = _normalizarPlanInput(d, tipoServicio?.categoria);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // El primer servicio del plan es el ordinal 1: si el cupo gratuito >= 1
    // se crea como mantenimiento gratuito (sin generar cobro automático).
    const primerServicioGratuito = normalizado.cantidad_mantenimientos_gratuitos >= 1;

    const resultado = await prisma.$transaction(async (tx) => {
      const plan = await tx.tbl_mantenimientos_planes.create({
        data: {
          id_cliente: Number(d.id_cliente),
          id_ascensor: Number(d.id_ascensor),
          id_tipo_servicio: Number(d.id_tipo_servicio),
          ...normalizado,
          fecha_inicio: parseYMDLima(d.fecha_inicio),
          hora_programada: d.hora_programada || null,
          estado_plan: 'activo',
          observaciones: d.observaciones || null,
          user_id_registration: req.user.id
        }
      });

      const tituloBase = _tituloBase(plan, tipoServicio?.nombre);
      const codigo = await generarCodigoServicio();
      const precioServicio = Number(precioCliente.precio);
      const monedaServicio = precioCliente.moneda || 'PEN';
      const servicio = await tx.tbl_servicios_proyectos.create({
        data: {
          codigo,
          tipo_registro: 'servicio',
          id_tipo_servicio: Number(d.id_tipo_servicio),
          id_cliente: Number(d.id_cliente),
          id_mantenimiento_plan: plan.id,
          origen: 'mantenimiento',
          titulo: tituloBase,
          descripcion: d.observaciones || null,
          fecha_programada: parseYMDLima(d.fecha_inicio),
          hora_programada: d.hora_programada || null,
          prioridad: 'media',
          estado_servicio: 'Pendiente',
          precio_interno: precioServicio,
          moneda: monedaServicio,
          sin_cobro: primerServicioGratuito ? 1 : 0,
          es_mantenimiento_gratuito: primerServicioGratuito ? 1 : 0,
          user_id_registration: req.user.id,
          ascensores: {
            create: [{
              id_ascensor: Number(d.id_ascensor),
              monto: precioServicio,
              moneda: monedaServicio,
              user_id_registration: req.user.id
            }]
          }
        }
      });

      await tx.tbl_calendario_eventos.create({
        data: _eventoPlan({ plan, fecha: plan.fecha_inicio, codigoServicio: codigo, idServicio: servicio.id, tituloBase })
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

      return { plan, servicio, eventos_futuros: eventosFuturos.length };
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_mantenimientos_planes', id_entidad: resultado.plan.id,
      accion: 'CREATE', valor_nuevo: resultado.plan, ip: req.ip
    });
    sincronizarRecordatorioMantenimientoPlan(resultado.plan.id).catch(err => console.error('Sync rec mant:', err));
    sincronizarRecordatorioServicio(resultado.servicio.id).catch(err => console.error('Sync rec servicio:', err));
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

    // Cliente y ascensor son inmutables: el plan es 1-a-1 con un ascensor y
    // ya existen servicios materializados apuntando al cliente/ascensor
    // originales. Cambiarlos rompería historial y reportes.
    if (d.id_cliente !== undefined && Number(d.id_cliente) !== previo.id_cliente) {
      return res.status(409).json({ error: 'El cliente del plan no se puede cambiar. Cree un plan nuevo para otro cliente.' });
    }
    if (d.id_ascensor !== undefined && Number(d.id_ascensor) !== previo.id_ascensor) {
      return res.status(409).json({ error: 'El ascensor del plan no se puede cambiar. Cree un plan nuevo para otro ascensor.' });
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
      normalizado = _normalizarPlanInput(mergeInput, tipoServicioFinal?.categoria);
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
        const tipoServicio = plan.id_tipo_servicio === previo.id_tipo_servicio
          ? previo.tipo_servicio
          : await tx.tbl_tipos_servicio.findUnique({ where: { id: plan.id_tipo_servicio } });
        const tituloBase = _tituloBase(plan, tipoServicio?.nombre);
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
 * Devuelve el precio configurado para (cliente, tipo de servicio) o null si
 * no existe. Lanza si el cliente no tiene precio registrado y `obligatorio` es true.
 */
async function obtenerPrecioCliente(tx, idCliente, idTipoServicio, { obligatorio = false } = {}) {
  const fila = await tx.tbl_clientes_precios.findUnique({
    where: { id_cliente_id_tipo_servicio: { id_cliente: idCliente, id_tipo_servicio: idTipoServicio } }
  });
  if (!fila && obligatorio) {
    throw new Error('Configure primero el precio del cliente para este tipo de servicio (módulo Clientes → Precios).');
  }
  return fila || null;
}

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
  const codigo = await generarCodigoServicio();
  const tituloBase = _tituloBase(plan, plan.tipo_servicio?.nombre);

  const horaProgramada = overrides.hora_programada || plan.hora_programada || null;
  const ymdEvento = ymdLima(evento.fecha_inicio);
  const ymdFinal = overrides.fecha_programada
    ? String(overrides.fecha_programada).substring(0, 10)
    : ymdEvento;
  const fechaProgramada = parseYMDLima(ymdFinal);
  const fechaEventoNueva = combinarFechaHoraLima(ymdFinal, horaProgramada);
  const cambioFecha = ymdEvento !== ymdFinal || evento.fecha_inicio.getTime() !== fechaEventoNueva.getTime();

  let precio;
  let moneda;
  if (overrides.precio !== undefined && overrides.precio !== null && overrides.precio !== '') {
    precio = Number(overrides.precio);
    if (!Number.isFinite(precio) || precio < 0) {
      throw new Error('Precio inválido');
    }
    moneda = overrides.moneda || 'PEN';
  } else {
    const fila = await obtenerPrecioCliente(tx, plan.id_cliente, plan.id_tipo_servicio, { obligatorio: true });
    precio = Number(fila.precio);
    moneda = fila.moneda || 'PEN';
  }

  const cupoGratuito = Number(plan.cantidad_mantenimientos_gratuitos || 0);
  const esPreventivo = esCategoriaPreventiva(plan.tipo_servicio?.categoria);

  let esGratuito = false;
  if (esPreventivo && cupoGratuito > 0) {
    const previos = await tx.tbl_servicios_proyectos.count({
      where: {
        id_mantenimiento_plan: plan.id,
        estado: 1,
        fecha_programada: { lte: fechaProgramada }
      }
    });
    esGratuito = (previos + 1) <= cupoGratuito;
  }

  const servicio = await tx.tbl_servicios_proyectos.create({
    data: {
      codigo,
      tipo_registro: 'servicio',
      id_tipo_servicio: plan.id_tipo_servicio,
      id_cliente: plan.id_cliente,
      id_mantenimiento_plan: plan.id,
      origen: 'mantenimiento',
      titulo: tituloBase,
      descripcion: plan.observaciones || null,
      fecha_programada: fechaProgramada,
      hora_programada: horaProgramada,
      prioridad: 'media',
      estado_servicio: 'Pendiente',
      precio_interno: precio,
      moneda,
      sin_cobro: esGratuito ? 1 : 0,
      es_mantenimiento_gratuito: esGratuito ? 1 : 0,
      user_id_registration: userId,
      ascensores: {
        create: [{
          id_ascensor: plan.id_ascensor,
          monto: precio,
          moneda,
          user_id_registration: userId
        }]
      }
    }
  });

  await tx.tbl_calendario_eventos.update({
    where: { id: evento.id },
    data: {
      id_servicio: servicio.id,
      titulo: `${codigo} – ${tituloBase}`,
      ...(cambioFecha ? { fecha_inicio: fechaEventoNueva } : {}),
      user_id_modification: userId,
      date_time_modification: new Date()
    }
  });

  return servicio;
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
      include: { mantenimiento_plan: { include: { tipo_servicio: true } } }
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

    let servicio;
    try {
      servicio = await prisma.$transaction(tx => _materializarEventoEnTx(tx, evento, plan, req.user.id, overrides));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_proyectos', id_entidad: servicio.id,
      accion: 'CREATE', valor_nuevo: servicio, ip: req.ip
    });
    sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync rec servicio:', err));
    res.status(201).json({ data: { servicio } });
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
    include: { tipo_servicio: true }
  });
  if (!plan || plan.estado !== 1 || plan.estado_plan !== 'activo' || plan.tipo_plan !== 'continuo') {
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

  const servicio = await prisma.$transaction(tx => _materializarEventoEnTx(tx, siguienteEvento, plan, userId));
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

  // 1. Servicios ya materializados de planes
  const servicios = await prisma.tbl_servicios_proyectos.findMany({
    where: wherePlanFecha,
    orderBy: { fecha_programada: 'desc' },
    include: {
      cliente: { select: { id: true, nombre: true } },
      tipo_servicio: { select: { id: true, nombre: true } },
      mantenimiento_plan: {
        select: {
          id: true,
          tipo_plan: true,
          frecuencia: true,
          id_ascensor: true,
          ascensor: { select: { id: true, codigo: true, ubicacion: true, tipo: true } }
        }
      },
      historial_estados: { where: { estado: 1 }, orderBy: { fecha_cambio: 'asc' } },
      servicio_realizado: { select: { fecha_realizacion: true } }
    }
  });

  const instanciasServicios = servicios
    .filter(s => !ids_ascensor || ids_ascensor.includes(s.mantenimiento_plan?.id_ascensor))
    .map(s => {
      const ej = derivarEjecucion(s);
      return {
        tipo_instancia: 'servicio',
        id_servicio: s.id,
        codigo_servicio: s.codigo,
        id_plan: s.id_mantenimiento_plan,
        id_cliente: s.id_cliente,
        cliente_nombre: s.cliente?.nombre || null,
        id_ascensor: s.mantenimiento_plan?.id_ascensor || null,
        ascensor_codigo: s.mantenimiento_plan?.ascensor?.codigo || null,
        ascensor_ubicacion: s.mantenimiento_plan?.ascensor?.ubicacion || null,
        ascensor_tipo: s.mantenimiento_plan?.ascensor?.tipo || null,
        tipo_servicio: s.tipo_servicio?.nombre || null,
        es_mantenimiento_gratuito: s.es_mantenimiento_gratuito === 1,
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
    if (ids_ascensor && ids_ascensor.length > 0) whereEventos.mantenimiento_plan.is.id_ascensor = { in: ids_ascensor };
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
              id_ascensor: true,
              cliente: { select: { id: true, nombre: true } },
              ascensor: { select: { id: true, codigo: true, ubicacion: true, tipo: true } },
              tipo_servicio: { select: { id: true, nombre: true } }
            }
          }
        }
      });

  const instanciasFuturas = eventos
    .filter(e => e.mantenimiento_plan)
    .map(e => ({
      tipo_instancia: 'evento_futuro',
      id_servicio: null,
      codigo_servicio: null,
      id_evento: e.id,
      id_plan: e.id_mantenimiento_plan,
      id_cliente: e.mantenimiento_plan.id_cliente,
      cliente_nombre: e.mantenimiento_plan.cliente?.nombre || null,
      id_ascensor: e.mantenimiento_plan.id_ascensor,
      ascensor_codigo: e.mantenimiento_plan.ascensor?.codigo || null,
      ascensor_ubicacion: e.mantenimiento_plan.ascensor?.ubicacion || null,
      ascensor_tipo: e.mantenimiento_plan.ascensor?.tipo || null,
      tipo_servicio: e.mantenimiento_plan.tipo_servicio?.nombre || null,
      es_mantenimiento_gratuito: false,
      fecha_programada: e.fecha_inicio,
      estado_ejecucion: 'Pendiente',
      fecha_inicio_real: null,
      fecha_fin_real: null,
      dias_ejecucion: null
    }));

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
  todas.sort((a, b) => new Date(b.fecha_programada) - new Date(a.fecha_programada));
  return todas;
}

/**
 * Trae los planes activos asociados a los clientes/ascensores filtrados, con
 * agregados (mantenimientos ejecutados totales y gratuitos ejecutados) para
 * el resumen del reporte. Devuelve también ascensor y tipo_servicio.
 */
async function _obtenerPlanesParaReporte({ ids_cliente, ids_ascensor }) {
  const where = { estado: 1, estado_plan: 'activo' };
  if (ids_cliente && ids_cliente.length > 0) where.id_cliente = { in: ids_cliente };
  if (ids_ascensor && ids_ascensor.length > 0) where.id_ascensor = { in: ids_ascensor };

  const planes = await prisma.tbl_mantenimientos_planes.findMany({
    where,
    orderBy: [{ id_cliente: 'asc' }, { id_ascensor: 'asc' }],
    include: {
      cliente: true,
      ascensor: true,
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
        ? { ...p.tipo_servicio, es_preventivo: esCategoriaPreventiva(p.tipo_servicio.categoria) }
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
    res.json({ data });
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
        cliente_nombre: plan.cliente?.nombre || null,
        id_ascensor: plan.id_ascensor,
        ascensor_codigo: plan.ascensor?.codigo || null,
        ascensor_ubicacion: plan.ascensor?.ubicacion || null,
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
          distrito: true, telefono: true, nombre_edificio: true
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

module.exports = {
  listar, crear, actualizar, materializarEvento, listarFrecuencias,
  materializarSiguienteEventoDelPlan, listarInstancias, exportar
};

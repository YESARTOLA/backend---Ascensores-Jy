const prisma = require('../config/prisma');
const { ESTADO_EVENTO_CANCELADO } = require('../utils/estadoEvento');
const { puedeVerFinanzasReq, servicioSinPrecios } = require('../utils/visibilidadFinanzas');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { datosSitioParaServicio } = require('../utils/datosSitioAscensor');
const { registrarAuditoria } = require('../utils/auditoria');
const { hmLima, inicioDelDiaLima, parseYMDLima, finDelDiaLima, ymdDeFecha } = require('../utils/tiempo');
const { sincronizarRecordatorioEmergencia, sincronizarRecordatorioServicio } = require('../utils/recordatoriosAuto');
const { paginar } = require('../utils/paginacion');
const { derivarEjecucion } = require('../utils/ejecucionFechas');
const { validarConsistenciaAsignaciones } = require('../utils/asignacionesValidaciones');
const { esServicioEditable, esEmergenciaCerrada } = require('../utils/estadoServicio');
const { whereServicioAsignadoSiTecnico } = require('../utils/visibilidadCalendario');
const { subtipoPorDefectoDeModulo, clasificarTipoServicio } = require('../utils/clasificacionServicio');
const { visibilidadPorAscensorWhere, aplicarVisibilidadWhere } = require('../utils/visibilidadEdificio');
const { porAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');
const { bajaServicioCascadaEnTx, purgarObjetosWasabi, liberarTecnicos } = require('../utils/reversionEliminacion');
const { keyDesdeRuta, eliminarObjeto } = require('../utils/storage');
const {
  INCLUDE_ADJUNTOS, COUNT_ADJUNTOS, MAX_ADJUNTOS,
  vincularAdjuntosEnTx, bajaAdjuntosEnTx, puedeGestionar
} = require('../utils/adjuntosEmergencia');
const {
  sincronizarDiasYEventos,
  reprogramarConservandoForma,
  ConfirmacionRequeridaError
} = require('../utils/diasServicio');
const { normalizarProgramacion } = require('../utils/programacionDias');

// La emergencia se registra siempre sin costo (ver `crear`), así que en el alta
// no interviene ningún rol de precio. Esta lista solo rige la EDICIÓN: si una
// emergencia concreta terminó teniendo importe, únicamente estos roles pueden
// cambiarlo desde aquí.
const ROLES_PRECIO_EM = ['super_admin', 'admin', 'contabilidad'];

/**
 * Cláusula de visibilidad de emergencias para un usuario. Única fuente de verdad
 * compartida por el listado y por los endpoints de adjuntos, para que un técnico
 * no pueda alcanzar por una vía lo que el listado le oculta por la otra.
 */
function whereEmergenciasVisibles(user) {
  const where = { estado: 1 };
  const filtroServicio = whereServicioAsignadoSiTecnico(user);
  if (filtroServicio) where.servicio = filtroServicio;
  // Oculta a roles distintos de super_admin las emergencias de edificios inactivos.
  aplicarVisibilidadWhere(where, visibilidadPorAscensorWhere(user));
  // Alcance por tipo de edificio (Administrador acotado a Edificios u Obras).
  conAlcance(where, porAscensorEdificioWhere(user));
  return where;
}

// Devuelve una emergencia por id con la misma forma que una fila del listado
// (incluye servicio + ejecución). Lo consume el frontend para abrir el modal de
// edición desde la página del servicio (ServicioDetalle → /emergencias?edit=ID).
const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const em = await prisma.tbl_emergencias.findFirst({
      where: { id, estado: 1 },
      include: {
        cliente: true,
        ascensor: { include: { edificio: true } },
        archivos: INCLUDE_ADJUNTOS,
        servicio: {
          include: {
            asignaciones: { include: { tecnico: true }, where: { estado: 1 } },
            // Grilla de días programados: el formulario de edición precarga con
            // ella la programación (rangos y/o fechas sueltas).
            dias: { where: { estado: 1 }, orderBy: { fecha: 'asc' } },
            historial_estados: { where: { estado: 1 }, orderBy: { fecha_cambio: 'asc' } },
            servicio_realizado: { select: { fecha_realizacion: true } }
          }
        }
      }
    });
    if (!em) return res.status(404).json({ error: 'Emergencia no encontrada' });
    // El servicio vinculado trae `precio_interno`: se anula para quien no puede
    // ver datos económicos (el formulario ya le oculta el campo de precio).
    const servicioEm = puedeVerFinanzasReq(req) ? em.servicio : servicioSinPrecios(em.servicio);
    res.json({ data: { ...em, servicio: servicioEm, ejecucion: derivarEjecucion(em.servicio) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener emergencia' });
  }
};

const listar = async (req, res) => {
  try {
    const { estado_emergencia, nivel_urgencia, q } = req.query;
    const where = whereEmergenciasVisibles(req.user);
    if (estado_emergencia) where.estado_emergencia = estado_emergencia;
    if (nivel_urgencia) where.nivel_urgencia = nivel_urgencia;
    // Buscador libre: edificio/obra, cliente, ascensor, distrito, motivo y código del servicio.
    if (q) where.OR = [
      { motivo: { contains: q, mode: 'insensitive' } },
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      { ascensor: { codigo: { contains: q, mode: 'insensitive' } } },
      { ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } },
      { ascensor: { edificio: { distrito: { contains: q, mode: 'insensitive' } } } },
      { servicio: { codigo: { contains: q, mode: 'insensitive' } } }
    ];
    const result = await paginar(
      prisma.tbl_emergencias,
      {
        where, orderBy: { id: 'desc' },
        include: {
          cliente: true,
          ascensor: { include: { edificio: true } },
          // Solo el CONTADOR de adjuntos: la tabla pinta un chip con el número y
          // el detalle se pide al abrir el modal. Traer las filas aquí cargaría
          // los adjuntos de la página entera para nada.
          _count: COUNT_ADJUNTOS,
          servicio: {
            include: {
              asignaciones: { include: { tecnico: true }, where: { estado: 1 } },
              dias: { where: { estado: 1 }, orderBy: { fecha: 'asc' } },
              historial_estados: { where: { estado: 1 }, orderBy: { fecha_cambio: 'asc' } },
              servicio_realizado: { select: { fecha_realizacion: true } }
            }
          }
        }
      },
      req.query
    );
    const verFinanzas = puedeVerFinanzasReq(req);
    const data = result.data.map(em => ({
      ...em,
      servicio: verFinanzas ? em.servicio : servicioSinPrecios(em.servicio),
      ejecucion: derivarEjecucion(em.servicio)
    }));
    res.json({ ...result, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar emergencias' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_cliente || !d.id_ascensor || !d.motivo) {
      return res.status(400).json({ error: 'Cliente, ascensor y motivo son obligatorios' });
    }
    // Un ascensor con la instalación cancelada no admite servicios.
    const ascSel = await prisma.tbl_ascensores.findUnique({ where: { id: Number(d.id_ascensor) }, select: { estado_operativo: true } });
    if (ascSel?.estado_operativo === 'Instalación cancelada') {
      return res.status(400).json({ error: 'Este ascensor tiene la instalación cancelada y no admite servicios.' });
    }
    // LA EMERGENCIA NACE SIN COSTO. Es una decisión de negocio, no un permiso:
    // atender una emergencia no se cobra, así que el alta no pide precio a
    // ningún rol (el formulario tampoco lo muestra) y el servicio se crea en 0
    // con la marca `sin_cobro`. Si un caso concreto sí debe cobrarse, se ajusta
    // después desde el servicio vinculado, que es donde vive el dato económico.
    const sinCobro = true;
    const precioFinal = 0;
    // Sin cobro no hay nada que facturar: la bandera acompaña al precio en 0.
    // Si el caso terminara cobrándose, tanto el importe como la factura se
    // habilitan desde el servicio vinculado, no desde el alta de la emergencia.
    const requiereFactura = 0;

    const tecnicos = Array.isArray(d.tecnicos) ? d.tecnicos : [];

    const consistencia = validarConsistenciaAsignaciones(tecnicos);
    if (!consistencia.ok) return res.status(400).json({ error: consistencia.error });

    // Fechas de agenda: el usuario elige la fecha programada (por defecto hoy) y,
    // opcionalmente, una fecha estimada de término. Los DÍAS DE TRABAJO pueden
    // ser un rango, fechas sueltas o una combinación (`dias`; ver
    // utils/programacionDias): el técnico solo verá esos días en su calendario.
    let fechasProgramacion;
    try { fechasProgramacion = normalizarProgramacion(d.dias ?? null); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const fechaProgramada = fechasProgramacion
      ? parseYMDLima(fechasProgramacion[0])
      : (d.fecha_programada ? parseYMDLima(d.fecha_programada) : inicioDelDiaLima());
    const horaProgramada = d.hora_programada || hmLima();
    const fechaEstimadaEntrega = d.fecha_estimada_entrega ? parseYMDLima(d.fecha_estimada_entrega) : null;
    if (fechaEstimadaEntrega && fechaEstimadaEntrega < fechaProgramada) {
      return res.status(400).json({ error: 'La fecha estimada de término no puede ser anterior a la fecha programada.' });
    }

    const codigo = await generarCodigoServicio();
    // Subtipo vinculado al módulo Emergencias (SSoT). Sin él no se puede clasificar.
    const tipoEmergencia = await subtipoPorDefectoDeModulo(prisma, 'emergencia');
    if (!tipoEmergencia) {
      return res.status(400).json({ error: 'No hay un subtipo de servicio vinculado al módulo Emergencias. Créelo en Tipos de servicio.' });
    }
    const { tipo_registro: tipoRegistroEm } = clasificarTipoServicio(tipoEmergencia);
    // Contacto en sitio y cuarto de máquinas heredados de la ficha del ascensor.
    const datosSitio = await datosSitioParaServicio(prisma, [d.id_ascensor], d);

    const servicio = await prisma.tbl_servicios_proyectos.create({
      data: {
        codigo,
        tipo_registro: tipoRegistroEm,
        id_tipo_servicio: tipoEmergencia.id,
        id_cliente: Number(d.id_cliente),
        origen: 'emergencia',
        titulo: `Emergencia – ${d.motivo.substring(0, 80)}`,
        descripcion: d.motivo,
        fecha_programada: fechaProgramada,
        hora_programada: horaProgramada,
        duracion_dias: fechasProgramacion ? fechasProgramacion.length : 1,
        fecha_estimada_entrega: fechaEstimadaEntrega,
        prioridad: d.nivel_urgencia || 'alta',
        // Asignado exige técnico Y fecha: aquí la fecha siempre se registra al
        // crear, así que basta con que venga algún técnico.
        estado_servicio: tecnicos.length > 0 ? 'Asignado' : 'Pendiente',
        precio_interno: precioFinal,
        moneda: d.moneda || 'PEN',
        sin_cobro: sinCobro ? 1 : 0,
        requiere_factura: requiereFactura,
        observaciones: d.observaciones || null,
        ...datosSitio,
        user_id_registration: req.user.id,
        ascensores: {
          create: [{
            id_ascensor: Number(d.id_ascensor),
            monto: precioFinal || 0,
            moneda: d.moneda || 'PEN',
            user_id_registration: req.user.id
          }]
        }
      }
    });

    const emergencia = await prisma.tbl_emergencias.create({
      data: {
        id_servicio: servicio.id,
        id_cliente: Number(d.id_cliente),
        id_ascensor: Number(d.id_ascensor),
        motivo: d.motivo,
        nivel_urgencia: d.nivel_urgencia || 'alta',
        estado_emergencia: tecnicos.length > 0 ? 'En atención' : 'Reportada',
        observaciones: d.observaciones || null,
        user_id_registration: req.user.id
      }
    });

    // Adjuntos de contexto: el modal los sube a POST /archivos antes de guardar
    // (la emergencia aún no existía) y manda aquí los ids resultantes.
    await vincularAdjuntosEnTx(prisma, emergencia.id, d.archivos, req.user.id);

    // Grilla de días + un evento de calendario por día programado. Con un solo
    // día se conserva el comportamiento previo (evento único que puede
    // extenderse hasta la fecha estimada de término).
    await sincronizarDiasYEventos(prisma, servicio.id, {
      userId: req.user.id,
      fechas: fechasProgramacion,
      tituloBase: `EMERGENCIA ${servicio.codigo}`,
      tipoEvento: 'emergencia',
      idEmergencia: emergencia.id,
      fechaFinEvento: fechaEstimadaEntrega ? finDelDiaLima(fechaEstimadaEntrega) : null
    });

    // Asignar técnicos al servicio si vienen en la creación
    if (tecnicos.length > 0) {
      for (const t of tecnicos) {
        if (!t.id_tecnico) continue;
        await prisma.tbl_servicios_asignaciones.create({
          data: {
            id_servicio: servicio.id,
            id_tecnico: Number(t.id_tecnico),
            rol_asignacion: t.rol_asignacion || 'Apoyo',
            responsable_principal: t.responsable_principal ? 1 : 0,
            responsable_documentacion: t.responsable_documentacion ? 1 : 0,
            asignado_por: req.user.id,
            user_id_registration: req.user.id
          }
        });
      }

    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_emergencias', id_entidad: emergencia.id,
      accion: 'CREATE', valor_nuevo: emergencia, ip: req.ip
    });
    sincronizarRecordatorioEmergencia(emergencia.id).catch(err => console.error('Sync rec emergencia:', err));
    sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync rec servicio:', err));
    res.status(201).json({ data: { emergencia, servicio } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear emergencia: ' + err.message });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_emergencias.findUnique({
      where: { id },
      include: { servicio: { include: { ascensores: { where: { estado: 1 } } } } }
    });
    if (!previo) return res.status(404).json({ error: 'No encontrada' });

    // No se edita una emergencia ya cerrada (ya generó cobro/factura).
    if (esEmergenciaCerrada(previo.estado_emergencia)) {
      return res.status(409).json({ error: 'La emergencia ya está cerrada y no se puede editar.' });
    }

    // El servicio vinculado debe estar en estado pre-ejecución para permitir
    // cambios en cliente/ascensor/precio (rompería historial si está en campo).
    const servicioPrevio = previo.servicio;
    const cambiaServicio = (
      d.id_cliente !== undefined ||
      d.id_ascensor !== undefined ||
      d.precio_interno !== undefined ||
      d.sin_cobro !== undefined ||
      d.motivo !== undefined ||
      d.nivel_urgencia !== undefined ||
      d.moneda !== undefined ||
      d.requiere_factura !== undefined
    );
    if (cambiaServicio && servicioPrevio && !esServicioEditable(servicioPrevio.estado_servicio)) {
      return res.status(409).json({
        error: `El servicio asociado está en "${servicioPrevio.estado_servicio}" y no admite cambios. Solo es editable antes de salir a campo.`
      });
    }

    const puedeCambiarPrecio = ROLES_PRECIO_EM.includes(req.user.rol_codigo);
    const sinCobroNuevo = d.sin_cobro !== undefined
      ? (d.sin_cobro === true || d.sin_cobro === 1 || d.sin_cobro === '1' ? 1 : 0)
      : servicioPrevio?.sin_cobro;
    const precioRecibido = d.precio_interno !== undefined ? Number(d.precio_interno) : null;
    const precioFinal = sinCobroNuevo === 1 ? 0 : (puedeCambiarPrecio && precioRecibido !== null ? precioRecibido : Number(servicioPrevio?.precio_interno || 0));
    const requiereFacturaNuevo = d.requiere_factura !== undefined
      ? (d.requiere_factura === true || d.requiere_factura === 1 || d.requiere_factura === '1' ? 1 : 0)
      : servicioPrevio?.requiere_factura;
    const nuevoMotivo = d.motivo ?? previo.motivo;
    const nuevoNivel = d.nivel_urgencia ?? previo.nivel_urgencia;
    const nuevaMoneda = d.moneda ?? servicioPrevio?.moneda ?? 'PEN';
    const nuevoIdCliente = d.id_cliente ? Number(d.id_cliente) : (servicioPrevio?.id_cliente ?? previo.id_cliente);
    const nuevoIdAscensor = d.id_ascensor ? Number(d.id_ascensor) : (servicioPrevio?.id_ascensor ?? previo.id_ascensor);

    // Fechas de agenda (opcionales en el payload: si no vienen, se conservan).
    // `dias` (rangos y/o fechas sueltas) manda sobre `fecha_programada`: esta
    // pasa a ser el primer día del trabajo.
    let fechasProgramacion;
    try { fechasProgramacion = normalizarProgramacion(d.dias ?? null); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const nuevaFechaProgramada = fechasProgramacion
      ? parseYMDLima(fechasProgramacion[0])
      : (d.fecha_programada !== undefined
        ? (d.fecha_programada ? parseYMDLima(d.fecha_programada) : servicioPrevio?.fecha_programada)
        : servicioPrevio?.fecha_programada);
    const nuevaHoraProgramada = d.hora_programada !== undefined
      ? (d.hora_programada || null)
      : servicioPrevio?.hora_programada;
    const nuevaFechaEstimada = d.fecha_estimada_entrega !== undefined
      ? (d.fecha_estimada_entrega ? parseYMDLima(d.fecha_estimada_entrega) : null)
      : servicioPrevio?.fecha_estimada_entrega;
    if (nuevaFechaProgramada && nuevaFechaEstimada && nuevaFechaEstimada < nuevaFechaProgramada) {
      return res.status(400).json({ error: 'La fecha estimada de término no puede ser anterior a la fecha programada.' });
    }

    // Validar que el ascensor pertenezca al cliente seleccionado
    if (cambiaServicio) {
      const ascBD = await prisma.tbl_ascensores.findUnique({ where: { id: nuevoIdAscensor }, include: { edificio: { select: { id_cliente: true } } } });
      if (!ascBD || ascBD.estado !== 1) {
        return res.status(400).json({ error: 'Ascensor inválido o inactivo' });
      }
      if (ascBD.edificio?.id_cliente !== nuevoIdCliente) {
        return res.status(400).json({ error: `El ascensor ${ascBD.codigo} no pertenece al cliente seleccionado` });
      }
    }

    let emergenciaActualizada;
    try {
      emergenciaActualizada = await prisma.$transaction(async (tx) => {
      const em = await tx.tbl_emergencias.update({
        where: { id },
        data: {
          id_cliente: nuevoIdCliente,
          id_ascensor: nuevoIdAscensor,
          motivo: nuevoMotivo,
          nivel_urgencia: nuevoNivel,
          // `estado_emergencia` no se edita: lo deriva el servicio que atiende la
          // emergencia (ver sincronizarEstadoEmergencia en utils/estadoServicio.js).
          observaciones: d.observaciones ?? previo.observaciones,
          user_id_modification: req.user.id, date_time_modification: new Date()
        }
      });

      // Propagar al servicio vinculado los campos que afectan ejecución y cobro
      if (servicioPrevio) {
        await tx.tbl_servicios_proyectos.update({
          where: { id: servicioPrevio.id },
          data: {
            id_cliente: nuevoIdCliente,
            titulo: `Emergencia – ${nuevoMotivo.substring(0, 80)}`,
            descripcion: nuevoMotivo,
            prioridad: nuevoNivel,
            precio_interno: precioFinal,
            moneda: nuevaMoneda,
            sin_cobro: sinCobroNuevo,
            requiere_factura: requiereFacturaNuevo,
            fecha_programada: nuevaFechaProgramada,
            hora_programada: nuevaHoraProgramada,
            fecha_estimada_entrega: nuevaFechaEstimada,
            observaciones: d.observaciones ?? servicioPrevio.observaciones,
            user_id_modification: req.user.id, date_time_modification: new Date()
          }
        });

        // Resincronizar la junction tbl_servicios_ascensores: las emergencias
        // tienen un único ascensor, así que soft-delete los demás y upsert
        // el ascensor seleccionado.
        await tx.tbl_servicios_ascensores.updateMany({
          where: { id_servicio: servicioPrevio.id, id_ascensor: { not: nuevoIdAscensor } },
          data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
        });
        await tx.tbl_servicios_ascensores.upsert({
          where: { id_servicio_id_ascensor: { id_servicio: servicioPrevio.id, id_ascensor: nuevoIdAscensor } },
          update: { monto: precioFinal, moneda: nuevaMoneda, estado: 1, user_id_modification: req.user.id, date_time_modification: new Date() },
          create: { id_servicio: servicioPrevio.id, id_ascensor: nuevoIdAscensor, monto: precioFinal, moneda: nuevaMoneda, user_id_registration: req.user.id }
        });

        // Regenerar días + eventos. Qué fechas: las enviadas; si solo se movió la
        // fecha programada, la programación vigente desplazada (conserva su
        // forma: 10/15/20 movido una semana → 17/22/27); si no, se conserva.
        if (nuevaFechaProgramada) {
          let fechas = fechasProgramacion;
          if (!fechas && d.fecha_programada !== undefined) {
            fechas = await reprogramarConservandoForma(tx, servicioPrevio.id, {
              nuevoInicio: ymdDeFecha(nuevaFechaProgramada)
            });
          }
          await sincronizarDiasYEventos(tx, servicioPrevio.id, {
            userId: req.user.id,
            confirmar: d.confirmar === true,
            fechas,
            tituloBase: `EMERGENCIA ${servicioPrevio.codigo}`,
            tipoEvento: 'emergencia',
            idEmergencia: previo.id,
            fechaFinEvento: nuevaFechaEstimada ? finDelDiaLima(nuevaFechaEstimada) : null
          });
        }
      }
      return em;
      }, { timeout: 20000 });
    } catch (e) {
      // Reprogramar dejando fuera días ya trabajados exige confirmación explícita.
      if (e instanceof ConfirmacionRequeridaError || e.code === 'REQUIERE_CONFIRMACION') {
        return res.status(409).json({
          error: 'La nueva programación dejaría fuera días que ya tienen evidencia',
          requiere_confirmacion: true,
          dias_con_evidencia: e.diasConEvidencia || []
        });
      }
      throw e;
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_emergencias', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: emergenciaActualizada, ip: req.ip
    });
    sincronizarRecordatorioEmergencia(id).catch(err => console.error('Sync rec emergencia:', err));
    if (servicioPrevio) {
      sincronizarRecordatorioServicio(servicioPrevio.id).catch(err => console.error('Sync rec servicio:', err));
    }
    res.json({ data: emergenciaActualizada });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar: ' + err.message });
  }
};

/**
 * Soft-delete de una emergencia: estado = 0. Como cada emergencia crea y posee
 * un servicio vinculado (1:1), la baja arrastra ese servicio y TODA su cascada
 * (asignaciones, evidencias, cobro, facturas, folder contable,
 * eventos de calendario, recordatorios) vía el motor de reversión, limpia los
 * archivos en Wasabi y libera a los técnicos sin otros servicios activos.
 * No borra físicamente: queda auditado y recuperable.
 */
const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await prisma.tbl_emergencias.findUnique({
      where: { id },
      include: { servicio: { include: { asignaciones: { where: { estado: 1 } } } } }
    });
    if (!previo) return res.status(404).json({ error: 'Emergencia no encontrada' });

    const idServicio = previo.id_servicio;
    let wasabiKeys = [];
    let tecnicoIds = [];
    await prisma.$transaction(async (tx) => {
      const emergencia = await tx.tbl_emergencias.update({
        where: { id },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });

      // Eventos de calendario y recordatorios ligados DIRECTAMENTE a la
      // emergencia (los que cuelgan del servicio los cubre la cascada).
      await tx.tbl_calendario_eventos.updateMany({
        where: { id_emergencia: id, estado: 1 },
        data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      await tx.tbl_recordatorios.updateMany({
        where: { id_emergencia: id, estado: 1 },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });

      // Adjuntos de contexto: cuelgan de la emergencia, no del servicio, así que
      // la cascada de servicio no los alcanza. Sin esto quedarían huérfanos en
      // el bucket.
      wasabiKeys = await bajaAdjuntosEnTx(tx, id, req.user.id);

      if (idServicio) {
        const r = await bajaServicioCascadaEnTx(tx, idServicio, req.user.id);
        wasabiKeys = [...wasabiKeys, ...r.wasabiKeys];
        tecnicoIds = r.tecnicoIds;
      }

      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_emergencias', id_entidad: id,
        accion: 'DELETE', valor_anterior: previo, valor_nuevo: emergencia, ip: req.ip
      });
    });

    await purgarObjetosWasabi(wasabiKeys);
    await liberarTecnicos(tecnicoIds, idServicio);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar emergencia: ' + err.message });
  }
};

// ---------------------------------------------------------------------
// ADJUNTOS DE CONTEXTO (fotos / videos de la falla)
//
// Los carga quien reporta la emergencia para que el TÉCNICO asignado los revise
// antes de salir a campo. Por eso LEER está abierto a cualquier rol que alcance
// la emergencia —incluido el técnico, que es el destinatario— mientras que
// ADJUNTAR y ELIMINAR quedan en los roles de gestión.
// ---------------------------------------------------------------------

/**
 * Resuelve la emergencia aplicando la MISMA visibilidad que el listado. Devuelve
 * null si el usuario no la alcanza (técnico no asignado, edificio fuera de su
 * alcance, etc.), para responder 404 sin filtrar su existencia.
 */
async function emergenciaVisible(user, id) {
  const where = whereEmergenciasVisibles(user);
  return prisma.tbl_emergencias.findFirst({ where: { ...where, id }, select: { id: true } });
}

const listarArchivos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!await emergenciaVisible(req.user, id)) {
      return res.status(404).json({ error: 'Emergencia no encontrada' });
    }
    const archivos = await prisma.tbl_emergencias_archivos.findMany({
      ...INCLUDE_ADJUNTOS,
      where: { ...INCLUDE_ADJUNTOS.where, id_emergencia: id }
    });
    res.json({ data: archivos, meta: { max: MAX_ADJUNTOS, puede_gestionar: puedeGestionar(req.user) } });
  } catch (err) {
    console.error('[emergencias.listarArchivos]', err);
    res.status(500).json({ error: 'Error al listar los adjuntos' });
  }
};

const agregarArchivos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!await emergenciaVisible(req.user, id)) {
      return res.status(404).json({ error: 'Emergencia no encontrada' });
    }
    const creados = await vincularAdjuntosEnTx(prisma, id, req.body?.archivos, req.user.id);
    if (creados === 0) return res.status(400).json({ error: 'No se recibió ningún archivo válido' });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_emergencias_archivos', id_entidad: id,
      accion: 'CREATE', valor_nuevo: { id_emergencia: id, adjuntos: creados }, ip: req.ip
    });

    const archivos = await prisma.tbl_emergencias_archivos.findMany({
      ...INCLUDE_ADJUNTOS,
      where: { ...INCLUDE_ADJUNTOS.where, id_emergencia: id }
    });
    res.status(201).json({ data: archivos });
  } catch (err) {
    if (err.codigoHttp) return res.status(err.codigoHttp).json({ error: err.message });
    console.error('[emergencias.agregarArchivos]', err);
    res.status(500).json({ error: 'Error al adjuntar archivos' });
  }
};

const eliminarArchivo = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const idVinculo = Number(req.params.idVinculo);
    if (!await emergenciaVisible(req.user, id)) {
      return res.status(404).json({ error: 'Emergencia no encontrada' });
    }
    const vinculo = await prisma.tbl_emergencias_archivos.findFirst({
      where: { id: idVinculo, id_emergencia: id, estado: 1 },
      include: { archivo: { select: { id: true, ruta_almacenamiento: true } } }
    });
    if (!vinculo) return res.status(404).json({ error: 'Adjunto no encontrado' });

    const marca = { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() };
    await prisma.$transaction(async (tx) => {
      await tx.tbl_emergencias_archivos.update({ where: { id: idVinculo }, data: marca });
      await tx.tbl_archivos.updateMany({ where: { id: vinculo.id_archivo, estado: 1 }, data: marca });
    });

    // Purga del bucket tras el commit: si falla, el registro ya quedó dado de
    // baja y el objeto se limpia después — nunca al revés.
    const key = vinculo.archivo?.ruta_almacenamiento ? keyDesdeRuta(vinculo.archivo.ruta_almacenamiento) : null;
    if (key) {
      try { await eliminarObjeto(key); }
      catch (e) { console.warn('[emergencias.eliminarArchivo] no se pudo borrar del bucket:', e.message); }
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_emergencias_archivos', id_entidad: idVinculo,
      accion: 'DELETE', valor_anterior: vinculo, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[emergencias.eliminarArchivo]', err);
    res.status(500).json({ error: 'Error al eliminar el adjunto' });
  }
};

module.exports = {
  listar, obtener, crear, actualizar, eliminar,
  listarArchivos, agregarArchivos, eliminarArchivo
};

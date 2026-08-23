/**
 * Mantenimientos correctivos.
 *
 * Reparación reactiva (no urgente, no programada). El patrón sigue al de
 * Emergencias: cada correctivo crea siempre un servicio vinculado para
 * heredar el flujo de asignaciones / evidencias / cobro.
 *
 * Diferencias frente a Emergencias:
 *   - nivel_urgencia default = 'media' (no 'alta')
 *   - estado_correctivo default = 'Reportado'
 *   - El tipo de servicio se busca/crea por categoría = 'Correctivo'
 *   - color del calendario = ámbar (#f59e0b)
 *   - La fecha programada se elige al crear (por defecto hoy) y admite una
 *     fecha estimada de término opcional.
 *
 * Días de trabajo: el correctivo se puede programar en un rango de fechas, en
 * fechas sueltas (p. ej. 10, 15 y 20 de agosto) o en cualquier combinación de
 * ambos; el técnico solo verá en su calendario los días programados. La grilla
 * la materializa `sincronizarDiasYEventos` (utils/diasServicio).
 */

const prisma = require('../config/prisma');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { puedeVerFinanzasReq, servicioSinPrecios } = require('../utils/visibilidadFinanzas');
const { datosSitioParaServicio } = require('../utils/datosSitioAscensor');
const { registrarAuditoria } = require('../utils/auditoria');
const { hmLima, inicioDelDiaLima, parseYMDLima, finDelDiaLima, ymdDeFecha } = require('../utils/tiempo');
const { derivarEjecucion } = require('../utils/ejecucionFechas');
const {
  sincronizarRecordatorioServicio,
  crearAlertaCorrectivoGratuito,
  descartarAlertaCorrectivoGratuito
} = require('../utils/recordatoriosAuto');
const { resolverGratuidad } = require('../utils/gratuidadServicio');
const { paginar } = require('../utils/paginacion');
const { validarConsistenciaAsignaciones } = require('../utils/asignacionesValidaciones');
const { esServicioEditable, esCorrectivoCerrado } = require('../utils/estadoServicio');
const { whereServicioAsignadoSiTecnico } = require('../utils/visibilidadCalendario');
const { subtipoPorDefectoDeModulo, clasificarTipoServicio } = require('../utils/clasificacionServicio');
const { bajaServicioCascadaEnTx, purgarObjetosWasabi, liberarTecnicos } = require('../utils/reversionEliminacion');
const {
  sincronizarDiasYEventos,
  reprogramarConservandoForma,
  ConfirmacionRequeridaError
} = require('../utils/diasServicio');
const { normalizarProgramacion } = require('../utils/programacionDias');
const { visibilidadPorAscensorWhere, aplicarVisibilidadWhere } = require('../utils/visibilidadEdificio');
const { porAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');

const ROLES_PRECIO_COR = ['super_admin', 'admin', 'contabilidad'];

// Devuelve un correctivo por id con la misma forma que una fila del listado
// (incluye servicio + ejecución). Lo consume el frontend para abrir el modal de
// edición desde la página del servicio (ServicioDetalle → /correctivos?edit=ID).
const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const c = await prisma.tbl_correctivos.findFirst({
      where: { id, estado: 1 },
      include: {
        cliente: true,
        ascensor: { include: { edificio: true } },
        servicio: {
          include: {
            asignaciones: { include: { tecnico: true }, where: { estado: 1 } },
            // Grilla de días programados: el formulario de edición precarga con
            // ella la programación (rangos y/o fechas sueltas).
            dias: { where: { estado: 1 }, orderBy: { fecha: 'asc' } },
            historial_estados: true,
            servicio_realizado: true
          }
        }
      }
    });
    if (!c) return res.status(404).json({ error: 'Correctivo no encontrado' });
    // El servicio vinculado trae `precio_interno`: se anula para quien no puede
    // ver datos económicos (el formulario ya le oculta el campo de precio).
    const servicioCorr = puedeVerFinanzasReq(req) ? c.servicio : servicioSinPrecios(c.servicio);
    res.json({ data: { ...c, servicio: servicioCorr, ejecucion: derivarEjecucion(c.servicio) } });
  } catch (err) {
    console.error('[correctivos.obtener]', err);
    res.status(500).json({ error: 'Error al obtener correctivo' });
  }
};

const listar = async (req, res) => {
  try {
    const { estado_correctivo, nivel_urgencia, id_cliente, q } = req.query;
    const where = { estado: 1 };
    if (estado_correctivo) where.estado_correctivo = estado_correctivo;
    if (nivel_urgencia) where.nivel_urgencia = nivel_urgencia;
    if (id_cliente) where.id_cliente = Number(id_cliente);
    // Buscador libre: edificio/obra, cliente, ascensor, distrito, falla y código del servicio.
    if (q) where.OR = [
      { falla: { contains: q, mode: 'insensitive' } },
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      { ascensor: { codigo: { contains: q, mode: 'insensitive' } } },
      { ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } },
      { ascensor: { edificio: { distrito: { contains: q, mode: 'insensitive' } } } },
      { servicio: { codigo: { contains: q, mode: 'insensitive' } } }
    ];
    const filtroServicio = whereServicioAsignadoSiTecnico(req.user);
    if (filtroServicio) where.servicio = filtroServicio;
    // Oculta a roles distintos de super_admin los correctivos de edificios inactivos.
    aplicarVisibilidadWhere(where, visibilidadPorAscensorWhere(req.user));
    // Alcance por tipo de edificio (Administrador acotado a Edificios u Obras).
    conAlcance(where, porAscensorEdificioWhere(req.user));

    const result = await paginar(
      prisma.tbl_correctivos,
      {
        where,
        orderBy: { id: 'desc' },
        include: {
          cliente: true,
          ascensor: { include: { edificio: true } },
          servicio: {
            include: {
              asignaciones: { include: { tecnico: true }, where: { estado: 1 } },
              dias: { where: { estado: 1 }, orderBy: { fecha: 'asc' } },
              historial_estados: true,
              servicio_realizado: true
            }
          }
        }
      },
      req.query
    );
    // Fechas de ejecución (inicio/fin de trabajo derivados del historial de
    // estados del servicio) para las columnas del listado.
    const verFinanzas = puedeVerFinanzasReq(req);
    result.data = result.data.map(c => ({
      ...c,
      servicio: verFinanzas ? c.servicio : servicioSinPrecios(c.servicio),
      ejecucion: derivarEjecucion(c.servicio)
    }));
    res.json(result);
  } catch (err) {
    console.error('[correctivos.listar]', err);
    res.status(500).json({ error: 'Error al listar correctivos' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_cliente || !d.id_ascensor || !d.falla) {
      return res.status(400).json({ error: 'Cliente, ascensor y descripción de la falla son obligatorios' });
    }
    // Un ascensor con la instalación cancelada no admite servicios.
    const ascSel = await prisma.tbl_ascensores.findUnique({ where: { id: Number(d.id_ascensor) }, select: { estado_operativo: true } });
    if (ascSel?.estado_operativo === 'Instalación cancelada') {
      return res.status(400).json({ error: 'Este ascensor tiene la instalación cancelada y no admite servicios.' });
    }
    // Gratuidad y facturación las decide utils/gratuidadServicio (SSoT):
    // un rol sin visibilidad financiera solo registra correctivos gratuitos, y
    // lo gratuito nunca lleva factura. El default del módulo cuando SÍ se cobra
    // es "con factura" (1).
    const { sinCobro, requiereFactura, fijaPrecio, gratuidadImpuesta } =
      resolverGratuidad(req, d, { requiereFacturaPorDefecto: 1 });
    // Un correctivo gratuito registrado por quien no gestiona precios es una
    // decisión económica que administración debe poder revisar: se le avisa
    // (ver crearAlertaCorrectivoGratuito).
    const gratuitoRequiereAviso = gratuidadImpuesta;
    if (fijaPrecio && !sinCobro && (d.precio_interno === undefined || d.precio_interno === null || d.precio_interno === '')) {
      return res.status(400).json({ error: 'Precio obligatorio' });
    }
    const precioFinal = (sinCobro || !fijaPrecio) ? 0 : d.precio_interno;

    const tecnicos = Array.isArray(d.tecnicos) ? d.tecnicos : [];

    const consistencia = validarConsistenciaAsignaciones(tecnicos);
    if (!consistencia.ok) return res.status(400).json({ error: consistencia.error });

    // Fechas de agenda: fecha programada elegible (por defecto hoy) y fecha
    // estimada de término opcional para ocupar varios días en el calendario.
    // Días de trabajo: rangos y/o fechas sueltas (ver utils/programacionDias).
    // Sin `dias`, el correctivo ocupa un único día (el clásico fecha_programada).
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
    // Subtipo vinculado al módulo Correctivos (SSoT).
    const tipoCorrectivo = await subtipoPorDefectoDeModulo(prisma, 'correctivo');
    if (!tipoCorrectivo) {
      return res.status(400).json({ error: 'No hay un subtipo de servicio vinculado al módulo Correctivos. Créelo en Tipos de servicio.' });
    }
    const { tipo_registro: tipoRegistroCor } = clasificarTipoServicio(tipoCorrectivo);
    const nivelUrgencia = d.nivel_urgencia || 'media';
    // Contacto en sitio y cuarto de máquinas heredados de la ficha del ascensor.
    const datosSitio = await datosSitioParaServicio(prisma, [d.id_ascensor], d);

    const servicio = await prisma.tbl_servicios_proyectos.create({
      data: {
        codigo,
        tipo_registro: tipoRegistroCor,
        id_tipo_servicio: tipoCorrectivo.id,
        id_cliente: Number(d.id_cliente),
        origen: 'correctivo',
        titulo: `Correctivo – ${d.falla.substring(0, 80)}`,
        descripcion: d.falla,
        fecha_programada: fechaProgramada,
        hora_programada: horaProgramada,
        duracion_dias: fechasProgramacion ? fechasProgramacion.length : 1,
        fecha_estimada_entrega: fechaEstimadaEntrega,
        prioridad: nivelUrgencia,
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

    const correctivo = await prisma.tbl_correctivos.create({
      data: {
        id_servicio: servicio.id,
        id_cliente: Number(d.id_cliente),
        id_ascensor: Number(d.id_ascensor),
        falla: d.falla,
        nivel_urgencia: nivelUrgencia,
        estado_correctivo: tecnicos.length > 0 ? 'En atención' : 'Reportado',
        observaciones: d.observaciones || null,
        user_id_registration: req.user.id
      }
    });

    // Grilla de días + un evento de calendario por día programado. Con un solo
    // día se conserva el comportamiento previo (evento único que puede
    // extenderse hasta la fecha estimada de término).
    await sincronizarDiasYEventos(prisma, servicio.id, {
      userId: req.user.id,
      fechas: fechasProgramacion,
      tituloBase: `CORRECTIVO ${servicio.codigo}`,
      tipoEvento: 'correctivo',
      fechaFinEvento: fechaEstimadaEntrega ? finDelDiaLima(fechaEstimadaEntrega) : null
    });

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
      id_usuario: req.user.id, entidad: 'tbl_correctivos', id_entidad: correctivo.id,
      accion: 'CREATE', valor_nuevo: correctivo, ip: req.ip
    });
    sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync rec servicio:', err));
    if (gratuitoRequiereAviso) {
      crearAlertaCorrectivoGratuito(correctivo.id, { usuarioId: req.user.id })
        .catch(err => console.error('Alerta correctivo gratuito:', err));
    }
    res.status(201).json({ data: { correctivo, servicio } });
  } catch (err) {
    console.error('[correctivos.crear]', err);
    res.status(500).json({ error: 'Error al crear correctivo: ' + err.message });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_correctivos.findUnique({
      where: { id },
      include: { servicio: { include: { ascensores: { where: { estado: 1 } } } } }
    });
    if (!previo) return res.status(404).json({ error: 'No encontrado' });

    if (esCorrectivoCerrado(previo.estado_correctivo)) {
      return res.status(409).json({ error: 'El correctivo ya está cerrado y no se puede editar.' });
    }

    const servicioPrevio = previo.servicio;
    const cambiaServicio = (
      d.id_cliente !== undefined ||
      d.id_ascensor !== undefined ||
      d.precio_interno !== undefined ||
      d.sin_cobro !== undefined ||
      d.falla !== undefined ||
      d.nivel_urgencia !== undefined ||
      d.moneda !== undefined ||
      d.requiere_factura !== undefined
    );
    if (cambiaServicio && servicioPrevio && !esServicioEditable(servicioPrevio.estado_servicio)) {
      return res.status(409).json({
        error: `El servicio asociado está en "${servicioPrevio.estado_servicio}" y no admite cambios. Solo es editable antes de salir a campo.`
      });
    }

    const puedeCambiarPrecio = ROLES_PRECIO_COR.includes(req.user.rol_codigo);
    // La gratuidad solo la cambia quien gestiona precios. Un rol sin
    // visibilidad financiera conserva el valor que ya tenía el servicio: no
    // puede volver cobrable un correctivo gratuito, ni regalar uno que
    // administración dejó de pago.
    const sinCobroNuevo = (puedeCambiarPrecio && d.sin_cobro !== undefined)
      ? (d.sin_cobro === true || d.sin_cobro === 1 || d.sin_cobro === '1' ? 1 : 0)
      : servicioPrevio?.sin_cobro;
    const precioRecibido = d.precio_interno !== undefined ? Number(d.precio_interno) : null;
    const precioFinal = sinCobroNuevo === 1 ? 0 : (puedeCambiarPrecio && precioRecibido !== null ? precioRecibido : Number(servicioPrevio?.precio_interno || 0));
    // Gratuito ⇒ sin factura, también al editar: si el servicio queda sin cobro
    // la bandera se apaga aunque el payload pida lo contrario.
    const requiereFacturaNuevo = sinCobroNuevo === 1
      ? 0
      : (d.requiere_factura !== undefined
        ? (d.requiere_factura === true || d.requiere_factura === 1 || d.requiere_factura === '1' ? 1 : 0)
        : servicioPrevio?.requiere_factura);
    const nuevaFalla = d.falla ?? previo.falla;
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

    if (cambiaServicio) {
      const ascBD = await prisma.tbl_ascensores.findUnique({ where: { id: nuevoIdAscensor }, include: { edificio: { select: { id_cliente: true } } } });
      if (!ascBD || ascBD.estado !== 1) {
        return res.status(400).json({ error: 'Ascensor inválido o inactivo' });
      }
      if (ascBD.edificio?.id_cliente !== nuevoIdCliente) {
        return res.status(400).json({ error: `El ascensor ${ascBD.codigo} no pertenece al cliente seleccionado` });
      }
    }

    let correctivoActualizado;
    try {
      correctivoActualizado = await prisma.$transaction(async (tx) => {
      const c = await tx.tbl_correctivos.update({
        where: { id },
        data: {
          id_cliente: nuevoIdCliente,
          id_ascensor: nuevoIdAscensor,
          falla: nuevaFalla,
          nivel_urgencia: nuevoNivel,
          estado_correctivo: d.estado_correctivo ?? previo.estado_correctivo,
          observaciones: d.observaciones ?? previo.observaciones,
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });

      if (servicioPrevio) {
        await tx.tbl_servicios_proyectos.update({
          where: { id: servicioPrevio.id },
          data: {
            id_cliente: nuevoIdCliente,
            titulo: `Correctivo – ${nuevaFalla.substring(0, 80)}`,
            descripcion: nuevaFalla,
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
            tituloBase: `CORRECTIVO ${servicioPrevio.codigo}`,
            tipoEvento: 'correctivo',
            fechaFinEvento: nuevaFechaEstimada ? finDelDiaLima(nuevaFechaEstimada) : null
          });
        }
      }
      return c;
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
      id_usuario: req.user.id, entidad: 'tbl_correctivos', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: correctivoActualizado, ip: req.ip
    });
    if (servicioPrevio) {
      sincronizarRecordatorioServicio(servicioPrevio.id).catch(err => console.error('Sync rec servicio:', err));
    }
    // Cuando administración le fija un precio a un correctivo que estaba
    // gratuito, la alerta pendiente se cierra sola: ya la revisó. (La alerta
    // solo NACE en el alta: editando, un rol sin visibilidad financiera ya no
    // puede cambiar la gratuidad.)
    if (sinCobroNuevo !== 1 && servicioPrevio?.sin_cobro === 1) {
      descartarAlertaCorrectivoGratuito(id)
        .catch(err => console.error('Descarte alerta correctivo gratuito:', err));
    }
    res.json({ data: correctivoActualizado });
  } catch (err) {
    console.error('[correctivos.actualizar]', err);
    res.status(500).json({ error: 'Error al actualizar correctivo: ' + err.message });
  }
};

/**
 * Soft-delete de un correctivo: estado = 0. Igual que Emergencias, cada
 * correctivo posee un servicio vinculado (1:1); la baja arrastra ese servicio y
 * TODA su cascada (asignaciones, evidencias, cobro, facturas, folder
 * contable, eventos de calendario, recordatorios) vía el motor de reversión,
 * limpia los archivos en Wasabi y libera a los técnicos sin otros servicios
 * activos. No borra físicamente: queda auditado y recuperable. Solo Super Admin.
 */
const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await prisma.tbl_correctivos.findUnique({
      where: { id },
      include: { servicio: { include: { asignaciones: { where: { estado: 1 } } } } }
    });
    if (!previo) return res.status(404).json({ error: 'Correctivo no encontrado' });

    const idServicio = previo.id_servicio;
    let wasabiKeys = [];
    let tecnicoIds = [];
    await prisma.$transaction(async (tx) => {
      const correctivo = await tx.tbl_correctivos.update({
        where: { id },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });

      if (idServicio) {
        const r = await bajaServicioCascadaEnTx(tx, idServicio, req.user.id);
        wasabiKeys = r.wasabiKeys;
        tecnicoIds = r.tecnicoIds;
      }

      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_correctivos', id_entidad: id,
        accion: 'DELETE', valor_anterior: previo, valor_nuevo: correctivo, ip: req.ip
      });
    });

    await purgarObjetosWasabi(wasabiKeys);
    await liberarTecnicos(tecnicoIds, idServicio);

    res.json({ ok: true });
  } catch (err) {
    console.error('[correctivos.eliminar]', err);
    res.status(500).json({ error: 'Error al eliminar correctivo: ' + err.message });
  }
};

module.exports = { listar, obtener, crear, actualizar, eliminar };

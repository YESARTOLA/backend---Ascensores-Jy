/**
 * Mantenimientos correctivos.
 *
 * Reparación reactiva (no urgente, no programada). El patrón sigue al de
 * Emergencias: cada correctivo crea siempre un servicio vinculado para
 * heredar el flujo de asignaciones / checklist / evidencias / cobro.
 *
 * Diferencias frente a Emergencias:
 *   - nivel_urgencia default = 'media' (no 'alta')
 *   - estado_correctivo default = 'Reportado'
 *   - El tipo de servicio se busca/crea por categoría = 'Correctivo'
 *   - color del calendario = ámbar (#f59e0b)
 *   - La fecha programada se elige al crear (por defecto hoy) y admite una
 *     fecha estimada de término opcional para ocupar varios días en agenda.
 */

const prisma = require('../config/prisma');
const { ESTADO_EVENTO_PROGRAMADO } = require('../utils/estadoEvento');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { datosSitioParaServicio } = require('../utils/datosSitioAscensor');
const { registrarAuditoria } = require('../utils/auditoria');
const { hmLima, inicioDelDiaLima, parseYMDLima, combinarFechaHoraLima, finDelDiaLima } = require('../utils/tiempo');
const { derivarEjecucion } = require('../utils/ejecucionFechas');
const { sincronizarRecordatorioServicio } = require('../utils/recordatoriosAuto');
const { paginar } = require('../utils/paginacion');
const { validarConsistenciaAsignaciones } = require('../utils/asignacionesValidaciones');
const { esServicioEditable, esCorrectivoCerrado } = require('../utils/estadoServicio');
const { whereServicioAsignadoSiTecnico } = require('../utils/visibilidadCalendario');
const { subtipoPorDefectoDeModulo, clasificarTipoServicio } = require('../utils/clasificacionServicio');
const { bajaServicioCascadaEnTx, purgarObjetosWasabi, liberarTecnicos } = require('../utils/reversionEliminacion');
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
            historial_estados: true,
            servicio_realizado: true
          }
        }
      }
    });
    if (!c) return res.status(404).json({ error: 'Correctivo no encontrado' });
    res.json({ data: { ...c, ejecucion: derivarEjecucion(c.servicio) } });
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
    result.data = result.data.map(c => ({ ...c, ejecucion: derivarEjecucion(c.servicio) }));
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
    const sinCobro = d.sin_cobro === true || d.sin_cobro === 1 || d.sin_cobro === '1';
    if (!sinCobro && (d.precio_interno === undefined || d.precio_interno === null || d.precio_interno === '')) {
      return res.status(400).json({ error: 'Precio obligatorio' });
    }
    const precioFinal = sinCobro ? 0 : d.precio_interno;
    // Bandera persistida "requiere factura": default del módulo Correctivos = 1
    // (con factura). Editable desde el formulario de creación.
    const requiereFactura = d.requiere_factura === undefined
      ? 1
      : (d.requiere_factura === true || d.requiere_factura === 1 || d.requiere_factura === '1' ? 1 : 0);

    const tecnicos = Array.isArray(d.tecnicos) ? d.tecnicos : [];
    const items_checklist = Array.isArray(d.items_checklist) ? d.items_checklist : [];

    const consistencia = validarConsistenciaAsignaciones(tecnicos);
    if (!consistencia.ok) return res.status(400).json({ error: consistencia.error });

    // Fechas de agenda: fecha programada elegible (por defecto hoy) y fecha
    // estimada de término opcional para ocupar varios días en el calendario.
    const fechaProgramada = d.fecha_programada ? parseYMDLima(d.fecha_programada) : inicioDelDiaLima();
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
        fecha_estimada_entrega: fechaEstimadaEntrega,
        prioridad: nivelUrgencia,
        estado_servicio: tecnicos.length > 0
          ? (items_checklist.length > 0 ? 'Checklist de salida pendiente' : 'Asignado')
          : 'Pendiente',
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

    await prisma.tbl_calendario_eventos.create({
      data: {
        id_servicio: servicio.id,
        titulo: `CORRECTIVO ${servicio.codigo}`,
        tipo_evento: 'correctivo',
        fecha_inicio: combinarFechaHoraLima(fechaProgramada, horaProgramada),
        fecha_fin: fechaEstimadaEntrega ? finDelDiaLima(fechaEstimadaEntrega) : null,
        estado_evento: ESTADO_EVENTO_PROGRAMADO,
        color: '#f59e0b'
      }
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
            responsable_checklist: t.responsable_checklist ? 1 : 0,
            asignado_por: req.user.id,
            user_id_registration: req.user.id
          }
        });
      }

      const tecChecklist = tecnicos.find(t => t.responsable_checklist) || tecnicos[0];
      if (tecChecklist?.id_tecnico) {
        const checklist = await prisma.tbl_checklists_salida.create({
          data: {
            id_servicio: servicio.id,
            id_tecnico_responsable: Number(tecChecklist.id_tecnico),
            estado_checklist: items_checklist.length > 0 ? 'En llenado' : 'Pendiente',
            user_id_registration: req.user.id
          }
        });
        for (const it of items_checklist) {
          if (!it.nombre) continue;
          await prisma.tbl_checklists_salida_items.create({
            data: {
              id_checklist: checklist.id,
              tipo_item: it.tipo_item || 'Herramienta',
              nombre: it.nombre,
              cantidad: it.cantidad || 1,
              unidad: it.unidad || 'Unidad',
              observaciones: it.observaciones || null,
              user_id_registration: req.user.id
            }
          });
        }
      }
    }

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_correctivos', id_entidad: correctivo.id,
      accion: 'CREATE', valor_nuevo: correctivo, ip: req.ip
    });
    sincronizarRecordatorioServicio(servicio.id).catch(err => console.error('Sync rec servicio:', err));
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
    const sinCobroNuevo = d.sin_cobro !== undefined
      ? (d.sin_cobro === true || d.sin_cobro === 1 || d.sin_cobro === '1' ? 1 : 0)
      : servicioPrevio?.sin_cobro;
    const precioRecibido = d.precio_interno !== undefined ? Number(d.precio_interno) : null;
    const precioFinal = sinCobroNuevo === 1 ? 0 : (puedeCambiarPrecio && precioRecibido !== null ? precioRecibido : Number(servicioPrevio?.precio_interno || 0));
    const requiereFacturaNuevo = d.requiere_factura !== undefined
      ? (d.requiere_factura === true || d.requiere_factura === 1 || d.requiere_factura === '1' ? 1 : 0)
      : servicioPrevio?.requiere_factura;
    const nuevaFalla = d.falla ?? previo.falla;
    const nuevoNivel = d.nivel_urgencia ?? previo.nivel_urgencia;
    const nuevaMoneda = d.moneda ?? servicioPrevio?.moneda ?? 'PEN';
    const nuevoIdCliente = d.id_cliente ? Number(d.id_cliente) : (servicioPrevio?.id_cliente ?? previo.id_cliente);
    const nuevoIdAscensor = d.id_ascensor ? Number(d.id_ascensor) : (servicioPrevio?.id_ascensor ?? previo.id_ascensor);

    // Fechas de agenda (opcionales en el payload: si no vienen, se conservan).
    const nuevaFechaProgramada = d.fecha_programada !== undefined
      ? (d.fecha_programada ? parseYMDLima(d.fecha_programada) : servicioPrevio?.fecha_programada)
      : servicioPrevio?.fecha_programada;
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

    const correctivoActualizado = await prisma.$transaction(async (tx) => {
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

        await tx.tbl_calendario_eventos.updateMany({
          where: { id_servicio: servicioPrevio.id, estado: 1 },
          data: {
            titulo: `CORRECTIVO ${servicioPrevio.codigo}`,
            ...(nuevaFechaProgramada ? { fecha_inicio: combinarFechaHoraLima(nuevaFechaProgramada, nuevaHoraProgramada) } : {}),
            fecha_fin: nuevaFechaEstimada ? finDelDiaLima(nuevaFechaEstimada) : null,
            user_id_modification: req.user.id, date_time_modification: new Date()
          }
        });
      }
      return c;
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_correctivos', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: correctivoActualizado, ip: req.ip
    });
    if (servicioPrevio) {
      sincronizarRecordatorioServicio(servicioPrevio.id).catch(err => console.error('Sync rec servicio:', err));
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
 * TODA su cascada (asignaciones, checklist, evidencias, cobro, facturas, folder
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

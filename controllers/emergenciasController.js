const prisma = require('../config/prisma');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { registrarAuditoria } = require('../utils/auditoria');
const { hmLima, inicioDelDiaLima } = require('../utils/tiempo');
const { sincronizarRecordatorioEmergencia, sincronizarRecordatorioServicio } = require('../utils/recordatoriosAuto');
const { paginar } = require('../utils/paginacion');
const { derivarEjecucion } = require('../utils/ejecucionFechas');
const { validarConsistenciaAsignaciones } = require('../utils/asignacionesValidaciones');
const { esServicioEditable, esEmergenciaCerrada } = require('../utils/estadoServicio');
const { whereServicioAsignadoSiTecnico } = require('../utils/visibilidadCalendario');
const { subtipoPorDefectoDeModulo, clasificarTipoServicio } = require('../utils/clasificacionServicio');

const ROLES_PRECIO_EM = ['super_admin', 'admin', 'contabilidad'];

const listar = async (req, res) => {
  try {
    const { estado_emergencia } = req.query;
    const where = { estado: 1 };
    if (estado_emergencia) where.estado_emergencia = estado_emergencia;
    const filtroServicio = whereServicioAsignadoSiTecnico(req.user);
    if (filtroServicio) where.servicio = filtroServicio;
    const result = await paginar(
      prisma.tbl_emergencias,
      {
        where, orderBy: { id: 'desc' },
        include: {
          cliente: true,
          ascensor: true,
          servicio: {
            include: {
              asignaciones: { include: { tecnico: true }, where: { estado: 1 } },
              historial_estados: { where: { estado: 1 }, orderBy: { fecha_cambio: 'asc' } },
              servicio_realizado: { select: { fecha_realizacion: true } }
            }
          }
        }
      },
      req.query
    );
    const data = result.data.map(em => ({
      ...em,
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
    const sinCobro = d.sin_cobro === true || d.sin_cobro === 1 || d.sin_cobro === '1';
    if (!sinCobro && (d.precio_interno === undefined || d.precio_interno === null || d.precio_interno === '')) {
      return res.status(400).json({ error: 'Precio obligatorio' });
    }
    const precioFinal = sinCobro ? 0 : d.precio_interno;

    const tecnicos = Array.isArray(d.tecnicos) ? d.tecnicos : [];
    const items_checklist = Array.isArray(d.items_checklist) ? d.items_checklist : [];

    const consistencia = validarConsistenciaAsignaciones(tecnicos);
    if (!consistencia.ok) return res.status(400).json({ error: consistencia.error });

    const codigo = await generarCodigoServicio();
    // Subtipo vinculado al módulo Emergencias (SSoT). Sin él no se puede clasificar.
    const tipoEmergencia = await subtipoPorDefectoDeModulo(prisma, 'emergencia');
    if (!tipoEmergencia) {
      return res.status(400).json({ error: 'No hay un subtipo de servicio vinculado al módulo Emergencias. Créelo en Tipos de servicio.' });
    }
    const { tipo_registro: tipoRegistroEm } = clasificarTipoServicio(tipoEmergencia);

    const servicio = await prisma.tbl_servicios_proyectos.create({
      data: {
        codigo,
        tipo_registro: tipoRegistroEm,
        id_tipo_servicio: tipoEmergencia.id,
        id_cliente: Number(d.id_cliente),
        origen: 'emergencia',
        titulo: `Emergencia – ${d.motivo.substring(0, 80)}`,
        descripcion: d.motivo,
        fecha_programada: inicioDelDiaLima(),
        hora_programada: hmLima(),
        prioridad: d.nivel_urgencia || 'alta',
        estado_servicio: tecnicos.length > 0 ? (items_checklist.length > 0 ? 'Checklist de salida pendiente' : 'Asignado') : 'Pendiente',
        precio_interno: precioFinal,
        moneda: d.moneda || 'PEN',
        sin_cobro: sinCobro ? 1 : 0,
        observaciones: d.observaciones || null,
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

    await prisma.tbl_calendario_eventos.create({
      data: {
        id_servicio: servicio.id, id_emergencia: emergencia.id,
        titulo: `EMERGENCIA ${servicio.codigo}`,
        tipo_evento: 'emergencia',
        fecha_inicio: new Date(),
        estado_evento: 'programado',
        color: '#ef4444'
      }
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
            responsable_checklist: t.responsable_checklist ? 1 : 0,
            asignado_por: req.user.id,
            user_id_registration: req.user.id
          }
        });
      }

      // Crear checklist asociado
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
      d.moneda !== undefined
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
    const nuevoMotivo = d.motivo ?? previo.motivo;
    const nuevoNivel = d.nivel_urgencia ?? previo.nivel_urgencia;
    const nuevaMoneda = d.moneda ?? servicioPrevio?.moneda ?? 'PEN';
    const nuevoIdCliente = d.id_cliente ? Number(d.id_cliente) : (servicioPrevio?.id_cliente ?? previo.id_cliente);
    const nuevoIdAscensor = d.id_ascensor ? Number(d.id_ascensor) : (servicioPrevio?.id_ascensor ?? previo.id_ascensor);

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

    const emergenciaActualizada = await prisma.$transaction(async (tx) => {
      const em = await tx.tbl_emergencias.update({
        where: { id },
        data: {
          id_cliente: nuevoIdCliente,
          id_ascensor: nuevoIdAscensor,
          motivo: nuevoMotivo,
          nivel_urgencia: nuevoNivel,
          estado_emergencia: d.estado_emergencia ?? previo.estado_emergencia,
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

        // Actualizar título del evento de calendario
        await tx.tbl_calendario_eventos.updateMany({
          where: { id_servicio: servicioPrevio.id, estado: 1 },
          data: { titulo: `EMERGENCIA ${servicioPrevio.codigo}`, user_id_modification: req.user.id, date_time_modification: new Date() }
        });
      }
      return em;
    });

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

module.exports = { listar, crear, actualizar };

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
 *   - No requiere fecha programada explícita: se programa para hoy y la
 *     coordinación puede reprogramarlo desde el detalle del servicio.
 */

const prisma = require('../config/prisma');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { registrarAuditoria } = require('../utils/auditoria');
const { hmLima, inicioDelDiaLima } = require('../utils/tiempo');
const { sincronizarRecordatorioServicio } = require('../utils/recordatoriosAuto');
const { paginar } = require('../utils/paginacion');
const { validarConsistenciaAsignaciones } = require('../utils/asignacionesValidaciones');
const { esServicioEditable, esCorrectivoCerrado } = require('../utils/estadoServicio');
const { whereServicioAsignadoSiTecnico } = require('../utils/visibilidadCalendario');

const ROLES_PRECIO_COR = ['super_admin', 'admin', 'contabilidad'];

/**
 * Asegura que exista un tipo de servicio para correctivos y devuelve su id.
 * Reutiliza el tipo cargado por el seed con categoría "Mantenimiento correctivo".
 * Si no existe (entorno fresco), lo crea — idempotente.
 */
async function asegurarTipoCorrectivo() {
  const existente = await prisma.tbl_tipos_servicio.findFirst({
    where: { categoria: { in: ['Mantenimiento correctivo', 'Correctivo'] }, estado: 1 }
  });
  if (existente) return existente.id;
  const creado = await prisma.tbl_tipos_servicio.create({
    data: {
      nombre: 'Mantenimiento correctivo',
      categoria: 'Mantenimiento correctivo',
      descripcion: 'Corrección de fallas detectadas'
    }
  });
  return creado.id;
}

const listar = async (req, res) => {
  try {
    const { estado_correctivo, nivel_urgencia, id_cliente } = req.query;
    const where = { estado: 1 };
    if (estado_correctivo) where.estado_correctivo = estado_correctivo;
    if (nivel_urgencia) where.nivel_urgencia = nivel_urgencia;
    if (id_cliente) where.id_cliente = Number(id_cliente);
    const filtroServicio = whereServicioAsignadoSiTecnico(req.user);
    if (filtroServicio) where.servicio = filtroServicio;

    const result = await paginar(
      prisma.tbl_correctivos,
      {
        where,
        orderBy: { id: 'desc' },
        include: {
          cliente: true,
          ascensor: true,
          servicio: { include: { asignaciones: { include: { tecnico: true }, where: { estado: 1 } } } }
        }
      },
      req.query
    );
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
    const idTipo = await asegurarTipoCorrectivo();
    const nivelUrgencia = d.nivel_urgencia || 'media';

    const servicio = await prisma.tbl_servicios_proyectos.create({
      data: {
        codigo,
        tipo_registro: 'servicio',
        id_tipo_servicio: idTipo,
        id_cliente: Number(d.id_cliente),
        origen: 'correctivo',
        titulo: `Correctivo – ${d.falla.substring(0, 80)}`,
        descripcion: d.falla,
        fecha_programada: inicioDelDiaLima(),
        hora_programada: hmLima(),
        prioridad: nivelUrgencia,
        estado_servicio: tecnicos.length > 0
          ? (items_checklist.length > 0 ? 'Checklist de salida pendiente' : 'Asignado')
          : 'Pendiente',
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
        fecha_inicio: new Date(),
        estado_evento: 'programado',
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
      d.moneda !== undefined
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
    const nuevaFalla = d.falla ?? previo.falla;
    const nuevoNivel = d.nivel_urgencia ?? previo.nivel_urgencia;
    const nuevaMoneda = d.moneda ?? servicioPrevio?.moneda ?? 'PEN';
    const nuevoIdCliente = d.id_cliente ? Number(d.id_cliente) : (servicioPrevio?.id_cliente ?? previo.id_cliente);
    const nuevoIdAscensor = d.id_ascensor ? Number(d.id_ascensor) : (servicioPrevio?.id_ascensor ?? previo.id_ascensor);

    if (cambiaServicio) {
      const ascBD = await prisma.tbl_ascensores.findUnique({ where: { id: nuevoIdAscensor } });
      if (!ascBD || ascBD.estado !== 1) {
        return res.status(400).json({ error: 'Ascensor inválido o inactivo' });
      }
      if (ascBD.id_cliente !== nuevoIdCliente) {
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
          data: { titulo: `CORRECTIVO ${servicioPrevio.codigo}`, user_id_modification: req.user.id, date_time_modification: new Date() }
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

module.exports = { listar, crear, actualizar };

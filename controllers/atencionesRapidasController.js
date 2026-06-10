const prisma = require('../config/prisma');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima } = require('../utils/tiempo');
const { registrarAuditoria } = require('../utils/auditoria');
const { esAtencionRapidaConvertida } = require('../utils/estadoServicio');
const { replicarEnModulo } = require('../utils/replicarEnModulo');
const { clasificarTipoServicio } = require('../utils/clasificacionServicio');

const listar = async (req, res) => {
  try {
    const result = await paginar(
      prisma.tbl_atenciones_rapidas,
      { where: { estado: 1 }, orderBy: { id: 'desc' }, include: { cliente: true, ascensor: true } },
      req.query
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar atenciones rápidas' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.nombre_contacto || !d.telefono) {
      return res.status(400).json({ error: 'Nombre y teléfono obligatorios' });
    }
    const at = await prisma.tbl_atenciones_rapidas.create({
      data: {
        nombre_contacto: d.nombre_contacto,
        telefono: d.telefono,
        mensaje_rapido: d.mensaje_rapido || null,
        tipo_solicitud: d.tipo_solicitud || null,
        nivel_urgencia: d.nivel_urgencia || 'media',
        estado_atencion: 'nueva',
        id_cliente: d.id_cliente ? Number(d.id_cliente) : null,
        id_ascensor: d.id_ascensor ? Number(d.id_ascensor) : null,
        id_tecnico_asignado: d.id_tecnico_asignado ? Number(d.id_tecnico_asignado) : null,
        observaciones: d.observaciones || null,
        user_id_registration: req.user.id
      }
    });
    res.status(201).json({ data: at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear atención' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_atenciones_rapidas.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Atención no encontrada' });

    // Una vez convertida, el servicio generado es la fuente de verdad. Editar
    // la atención no propagaría cambios al servicio y generaría confusión.
    if (esAtencionRapidaConvertida(previo.estado_atencion)) {
      return res.status(409).json({ error: 'La atención ya fue convertida en servicio y no se puede editar.' });
    }

    const at = await prisma.tbl_atenciones_rapidas.update({
      where: { id },
      data: {
        nombre_contacto: d.nombre_contacto ?? previo.nombre_contacto,
        telefono: d.telefono ?? previo.telefono,
        mensaje_rapido: d.mensaje_rapido ?? previo.mensaje_rapido,
        tipo_solicitud: d.tipo_solicitud ?? previo.tipo_solicitud,
        nivel_urgencia: d.nivel_urgencia ?? previo.nivel_urgencia,
        estado_atencion: d.estado_atencion ?? previo.estado_atencion,
        id_cliente: d.id_cliente !== undefined ? (d.id_cliente ? Number(d.id_cliente) : null) : previo.id_cliente,
        id_ascensor: d.id_ascensor !== undefined ? (d.id_ascensor ? Number(d.id_ascensor) : null) : previo.id_ascensor,
        id_tecnico_asignado: d.id_tecnico_asignado !== undefined ? (d.id_tecnico_asignado ? Number(d.id_tecnico_asignado) : null) : previo.id_tecnico_asignado,
        observaciones: d.observaciones ?? previo.observaciones,
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_atenciones_rapidas', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: at, ip: req.ip
    });
    res.json({ data: at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar' });
  }
};

const convertir = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const at = await prisma.tbl_atenciones_rapidas.findUnique({ where: { id } });
    if (!at) return res.status(404).json({ error: 'Atención no encontrada' });
    if (!d.id_cliente || !d.id_ascensor || !d.id_subtipo_servicio || d.precio_interno === undefined) {
      return res.status(400).json({ error: 'Faltan datos para conversión (cliente, ascensor, subtipo y precio)' });
    }

    // El subtipo elegido determina el módulo destino (SSoT). El campo legacy
    // `tipo_conversion` queda obsoleto: el routing lo decide la clasificación.
    const subtipo = await prisma.tbl_tipos_servicio.findUnique({
      where: { id: Number(d.id_subtipo_servicio) }, include: { padre: true }
    });
    if (!subtipo || subtipo.estado !== 1 || subtipo.id_padre == null) {
      return res.status(400).json({ error: 'Subtipo de servicio inválido' });
    }
    let clasif;
    try { clasif = clasificarTipoServicio(subtipo); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const codigo = await generarCodigoServicio();
    // Anclar fecha a Lima TZ con parseYMDLima — `new Date("YYYY-MM-DD")` daría
    // midnight UTC, que en local Perú (UTC-5) se desplaza al día anterior al
    // serializarse a @db.Date.
    const fecha = d.fecha_programada ? parseYMDLima(d.fecha_programada) : new Date();

    const resultado = await prisma.$transaction(async (tx) => {
      const servicio = await tx.tbl_servicios_proyectos.create({
        data: {
          codigo,
          tipo_registro: clasif.tipo_registro,
          id_tipo_servicio: subtipo.id,
          id_cliente: Number(d.id_cliente),
          origen: clasif.modulo_asociado || 'directo',
          titulo: at.tipo_solicitud || at.mensaje_rapido?.substring(0, 80) || 'Atención rápida',
          descripcion: at.mensaje_rapido || null,
          fecha_programada: fecha,
          hora_programada: d.hora_programada || null,
          prioridad: at.nivel_urgencia,
          precio_interno: d.precio_interno,
          moneda: d.moneda || 'PEN',
          observaciones: d.observaciones || null,
          user_id_registration: req.user.id,
          ascensores: {
            create: [{
              id_ascensor: Number(d.id_ascensor),
              monto: d.precio_interno || 0,
              moneda: d.moneda || 'PEN',
              user_id_registration: req.user.id
            }]
          }
        }
      });

      // Replicar en el módulo operativo destino (emergencia/correctivo/mantenimiento).
      // Si el subtipo es del propio módulo Atención Rápida, no se duplica: la atención
      // que estamos convirtiendo es el registro y se marca como convertida abajo.
      if (clasif.modulo_asociado && clasif.modulo_asociado !== 'atencion_rapida') {
        await replicarEnModulo(tx, {
          servicio,
          tipoServicio: subtipo,
          idsAscensores: [Number(d.id_ascensor)],
          idCliente: Number(d.id_cliente),
          horaProgramada: d.hora_programada || null,
          fechaProgramada: fecha,
          usuarioId: req.user.id,
          datosModulo: {
            motivo: at.mensaje_rapido || at.tipo_solicitud,
            falla: at.mensaje_rapido || at.tipo_solicitud,
            nivel_urgencia: at.nivel_urgencia,
          },
          origenEtiqueta: `conversión de atención rápida #${id}`
        });
      }

      await tx.tbl_atenciones_rapidas.update({
        where: { id },
        data: {
          estado_atencion: 'convertida',
          id_servicio_convertido: servicio.id,
          id_cliente: Number(d.id_cliente),
          id_ascensor: Number(d.id_ascensor),
          user_id_modification: req.user.id, date_time_modification: new Date()
        }
      });
      return servicio;
    });
    res.json({ data: { servicio: resultado, atencion_id: id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al convertir: ' + err.message });
  }
};

module.exports = { listar, crear, actualizar, convertir };

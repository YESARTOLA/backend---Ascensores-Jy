const prisma = require('../config/prisma');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima } = require('../utils/tiempo');
const { registrarAuditoria } = require('../utils/auditoria');
const { esAtencionRapidaConvertida } = require('../utils/estadoServicio');

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
    if (!d.id_cliente || !d.id_ascensor || !d.id_tipo_servicio || d.precio_interno === undefined) {
      return res.status(400).json({ error: 'Faltan datos para conversión' });
    }
    const codigo = await generarCodigoServicio();
    const tipoConv = d.tipo_conversion || 'servicio';
    // Anclar fecha a Lima TZ con parseYMDLima — `new Date("YYYY-MM-DD")` daría
    // midnight UTC, que en local Perú (UTC-5) se desplaza al día anterior al
    // serializarse a @db.Date.
    const fecha = d.fecha_programada ? parseYMDLima(d.fecha_programada) : new Date();
    const servicio = await prisma.tbl_servicios_proyectos.create({
      data: {
        codigo,
        tipo_registro: 'servicio',
        id_tipo_servicio: Number(d.id_tipo_servicio),
        id_cliente: Number(d.id_cliente),
        origen: tipoConv === 'emergencia' ? 'emergencia' : 'atencion_rapida',
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

    if (tipoConv === 'emergencia') {
      await prisma.tbl_emergencias.create({
        data: {
          id_servicio: servicio.id,
          id_cliente: Number(d.id_cliente),
          id_ascensor: Number(d.id_ascensor),
          motivo: at.mensaje_rapido || at.tipo_solicitud || 'Emergencia',
          nivel_urgencia: at.nivel_urgencia || 'alta',
          estado_emergencia: 'Reportada',
          user_id_registration: req.user.id
        }
      });
    }

    await prisma.tbl_atenciones_rapidas.update({
      where: { id },
      data: {
        estado_atencion: 'convertida',
        id_servicio_convertido: servicio.id,
        id_cliente: Number(d.id_cliente),
        id_ascensor: Number(d.id_ascensor),
        user_id_modification: req.user.id, date_time_modification: new Date()
      }
    });
    res.json({ data: { servicio, atencion_id: id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al convertir: ' + err.message });
  }
};

module.exports = { listar, crear, actualizar, convertir };

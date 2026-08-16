const prisma = require('../config/prisma');
const { generarCodigoServicio } = require('../utils/codigoServicio');
const { datosSitioParaServicio } = require('../utils/datosSitioAscensor');
const { paginar } = require('../utils/paginacion');
const { parseYMDLima } = require('../utils/tiempo');
const { registrarAuditoria } = require('../utils/auditoria');
const { esAtencionRapidaConvertida } = require('../utils/estadoServicio');
const { replicarEnModulo } = require('../utils/replicarEnModulo');
const { clasificarTipoServicio } = require('../utils/clasificacionServicio');
const { visibilidadPorAscensorWhere, aplicarVisibilidadWhere } = require('../utils/visibilidadEdificio');
const { porAscensorEdificioWhere, conAlcance } = require('../utils/alcanceUsuario');

const listar = async (req, res) => {
  try {
    const { estado_atencion, nivel_urgencia, tipo_solicitud, id_responsable_usuario, q } = req.query;
    const where = { estado: 1 };
    if (estado_atencion) where.estado_atencion = estado_atencion;
    if (nivel_urgencia) where.nivel_urgencia = nivel_urgencia;
    if (tipo_solicitud) where.tipo_solicitud = { contains: tipo_solicitud, mode: 'insensitive' };
    if (id_responsable_usuario) where.id_responsable_usuario = Number(id_responsable_usuario);
    // Buscador libre: contacto, teléfono, mensaje, tipo, responsable, y cliente/ascensor/edificio si están vinculados.
    if (q) where.OR = [
      { nombre_contacto: { contains: q, mode: 'insensitive' } },
      { telefono: { contains: q, mode: 'insensitive' } },
      { mensaje_rapido: { contains: q, mode: 'insensitive' } },
      { tipo_solicitud: { contains: q, mode: 'insensitive' } },
      { responsable: { contains: q, mode: 'insensitive' } },
      { responsable_usuario: { nombres: { contains: q, mode: 'insensitive' } } },
      { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
      { ascensor: { codigo: { contains: q, mode: 'insensitive' } } },
      { ascensor: { edificio: { nombre: { contains: q, mode: 'insensitive' } } } },
      { ascensor: { edificio: { distrito: { contains: q, mode: 'insensitive' } } } }
    ];
    // Oculta a roles distintos de super_admin las atenciones de edificios inactivos
    // (solo si están vinculadas a un ascensor; las libres no se ocultan). El FK
    // id_ascensor es OPCIONAL aquí, así que se habilita la rama "sin ascensor".
    aplicarVisibilidadWhere(where, visibilidadPorAscensorWhere(req.user, { permitirSinAscensor: true }));
    // Alcance por tipo de edificio (Administrador): igual criterio, las atenciones
    // sin ascensor (libres) no se ocultan.
    conAlcance(where, porAscensorEdificioWhere(req.user, { permitirSinAscensor: true }));
    const result = await paginar(
      prisma.tbl_atenciones_rapidas,
      { where, orderBy: { id: 'desc' }, include: { cliente: true, ascensor: true, responsable_usuario: { select: { id: true, nombres: true } } } },
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
        responsable: d.responsable || null,
        id_responsable_usuario: d.id_responsable_usuario ? Number(d.id_responsable_usuario) : null,
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
        responsable: d.responsable ?? previo.responsable,
        id_responsable_usuario: d.id_responsable_usuario !== undefined ? (d.id_responsable_usuario ? Number(d.id_responsable_usuario) : null) : previo.id_responsable_usuario,
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
    // Un ascensor con la instalación cancelada no admite servicios.
    const ascSel = await prisma.tbl_ascensores.findUnique({ where: { id: Number(d.id_ascensor) }, select: { estado_operativo: true } });
    if (ascSel?.estado_operativo === 'Instalación cancelada') {
      return res.status(400).json({ error: 'Este ascensor tiene la instalación cancelada y no admite servicios.' });
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

    const codigo = await generarCodigoServicio(clasif.tipo_registro);
    // Anclar fecha a Lima TZ con parseYMDLima — `new Date("YYYY-MM-DD")` daría
    // midnight UTC, que en local Perú (UTC-5) se desplaza al día anterior al
    // serializarse a @db.Date.
    const fecha = d.fecha_programada ? parseYMDLima(d.fecha_programada) : new Date();

    const resultado = await prisma.$transaction(async (tx) => {
      // Contacto en sitio y cuarto de máquinas heredados de la ficha del ascensor.
      const datosSitio = await datosSitioParaServicio(tx, [d.id_ascensor], d);
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
          ...datosSitio,
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

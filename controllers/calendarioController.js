const prisma = require('../config/prisma');
const { parseYMDLima, parseYMDFinDiaLima } = require('../utils/tiempo');
const {
  incluyeOperativos,
  soloOperativosAsignados,
  tiposRecordatorioPermitidos,
  colorPorTipo
} = require('../utils/visibilidadCalendario');

const listar = async (req, res) => {
  try {
    const { desde, hasta, incluir_recordatorios } = req.query;
    const incluirRec = incluir_recordatorios !== '0';
    const rol = req.user.rol_codigo;

    // 1) Eventos operativos (tbl_calendario_eventos). Si el rol no ve eventos
    //    operativos (p.ej. contabilidad), se omite la consulta por completo.
    let eventos = [];
    if (incluyeOperativos(rol)) {
      const whereEv = { estado: 1 };
      if (desde || hasta) {
        whereEv.fecha_inicio = {};
        if (desde) whereEv.fecha_inicio.gte = parseYMDLima(desde);
        if (hasta) whereEv.fecha_inicio.lte = parseYMDFinDiaLima(hasta);
      }
      if (soloOperativosAsignados(rol)) {
        whereEv.servicio = {
          asignaciones: { some: { id_tecnico: req.user.id_tecnico || -1, estado: 1 } }
        };
      }
      eventos = await prisma.tbl_calendario_eventos.findMany({
        where: whereEv, orderBy: { fecha_inicio: 'asc' },
        include: {
          servicio: { include: { cliente: true, ascensores: { where: { estado: 1 }, include: { ascensor: true } }, tipo_servicio: true, asignaciones: { where: { estado: 1 } } } },
          emergencia: true,
          mantenimiento_plan: {
            include: {
              cliente: {
                select: {
                  id: true, nombre: true,
                  precios: { where: { estado: 1 }, select: { id_tipo_servicio: true, precio: true, moneda: true } }
                }
              },
              ascensor: true,
              tipo_servicio: true
            }
          }
        }
      });
    }

    // 2) Recordatorios (tbl_recordatorios). Se restringe por los tipos
    //    permitidos al rol — contabilidad solo ve 'cobro', coordinador no ve
    //    'cobro', etc.
    let recordatorios = [];
    if (incluirRec) {
      const tiposPermitidos = tiposRecordatorioPermitidos(rol);
      if (tiposPermitidos.length > 0) {
        const whereRec = {
          estado: 1,
          estado_recordatorio: 'pendiente',
          tipo: { in: tiposPermitidos }
        };
        if (desde || hasta) {
          whereRec.fecha_recordatorio = {};
          if (desde) whereRec.fecha_recordatorio.gte = parseYMDLima(desde);
          if (hasta) whereRec.fecha_recordatorio.lte = parseYMDFinDiaLima(hasta);
        }
        const recsRaw = await prisma.tbl_recordatorios.findMany({
          where: whereRec,
          include: {
            servicio: { include: { cliente: true, ascensores: { where: { estado: 1 }, include: { ascensor: true } }, asignaciones: { where: { estado: 1 } } } },
            mantenimiento_plan: { include: { cliente: true, ascensor: true } },
            emergencia: { include: { cliente: true, ascensor: true } },
            cobro: { include: { cliente: true, servicio: true } }
          }
        });
        // Si el rol solo ve operativos asignados (técnico), también filtramos
        // los recordatorios operativos por asignación al técnico.
        const recsPorAsignacion = soloOperativosAsignados(rol)
          ? recsRaw.filter(r => {
              const tecs = r.servicio?.asignaciones || [];
              return tecs.some(a => a.id_tecnico === req.user.id_tecnico);
            })
          : recsRaw;

        // Dedup: un servicio/mantenimiento/emergencia tiene siempre un evento
        // operativo en `tbl_calendario_eventos` y, en paralelo, un recordatorio
        // 'auto' del mismo tipo creado por `sincronizarRecordatorio*`. En el
        // calendario eso provoca duplicados (mismo día, uno 'programado' y
        // otro 'pendiente'). Aquí descartamos el recordatorio auto cuando el
        // evento operativo ya está presente en la respuesta. Los recordatorios
        // sin contraparte operativa (cobro, observacion, cotizacion_urgente,
        // manuales) siguen visibles. La página /recordatorios consulta su
        // propio endpoint y no se ve afectada.
        // Cada set también recoge el id desde el servicio vinculado al evento.
        // Eso cubre el caso en que el evento operativo no llevó el id_plan en
        // sus columnas (datos legacy o eventos creados por otro flujo) pero el
        // servicio sí está vinculado al plan — sin esto el recordatorio del
        // plan se "colaba" como tercer ítem el día del primer mantenimiento.
        const idsServicioConEvento = new Set(eventos.map(e => e.id_servicio).filter(Boolean));
        const idsMantenimientoConEvento = new Set(
          eventos.flatMap(e => [e.id_mantenimiento_plan, e.servicio?.id_mantenimiento_plan]).filter(Boolean)
        );
        const idsEmergenciaConEvento = new Set(eventos.map(e => e.id_emergencia).filter(Boolean));
        const recsFiltrados = recsPorAsignacion.filter(r => {
          if (r.origen !== 'auto') return true;
          if (r.tipo === 'servicio' && r.id_servicio && idsServicioConEvento.has(r.id_servicio)) return false;
          if (r.tipo === 'mantenimiento' && r.id_mantenimiento_plan && idsMantenimientoConEvento.has(r.id_mantenimiento_plan)) return false;
          if (r.tipo === 'emergencia' && r.id_emergencia && idsEmergenciaConEvento.has(r.id_emergencia)) return false;
          return true;
        });
        recordatorios = recsFiltrados.map(r => ({
          id: `rec-${r.id}`,
          es_recordatorio: true,
          recordatorio_id: r.id,
          titulo: r.titulo,
          descripcion: r.descripcion,
          tipo_evento: r.tipo,
          estado_evento: r.estado_recordatorio,
          prioridad: r.prioridad,
          color: r.color || colorPorTipo(r.tipo),
          fecha_inicio: r.fecha_recordatorio,
          servicio: r.servicio || (r.cobro?.servicio ? r.cobro.servicio : null),
          emergencia: r.emergencia,
          mantenimiento_plan: r.mantenimiento_plan,
          cobro: r.cobro
        }));
      }
    }

    // Derivar tipo_evento/color desde servicio.tipo_registro. Esto cubre
    // eventos legacy creados antes de diferenciar proyecto/servicio: el dato
    // en BD puede decir tipo_evento='servicio' aunque la fila vinculada en
    // tbl_servicios_proyectos sea de tipo_registro='proyecto'. La fuente única
    // de verdad para el color es `colorPorTipo` del catálogo.
    const eventosNormalizados = eventos.map(e => {
      const esProyecto = e.servicio?.tipo_registro === 'proyecto';
      const tipoFinal = esProyecto ? 'proyecto' : e.tipo_evento;
      return {
        ...e,
        tipo_evento: tipoFinal,
        color: colorPorTipo(tipoFinal),
        es_recordatorio: false
      };
    });

    const combinado = [...eventosNormalizados, ...recordatorios]
      .sort((a, b) => new Date(a.fecha_inicio) - new Date(b.fecha_inicio));

    res.json({ data: combinado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener calendario' });
  }
};

module.exports = { listar };

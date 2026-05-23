const prisma = require('../config/prisma');
const { inicioDelDiaLima, finDelDiaLima, inicioMesLima, finMesLima } = require('../utils/tiempo');

const resumen = async (req, res) => {
  try {
    const rol = req.user.rol_codigo;
    const hoy = inicioDelDiaLima();
    const finDia = finDelDiaLima();
    const inicioMes = inicioMesLima();
    const finMes = finMesLima();

    const [
      pendientes, asignados, enCurso, finalizados,
      emergenciasActivas, tecnicosDisponibles,
      mantenimientosProximos, leadsMes,
      cobrosVencidos, cobrosMora, cobrosPendientes
    ] = await Promise.all([
      prisma.tbl_servicios_proyectos.count({ where: { estado_servicio: 'Pendiente', estado: 1 } }),
      prisma.tbl_servicios_proyectos.count({ where: { estado_servicio: { in: ['Asignado', 'Checklist de salida pendiente', 'Listo para salida'] }, estado: 1 } }),
      prisma.tbl_servicios_proyectos.count({ where: { estado_servicio: { in: ['En camino', 'En curso'] }, estado: 1 } }),
      prisma.tbl_servicios_proyectos.count({ where: { estado_servicio: { startsWith: 'Finalizado' }, estado: 1 } }),
      prisma.tbl_emergencias.count({ where: { estado_emergencia: { in: ['Reportada', 'En atención'] }, estado: 1 } }),
      prisma.tbl_tecnicos.count({ where: { estado_operativo: 'Disponible', estado: 1 } }),
      prisma.tbl_mantenimientos_planes.count({ where: { estado_plan: 'activo', estado: 1 } }),
      prisma.tbl_leads.count({ where: { date_time_registration: { gte: inicioMes, lte: finMes }, estado: 1 } }),
      prisma.tbl_cobros.count({ where: { fecha_proximo_abono: { lt: hoy }, saldo_pendiente: { gt: 0 }, estado: 1 } }),
      prisma.tbl_cobros.count({ where: { fecha_proximo_abono: { lt: hoy }, saldo_pendiente: { gt: 0 }, estado: 1 } }),
      prisma.tbl_cobros.count({ where: { saldo_pendiente: { gt: 0 }, estado: 1 } })
    ]);

    const data = {
      pendientes, asignados, enCurso, finalizados,
      emergenciasActivas, tecnicosDisponibles, mantenimientosProximos, leadsMes,
      cobrosVencidos, cobrosMora, cobrosPendientes
    };

    // Tarjetas específicas para técnico
    if (rol === 'tecnico') {
      const idTec = req.user.id_tecnico || -1;
      const [misHoy, misPendientes, misEnCurso, misFinalizadosSemana] = await Promise.all([
        prisma.tbl_servicios_asignaciones.count({
          where: {
            id_tecnico: idTec, estado: 1,
            servicio: { fecha_programada: { gte: hoy, lte: finDia }, estado: 1 }
          }
        }),
        prisma.tbl_servicios_asignaciones.count({
          where: {
            id_tecnico: idTec, estado: 1,
            servicio: { estado_servicio: { in: ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida'] }, estado: 1 }
          }
        }),
        prisma.tbl_servicios_asignaciones.count({
          where: {
            id_tecnico: idTec, estado: 1,
            servicio: { estado_servicio: { in: ['En camino', 'En curso'] }, estado: 1 }
          }
        }),
        prisma.tbl_servicios_realizados.count({
          where: {
            OR: [{ id_tecnico_principal: idTec }, { id_responsable_documentacion: idTec }],
            fecha_realizacion: { gte: new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000) },
            estado: 1
          }
        })
      ]);
      data.tecnico = { misHoy, misPendientes, misEnCurso, misFinalizadosSemana };
    }

    if (rol === 'contabilidad' || rol === 'admin' || rol === 'super_admin') {
      const [totalAbonadoMes, sinFactura, facturados] = await Promise.all([
        prisma.tbl_pagos.aggregate({
          _sum: { monto: true },
          where: { fecha_pago: { gte: inicioMes, lte: finMes }, estado: 1 }
        }),
        prisma.tbl_servicios_realizados.count({ where: { estado_facturacion: 'Sin factura', estado: 1 } }),
        prisma.tbl_servicios_realizados.count({ where: { estado_facturacion: 'Facturado', estado: 1 } })
      ]);
      data.totalAbonadoMes = Number(totalAbonadoMes._sum.monto || 0);
      data.sinFactura = sinFactura;
      data.facturados = facturados;
    }

    // Coordinador: agenda de hoy detallada
    if (rol === 'coordinador') {
      const agendaHoy = await prisma.tbl_servicios_proyectos.findMany({
        where: {
          estado: 1,
          fecha_programada: { gte: hoy, lte: finDia },
          estado_servicio: { notIn: ['Cancelado', 'Borrador', 'Cerrado'] }
        },
        orderBy: { hora_programada: 'asc' },
        include: {
          cliente: { select: { nombre: true } },
          ascensores: { where: { estado: 1 }, include: { ascensor: { select: { codigo: true } } } },
          asignaciones: { where: { estado: 1 }, include: { tecnico: { select: { nombre: true } } } }
        },
        take: 20
      });
      data.coordinador = {
        agendaHoy: agendaHoy.map(s => ({
          id: s.id, codigo: s.codigo, titulo: s.titulo,
          fecha_programada: s.fecha_programada, hora_programada: s.hora_programada,
          estado_servicio: s.estado_servicio, prioridad: s.prioridad,
          cliente: s.cliente?.nombre,
          ascensores: (s.ascensores || []).map(a => a.ascensor?.codigo).filter(Boolean),
          tecnicos: s.asignaciones.map(a => a.tecnico?.nombre).filter(Boolean)
        }))
      };
    }

    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en dashboard: ' + err.message });
  }
};

module.exports = { resumen };

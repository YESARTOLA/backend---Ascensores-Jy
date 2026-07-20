const prisma = require('../config/prisma');
const { inicioDelDiaLima, finDelDiaLima, inicioMesLima, finMesLima } = require('../utils/tiempo');
const {
  ESTADO_FACTURACION_SIN,
  ESTADOS_FACTURACION_COMPLETA
} = require('../utils/estadoFactura');
const { tiposRegistroPermitidos } = require('../utils/alcanceUsuario');
const { whereElegibleContable } = require('../utils/elegibilidadContable');
const { ESTADO_PLAN_ACTIVO } = require('../utils/estadoPlanMantenimiento');

const resumen = async (req, res) => {
  try {
    const rol = req.user.rol_codigo;
    // Ámbito del usuario (Servicios/Proyectos): null = sin restricción.
    const tiposAmbito = tiposRegistroPermitidos(req.user);
    const filtroAmbito = tiposAmbito
      ? { tipo_registro: { in: tiposAmbito.length ? tiposAmbito : ['__sin_ambito__'] } }
      : {};
    const hoy = inicioDelDiaLima();
    const finDia = finDelDiaLima();
    const inicioMes = inicioMesLima();
    const finMes = finMesLima();

    // Las métricas operativas cuentan solo SERVICIOS (tipo_registro='servicio'):
    // los Proyectos se cuentan aparte para no inflar los KPIs de servicios.
    const SOLO_SERVICIO = { tipo_registro: 'servicio' };
    const SOLO_PROYECTO = { tipo_registro: 'proyecto' };
    const ESTADOS_FINALIZADO = { estado_servicio: { startsWith: 'Finalizado' }, estado: 1 };

    const [
      pendientes, asignados, enCurso, finalizados,
      emergenciasActivas, tecnicosDisponibles,
      mantenimientosProximos, leadsMes,
      cobrosVencidos, cobrosMora, cobrosPendientes,
      proyectosActivos, proyectosFinalizados
    ] = await Promise.all([
      prisma.tbl_servicios_proyectos.count({ where: { ...SOLO_SERVICIO, estado_servicio: 'Pendiente', estado: 1 } }),
      prisma.tbl_servicios_proyectos.count({ where: { ...SOLO_SERVICIO, estado_servicio: { in: ['Asignado', 'Checklist de salida pendiente', 'Listo para salida'] }, estado: 1 } }),
      prisma.tbl_servicios_proyectos.count({ where: { ...SOLO_SERVICIO, estado_servicio: { in: ['En camino', 'En curso'] }, estado: 1 } }),
      prisma.tbl_servicios_proyectos.count({ where: { ...SOLO_SERVICIO, ...ESTADOS_FINALIZADO } }),
      prisma.tbl_emergencias.count({ where: { estado_emergencia: { in: ['Reportada', 'En atención'] }, estado: 1 } }),
      prisma.tbl_tecnicos.count({ where: { estado_operativo: 'Disponible', estado: 1 } }),
      prisma.tbl_mantenimientos_planes.count({ where: { estado_plan: ESTADO_PLAN_ACTIVO, estado: 1 } }),
      prisma.tbl_leads.count({ where: { date_time_registration: { gte: inicioMes, lte: finMes }, estado: 1 } }),
      prisma.tbl_cobros.count({ where: { fecha_proximo_abono: { lt: hoy }, saldo_pendiente: { gt: 0 }, estado: 1 } }),
      prisma.tbl_cobros.count({ where: { fecha_proximo_abono: { lt: hoy }, saldo_pendiente: { gt: 0 }, estado: 1 } }),
      prisma.tbl_cobros.count({ where: { saldo_pendiente: { gt: 0 }, estado: 1 } }),
      prisma.tbl_servicios_proyectos.count({ where: { ...SOLO_PROYECTO, estado: 1, estado_servicio: { notIn: ['Cancelado'], not: { startsWith: 'Finalizado' } } } }),
      prisma.tbl_servicios_proyectos.count({ where: { ...SOLO_PROYECTO, ...ESTADOS_FINALIZADO } })
    ]);

    const data = {
      pendientes, asignados, enCurso, finalizados,
      emergenciasActivas, tecnicosDisponibles, mantenimientosProximos, leadsMes,
      cobrosVencidos, cobrosMora, cobrosPendientes,
      proyectosActivos, proyectosFinalizados
    };

    // Ámbito: anular los KPIs fuera del ámbito del usuario (admin/coordinador
    // acotado). Los de Servicios cuando no tiene Servicios; los de Proyectos
    // cuando no tiene Proyectos. Los financieros se gobiernan por rol más abajo.
    if (tiposAmbito) {
      if (!tiposAmbito.includes('servicio')) {
        data.pendientes = 0; data.asignados = 0; data.enCurso = 0; data.finalizados = 0;
        data.emergenciasActivas = 0; data.mantenimientosProximos = 0;
      }
      if (!tiposAmbito.includes('proyecto')) {
        data.proyectosActivos = 0; data.proyectosFinalizados = 0;
      }
    }

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
        // "Sin facturar" = pendientes por facturar: excluye los marcados "Sin factura" (requiere_factura = 0).
        prisma.tbl_servicios_realizados.count({ where: { estado_facturacion: ESTADO_FACTURACION_SIN, estado: 1, ...whereElegibleContable(), AND: [{ servicio: { is: { requiere_factura: 1 } } }] } }),
        prisma.tbl_servicios_realizados.count({ where: { estado_facturacion: { in: ESTADOS_FACTURACION_COMPLETA }, estado: 1, ...whereElegibleContable() } })
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
          estado_servicio: { notIn: ['Cancelado', 'Borrador', 'Cerrado'] },
          ...filtroAmbito
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

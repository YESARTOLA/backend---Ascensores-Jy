/**
 * Auto-sincronización de recordatorios para entidades programables.
 *
 * Cada función crea o actualiza UN recordatorio "auto" por entidad. Si el
 * recordatorio ya existe se actualiza la fecha/título; si la entidad pasa
 * a un estado terminal (cerrado, cancelado, pagado), el recordatorio se
 * marca como atendido o se descarta.
 *
 * Los recordatorios manuales nunca se tocan desde aquí.
 */
const prisma = require('../config/prisma');
const { combinarFechaHoraLima, inicioDelDiaLima } = require('./tiempo');
const { obtenerFrecuencia } = require('./frecuenciaMantenimiento');

// Estados de servicio donde aplica la alerta "el técnico finalizó". Inline
// (no importamos `estadoServicio.estaServicioFinalizado`) porque
// `estadoServicio.js` ya importa este módulo y crearía dependencia circular.
// Excluye 'Cancelado' porque ahí la alerta debe descartarse, no crearse.
const ESTADOS_SERVICIO_POST_FINALIZACION = [
  'Finalizado por técnico',
  'Finalizado observado',
  'En revisión administrativa',
  'A gestión de cobro',
  'En cobro',
  'Cobrado parcial',
  'Cobrado total',
  'Facturado',
  'Cerrado'
];

const COLORES = {
  servicio: '#0ea5e9',
  mantenimiento: '#22c55e',
  emergencia: '#ef4444',
  cobro: '#f59e0b',
  manual: '#8b5cf6',
  observacion: '#f97316',
  observacion_alerta: '#dc2626',
  cotizacion_urgente: '#dc2626',
  servicio_finalizado_revisar:  '#f59e0b', // coordinador → revisar trabajo/informe
  servicio_finalizado_facturar: '#8b5cf6', // contabilidad → emitir factura
  servicio_finalizado_aviso:    '#0ea5e9'  // admin → solo aviso informativo
};

const ESTADOS_TERMINALES_SERVICIO = ['Cerrado', 'Cancelado', 'Cobrado total', 'Facturado'];
const ESTADOS_TERMINALES_EMERGENCIA = ['Atendida', 'Cerrada'];
const ESTADOS_TERMINALES_COBRO = ['Pagado', 'Cerrado', 'Incobrable'];
const ESTADOS_TERMINALES_PLAN = ['inactivo', 'cancelado'];

async function upsertAuto({ filtro, datos }) {
  const existente = await prisma.tbl_recordatorios.findFirst({ where: { ...filtro, origen: 'auto' } });
  if (existente) {
    return prisma.tbl_recordatorios.update({
      where: { id: existente.id },
      data: { ...datos, date_time_modification: new Date() }
    });
  }
  return prisma.tbl_recordatorios.create({
    data: { ...filtro, ...datos, origen: 'auto' }
  });
}

async function descartarAuto(filtro) {
  const existente = await prisma.tbl_recordatorios.findFirst({ where: { ...filtro, origen: 'auto' } });
  if (!existente) return null;
  if (existente.estado_recordatorio === 'atendido') return existente;
  return prisma.tbl_recordatorios.update({
    where: { id: existente.id },
    data: {
      estado_recordatorio: 'atendido',
      fecha_atendido: new Date(),
      date_time_modification: new Date()
    }
  });
}

async function sincronizarRecordatorioServicio(servicioId) {
  if (!servicioId) return;
  const s = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: servicioId },
    include: {
      cliente: true,
      ascensores: { where: { estado: 1 }, include: { ascensor: { select: { codigo: true } } } },
      tipo_servicio: true
    }
  });
  if (!s || s.estado !== 1) {
    return descartarAuto({ tipo: 'servicio', id_servicio: servicioId });
  }
  if (ESTADOS_TERMINALES_SERVICIO.includes(s.estado_servicio)) {
    return descartarAuto({ tipo: 'servicio', id_servicio: servicioId });
  }
  const fechaRecordatorio = combinarFechaHoraLima(s.fecha_programada, s.hora_programada);
  const titulo = `${s.codigo} · ${s.tipo_servicio?.nombre || 'Servicio'}`;
  const codigosAscensores = (s.ascensores || []).map(a => a.ascensor?.codigo).filter(Boolean).join(', ');
  const descripcion = `${s.cliente?.nombre || ''}${codigosAscensores ? ` · ${codigosAscensores}` : ''}`;
  return upsertAuto({
    filtro: { tipo: 'servicio', id_servicio: servicioId },
    datos: {
      titulo,
      descripcion,
      fecha_recordatorio: fechaRecordatorio,
      prioridad: s.prioridad === 'alta' ? 'alta' : 'media',
      color: COLORES.servicio
    }
  });
}

async function sincronizarRecordatorioMantenimientoPlan(planId) {
  if (!planId) return;
  const p = await prisma.tbl_mantenimientos_planes.findUnique({
    where: { id: planId },
    include: { cliente: true, ascensor: true, tipo_servicio: true }
  });
  if (!p || p.estado !== 1 || ESTADOS_TERMINALES_PLAN.includes(p.estado_plan)) {
    return descartarAuto({ tipo: 'mantenimiento', id_mantenimiento_plan: planId });
  }
  const fechaRecordatorio = combinarFechaHoraLima(p.fecha_inicio, p.hora_programada);
  const fr = obtenerFrecuencia(p.frecuencia);
  const detalleFrecuencia = p.tipo_plan === 'eventual'
    ? 'eventual'
    : (fr ? fr.etiqueta.toLowerCase() : (p.frecuencia || ''));
  const titulo = `Mantenimiento ${detalleFrecuencia}${p.tipo_servicio?.nombre ? ' · ' + p.tipo_servicio.nombre : ''}`.trim();
  const descripcion = `${p.cliente?.nombre || ''}${p.ascensor?.codigo ? ` · ${p.ascensor.codigo}` : ''}`;
  return upsertAuto({
    filtro: { tipo: 'mantenimiento', id_mantenimiento_plan: planId },
    datos: {
      titulo,
      descripcion,
      fecha_recordatorio: fechaRecordatorio,
      prioridad: 'media',
      color: COLORES.mantenimiento
    }
  });
}

async function sincronizarRecordatorioEmergencia(emergenciaId) {
  if (!emergenciaId) return;
  const e = await prisma.tbl_emergencias.findUnique({
    where: { id: emergenciaId },
    include: { cliente: true, ascensor: true }
  });
  if (!e || e.estado !== 1) {
    return descartarAuto({ tipo: 'emergencia', id_emergencia: emergenciaId });
  }
  if (ESTADOS_TERMINALES_EMERGENCIA.includes(e.estado_emergencia)) {
    return descartarAuto({ tipo: 'emergencia', id_emergencia: emergenciaId });
  }
  const titulo = `Emergencia · ${e.motivo?.substring(0, 80) || 'Sin motivo'}`;
  const descripcion = `${e.cliente?.nombre || ''}${e.ascensor?.codigo ? ` · ${e.ascensor.codigo}` : ''}`;
  return upsertAuto({
    filtro: { tipo: 'emergencia', id_emergencia: emergenciaId },
    datos: {
      titulo,
      descripcion,
      fecha_recordatorio: e.fecha_reporte || new Date(),
      prioridad: e.nivel_urgencia === 'alta' ? 'alta' : (e.nivel_urgencia === 'baja' ? 'baja' : 'media'),
      color: COLORES.emergencia
    }
  });
}

async function descartarRecordatoriosCobroLevel(cobroId) {
  // Descarta el recordatorio "cobro-level" (sin cuota) si existe.
  await prisma.tbl_recordatorios.updateMany({
    where: { tipo: 'cobro', id_cobro: cobroId, id_cuota: null, origen: 'auto', estado: 1, estado_recordatorio: { not: 'atendido' } },
    data: { estado_recordatorio: 'atendido', fecha_atendido: new Date(), date_time_modification: new Date() }
  });
}

async function descartarRecordatoriosCuotas(cobroId) {
  // Descarta TODOS los recordatorios auto de cuotas del cobro.
  await prisma.tbl_recordatorios.updateMany({
    where: { tipo: 'cobro', id_cobro: cobroId, id_cuota: { not: null }, origen: 'auto', estado: 1, estado_recordatorio: { not: 'atendido' } },
    data: { estado_recordatorio: 'atendido', fecha_atendido: new Date(), date_time_modification: new Date() }
  });
}

async function sincronizarRecordatorioCobro(cobroId) {
  if (!cobroId) return;
  const c = await prisma.tbl_cobros.findUnique({
    where: { id: cobroId },
    include: { cliente: true, servicio: true, cuotas: { where: { estado: 1 }, orderBy: { numero_cuota: 'asc' } } }
  });
  if (!c || c.estado !== 1) {
    await descartarRecordatoriosCobroLevel(cobroId);
    await descartarRecordatoriosCuotas(cobroId);
    return;
  }
  if (ESTADOS_TERMINALES_COBRO.includes(c.estado_cobro) || Number(c.saldo_pendiente) <= 0) {
    await descartarRecordatoriosCobroLevel(cobroId);
    await descartarRecordatoriosCuotas(cobroId);
    return;
  }

  const hoy = inicioDelDiaLima();
  const cuotas = c.cuotas || [];

  // Si hay plan de cuotas: un recordatorio por cada cuota no pagada en fecha_vencimiento.
  if (cuotas.length > 0) {
    // Descartar el recordatorio cobro-level (sin cuota) si quedó del antiguo modelo.
    await descartarRecordatoriosCobroLevel(cobroId);

    for (const cu of cuotas) {
      const pagada = cu.estado_cuota === 'Pagada' || Number(cu.monto_pagado) >= Number(cu.monto);
      if (pagada) {
        // Descartar recordatorio de esta cuota si existe.
        await prisma.tbl_recordatorios.updateMany({
          where: { tipo: 'cobro', id_cobro: cobroId, id_cuota: cu.id, origen: 'auto', estado: 1, estado_recordatorio: { not: 'atendido' } },
          data: { estado_recordatorio: 'atendido', fecha_atendido: new Date(), date_time_modification: new Date() }
        });
        continue;
      }
      const fechaRecordatorio = combinarFechaHoraLima(cu.fecha_vencimiento, '09:00');
      const vencida = new Date(cu.fecha_vencimiento) < hoy;
      const titulo = `Cobro · cuota ${cu.numero_cuota}/${cuotas.length} · ${c.cliente?.nombre || 'Cliente'}`;
      const descripcion = `Servicio ${c.servicio?.codigo || ''} · Cuota ${cu.numero_cuota}: ${Number(cu.monto).toFixed(2)} ${c.moneda || 'PEN'}`;
      await upsertAuto({
        filtro: { tipo: 'cobro', id_cobro: cobroId, id_cuota: cu.id },
        datos: {
          titulo,
          descripcion,
          fecha_recordatorio: fechaRecordatorio,
          prioridad: vencida ? 'alta' : 'media',
          color: COLORES.cobro
        }
      });
    }
    return;
  }

  // Sin plan de cuotas: un único recordatorio en fecha_proximo_abono.
  await descartarRecordatoriosCuotas(cobroId);
  if (!c.fecha_proximo_abono) {
    await descartarRecordatoriosCobroLevel(cobroId);
    return;
  }
  const fechaRecordatorio = combinarFechaHoraLima(c.fecha_proximo_abono, '09:00');
  const titulo = `Cobro · ${c.cliente?.nombre || 'Cliente'}`;
  const descripcion = `Servicio ${c.servicio?.codigo || ''} · Saldo ${Number(c.saldo_pendiente).toFixed(2)} ${c.moneda || 'PEN'}`;
  const vencido = new Date(c.fecha_proximo_abono) < hoy;
  return upsertAuto({
    filtro: { tipo: 'cobro', id_cobro: cobroId, id_cuota: null },
    datos: {
      titulo,
      descripcion,
      fecha_recordatorio: fechaRecordatorio,
      prioridad: vencido ? 'alta' : 'media',
      color: COLORES.cobro
    }
  });
}

/**
 * Sincroniza el recordatorio agregado por observaciones técnicas pendientes
 * del servicio. Un único recordatorio "auto" por servicio (tipo 'observacion')
 * que se crea cuando hay alguna observación sin atender y se descarta cuando
 * todas están atendidas.
 */
async function sincronizarRecordatorioObservaciones(servicioId) {
  if (!servicioId) return;
  const s = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: servicioId },
    include: { cliente: true }
  });
  if (!s || s.estado !== 1) {
    return descartarAuto({ tipo: 'observacion', id_servicio: servicioId });
  }
  const pendientesList = await prisma.tbl_servicios_observaciones.findMany({
    where: { id_servicio: servicioId, estado: 1, atendida: 0 },
    orderBy: { id: 'desc' },
    select: { id: true, date_time_registration: true }
  });
  if (pendientesList.length === 0) {
    return descartarAuto({ tipo: 'observacion', id_servicio: servicioId });
  }
  // Anclar el recordatorio al instante exacto en que se registró la observación
  // pendiente más reciente, para que en el calendario aparezca el día y la hora
  // reales del reporte y no las 00:00 del día actual.
  const fechaRecordatorio = pendientesList[0].date_time_registration || inicioDelDiaLima();
  const titulo = `Observaciones técnicas — ${s.codigo}`;
  const descripcion = `${pendientesList.length} observación(es) reportada(s) por el técnico${s.cliente?.nombre ? ` · ${s.cliente.nombre}` : ''}`;
  return upsertAuto({
    filtro: { tipo: 'observacion', id_servicio: servicioId },
    datos: {
      titulo,
      descripcion,
      fecha_recordatorio: fechaRecordatorio,
      prioridad: 'alta',
      color: COLORES.observacion,
      estado_recordatorio: 'pendiente'
    }
  });
}

/**
 * Crea una alerta puntual tipo 'observacion_alerta' para una observación técnica
 * con el flag genera_alerta=1. A diferencia de `sincronizarRecordatorioObservaciones`
 * (un único agregado por servicio), esta crea UN recordatorio por observación
 * marcada, visible solo para super_admin, admin y contabilidad según
 * `utils/visibilidadCalendario.js`. El link a la observación se guarda en
 * `notas_seguimiento` (`obs:<id>`) para poder atender o descartar la alerta
 * cuando la observación pase a "atendida".
 */
async function crearAlertaObservacion(idObservacion) {
  if (!idObservacion) return;
  const obs = await prisma.tbl_servicios_observaciones.findUnique({
    where: { id: idObservacion },
    include: {
      servicio: { include: { cliente: true } }
    }
  });
  if (!obs || obs.estado !== 1) return;
  const s = obs.servicio;
  const titulo = `🔔 Alerta técnica — ${s?.codigo || 'Servicio'}`;
  const detalleCliente = s?.cliente?.nombre || '';
  const recorte = (obs.texto || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const descripcion = `${detalleCliente ? detalleCliente + ' · ' : ''}${recorte}${(obs.texto || '').length > 140 ? '…' : ''}`;
  return prisma.tbl_recordatorios.create({
    data: {
      tipo: 'observacion_alerta',
      origen: 'auto',
      titulo,
      descripcion,
      fecha_recordatorio: obs.date_time_registration || new Date(),
      prioridad: 'alta',
      color: COLORES.observacion_alerta,
      estado_recordatorio: 'pendiente',
      id_servicio: s?.id || null,
      notas_seguimiento: `obs:${obs.id}`
    }
  });
}

/**
 * Descarta (estado_recordatorio='atendido') la alerta puntual vinculada a la
 * observación dada. Se llama cuando la observación pasa a `atendida=1`.
 */
async function descartarAlertaObservacion(idObservacion) {
  if (!idObservacion) return;
  await prisma.tbl_recordatorios.updateMany({
    where: {
      tipo: 'observacion_alerta',
      notas_seguimiento: `obs:${idObservacion}`,
      estado: 1,
      estado_recordatorio: { not: 'atendido' }
    },
    data: {
      estado_recordatorio: 'atendido',
      fecha_atendido: new Date(),
      date_time_modification: new Date()
    }
  });
}

/**
 * Crea (idempotente) una alerta tipo 'cotizacion_urgente' tras la finalización
 * de un servicio con su informe generado. La ven los roles habilitados en
 * `utils/visibilidadCalendario.js` (super_admin, admin, coordinador) — no la
 * ven técnico ni contabilidad. Se queda pendiente hasta que un coordinador la
 * marque como atendida manualmente desde el módulo Recordatorios.
 */
async function sincronizarRecordatorioCotizacionUrgente(idServicio) {
  if (!idServicio) return;
  const s = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    include: { cliente: true, tipo_servicio: true }
  });
  if (!s || s.estado !== 1) {
    return descartarAuto({ tipo: 'cotizacion_urgente', id_servicio: idServicio });
  }
  const titulo = `Cotización urgente — ${s.codigo}`;
  const detalleCliente = s.cliente
    ? `${s.cliente.nombre}${s.cliente.nombre_edificio ? ` · ${s.cliente.nombre_edificio}` : ''}`
    : '';
  const descripcion = `Servicio finalizado con informe. Revisar y emitir cotización si corresponde.${detalleCliente ? ` · ${detalleCliente}` : ''}`;
  return upsertAuto({
    filtro: { tipo: 'cotizacion_urgente', id_servicio: idServicio },
    datos: {
      titulo,
      descripcion,
      fecha_recordatorio: new Date(),
      prioridad: 'alta',
      color: COLORES.cotizacion_urgente,
      estado_recordatorio: 'pendiente'
    }
  });
}

/**
 * Helper común para las 3 alertas de "servicio finalizado por técnico".
 *
 * Cada llamada crea o refresca UN recordatorio por servicio por tipo
 * (`upsertAuto` con clave compuesta `tipo + id_servicio`). Si el servicio se
 * elimina o se reabre/cancela, la alerta se descarta. Idempotente — soporta
 * re-aprobación sin duplicar.
 *
 * `tipo` es uno de:
 *   - 'servicio_finalizado_revisar'  → coordinador revisa trabajo/informe
 *   - 'servicio_finalizado_facturar' → contabilidad emite factura
 *   - 'servicio_finalizado_aviso'    → admin recibe aviso informativo
 *
 * Visibilidad por rol controlada en `utils/visibilidadCalendario.js`.
 */
async function sincronizarAlertaServicioFinalizado(tipo, idServicio) {
  if (!idServicio) return;
  const s = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    include: { cliente: true, tipo_servicio: true }
  });
  if (!s || s.estado !== 1) {
    return descartarAuto({ tipo, id_servicio: idServicio });
  }
  // La alerta solo aplica cuando el servicio está post-ejecución (técnico ya
  // finalizó). Si fue reabierto a un estado anterior (Pendiente, En curso,
  // etc.) o terminó cancelado, la descartamos. Se reactivará cuando el
  // técnico vuelva a finalizar y se regenere el checklist de finalización.
  if (!ESTADOS_SERVICIO_POST_FINALIZACION.includes(s.estado_servicio)) {
    return descartarAuto({ tipo, id_servicio: idServicio });
  }
  const detalleCliente = s.cliente
    ? `${s.cliente.nombre}${s.cliente.nombre_edificio ? ` · ${s.cliente.nombre_edificio}` : ''}`
    : '';
  const textos = TEXTO_ALERTA_FINALIZADO[tipo];
  if (!textos) throw new Error(`Tipo de alerta de finalización no soportado: ${tipo}`);
  const titulo = `${textos.titulo} — ${s.codigo}`;
  const descripcion = `${textos.descripcion}${detalleCliente ? ` · ${detalleCliente}` : ''}`;
  return upsertAuto({
    filtro: { tipo, id_servicio: idServicio },
    datos: {
      titulo,
      descripcion,
      fecha_recordatorio: new Date(),
      prioridad: textos.prioridad,
      color: COLORES[tipo],
      estado_recordatorio: 'pendiente'
    }
  });
}

const TEXTO_ALERTA_FINALIZADO = {
  servicio_finalizado_revisar: {
    titulo: 'Revisar servicio',
    descripcion: 'El técnico finalizó este servicio. Revisar trabajo e informe; corregir si hace falta.',
    prioridad: 'alta'
  },
  servicio_finalizado_facturar: {
    titulo: 'Facturar servicio',
    descripcion: 'El técnico finalizó este servicio. Emitir factura.',
    prioridad: 'alta'
  },
  servicio_finalizado_aviso: {
    titulo: 'Servicio finalizado',
    descripcion: 'El técnico finalizó este servicio.',
    prioridad: 'media'
  }
};

function sincronizarRecordatorioRevisarServicio(idServicio) {
  return sincronizarAlertaServicioFinalizado('servicio_finalizado_revisar', idServicio);
}

function sincronizarRecordatorioFacturarServicio(idServicio) {
  return sincronizarAlertaServicioFinalizado('servicio_finalizado_facturar', idServicio);
}

function sincronizarRecordatorioAvisoFinalizacion(idServicio) {
  return sincronizarAlertaServicioFinalizado('servicio_finalizado_aviso', idServicio);
}

/**
 * Descarta la alerta de "facturar servicio" cuando se emite la factura del
 * servicio. La invoca `facturasController.crear` tras crear una factura no
 * anulada. Las alertas "revisar" y "aviso" siguen siendo cierre manual.
 */
async function descartarAlertaFacturarServicio(idServicio) {
  if (!idServicio) return;
  return descartarAuto({ tipo: 'servicio_finalizado_facturar', id_servicio: idServicio });
}

module.exports = {
  sincronizarRecordatorioServicio,
  sincronizarRecordatorioMantenimientoPlan,
  sincronizarRecordatorioEmergencia,
  sincronizarRecordatorioCobro,
  sincronizarRecordatorioObservaciones,
  sincronizarRecordatorioCotizacionUrgente,
  sincronizarRecordatorioRevisarServicio,
  sincronizarRecordatorioFacturarServicio,
  sincronizarRecordatorioAvisoFinalizacion,
  descartarAlertaFacturarServicio,
  crearAlertaObservacion,
  descartarAlertaObservacion,
  COLORES
};

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
const {
  DESTINATARIOS_POR_DEFECTO, normalizarDestinatarios, destinatario
} = require('./destinatariosAlerta');
const { obtenerFrecuencia } = require('./frecuenciaMantenimiento');

// Estados de servicio donde aplica la alerta "el técnico finalizó". Inline
// (no importamos `estadoServicio.estaServicioFinalizado`) porque
// `estadoServicio.js` ya importa este módulo y crearía dependencia circular.
// Excluye 'Cancelado' porque ahí la alerta debe descartarse, no crearse.
const ESTADOS_SERVICIO_POST_FINALIZACION = [
  'Finalizado',
  'En revisión administrativa',
  'A gestión de cobro',
  'En cobro',
  'Cobrado parcial',
  'Cobrado total',
  'Facturado',
  'Cerrado'
];

// Espejo de frontend/src/utils/visibilidadCalendario.js (CATALOGO_TIPOS_EVENTO).
// Mantener ambos en sincronía: el calendario pinta por tipo desde el catálogo del
// frontend, este mapa fija el color persistido en los recordatorios/eventos nuevos.
const COLORES = {
  servicio: '#0ea5e9',                       // celeste
  mantenimiento: '#16a34a',                  // verde
  emergencia: '#dc2626',                     // rojo
  cobro: '#9333ea',                          // púrpura
  manual: '#475569',                         // gris pizarra
  observacion: '#0d9488',                    // turquesa
  observacion_alerta: '#e11d48',             // rosa-rojo (detalle → admin/vendedora/coordinador)
  observacion_facturar: '#0891b2',           // cian (aviso sin detalle → contabilidad)
  cotizacion_urgente: '#c026d3',             // fucsia
  servicio_finalizado_revisar:  '#65a30d',   // coordinador → revisar trabajo/informe (lima)
  servicio_finalizado_facturar: '#4f46e5',   // contabilidad → emitir factura (índigo)
  servicio_finalizado_aviso:    '#475569',   // admin → solo aviso informativo (gris)
  correctivo_gratuito:          '#b45309'    // administración → correctivo marcado sin costo (ámbar oscuro)
};

const ESTADOS_TERMINALES_SERVICIO = ['Cerrado', 'Cancelado', 'Cobrado total', 'Facturado'];
const ESTADOS_TERMINALES_EMERGENCIA = ['Atendida', 'Cerrada'];
const ESTADOS_TERMINALES_COBRO = ['Pagado', 'Cerrado', 'Incobrable'];
const { ESTADOS_PLAN_TERMINALES } = require('./estadoPlanMantenimiento');

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
  // Un servicio aprobado por cotización nace sin fecha de programación: el área
  // la registra después. Sin fecha no hay recordatorio que generar todavía; se
  // creará/sincronizará cuando se programe (actualizar dispara este sync).
  if (!s.fecha_programada) {
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
    include: {
      cliente: true,
      tipo_servicio: true,
      ascensores: { where: { estado: 1 }, include: { ascensor: { select: { codigo: true } } } }
    }
  });
  if (!p || p.estado !== 1 || ESTADOS_PLAN_TERMINALES.includes(p.estado_plan)) {
    return descartarAuto({ tipo: 'mantenimiento', id_mantenimiento_plan: planId });
  }
  const fechaRecordatorio = combinarFechaHoraLima(p.fecha_inicio, p.hora_programada);
  // Un plan puede tener frecuencias distintas por ascensor: el título las
  // lista todas ("mensual, trimestral") en vez de una sola.
  const codigosFrec = [...new Set(
    (p.ascensores || []).map(a => a.frecuencia).filter(Boolean)
  )];
  const listaFrec = (codigosFrec.length > 0 ? codigosFrec : [p.frecuencia])
    .filter(Boolean)
    .map(c => (obtenerFrecuencia(c)?.etiqueta || c).toLowerCase());
  const detalleFrecuencia = p.tipo_plan === 'eventual'
    ? 'eventual'
    : listaFrec.join(', ');
  const titulo = `Mantenimiento ${detalleFrecuencia}${p.tipo_servicio?.nombre ? ' · ' + p.tipo_servicio.nombre : ''}`.trim();
  const codigosAsc = (p.ascensores || []).map(a => a.ascensor?.codigo).filter(Boolean).join(', ');
  const descripcion = `${p.cliente?.nombre || ''}${codigosAsc ? ` · ${codigosAsc}` : ''}`;
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
 * Crea las alertas puntuales para una observación técnica con el flag
 * genera_alerta=1. Se generan DOS alertas diferenciadas (una por observación),
 * ambas vinculadas a la observación por `notas_seguimiento` (`obs:<id>`) para
 * poder descartarlas juntas cuando se atienda/elimine:
 *
 *  1. 'observacion_alerta' — CON detalle (texto de la observación). La ven
 *     administración (super_admin, admin), cotización (vendedora) y oficina
 *     técnica (coordinador), para hacer seguimiento y armar la cotización.
 *     La imagen está disponible al abrir la observación en el servicio.
 *  2. 'observacion_facturar' — SOLO aviso, SIN el texto ni la imagen. La ve
 *     únicamente contabilidad, para que sepa que hay un servicio con observación
 *     y prepare la facturación.
 *
 * Visibilidad por rol gobernada en `utils/visibilidadCalendario.js`.
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
  const detalleCliente = s?.cliente?.nombre || '';
  const fecha = obs.date_time_registration || new Date();

  // Destinatarios elegidos por el técnico. Sin lista (observación creada por un
  // cliente que aún no la manda) se cae al reparto histórico: a todos.
  const elegidos = normalizarDestinatarios(
    String(obs.destinatarios_alerta || '').split(',').map(x => x.trim()).filter(Boolean)
  );
  const destinos = elegidos.length ? elegidos : DESTINATARIOS_POR_DEFECTO;

  const recorte = (obs.texto || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const descripcionDetalle = `${detalleCliente ? detalleCliente + ' · ' : ''}${recorte}${(obs.texto || '').length > 140 ? '…' : ''}`;
  const descripcionAviso = `${detalleCliente ? detalleCliente + ' · ' : ''}Se registró una observación técnica en el servicio. Preparar la facturación cuando corresponda.`;

  // Un recordatorio POR ROL destinatario: el tipo por sí solo no distingue
  // (a 'observacion_alerta' lo ven varios roles), así que el filtro fino lo
  // hace `rol_destinatario` al listar.
  const filas = [];
  for (const codigo of destinos) {
    const def = destinatario(codigo);
    if (!def) continue;
    for (const rol of def.roles) {
      filas.push({
        tipo: def.detalle ? 'observacion_alerta' : 'observacion_facturar',
        origen: 'auto',
        titulo: def.detalle
          ? `🔔 Alerta técnica — ${s?.codigo || 'Servicio'}`
          : `🔔 Servicio con observación — ${s?.codigo || 'Servicio'}`,
        descripcion: def.detalle ? descripcionDetalle : descripcionAviso,
        fecha_recordatorio: fecha,
        prioridad: 'alta',
        color: def.detalle ? COLORES.observacion_alerta : COLORES.observacion_facturar,
        estado_recordatorio: 'pendiente',
        id_servicio: s?.id || null,
        rol_destinatario: rol,
        notas_seguimiento: `obs:${obs.id}`
      });
    }
  }
  if (filas.length) await prisma.tbl_recordatorios.createMany({ data: filas });
}

// Administración: quien debe enterarse de que un correctivo se marcó sin costo.
const ROLES_ALERTA_GRATUITO = ['super_admin', 'admin'];

/**
 * Alerta de CORRECTIVO GRATUITO.
 *
 * Marcar un correctivo "sin costo" es una decisión con impacto económico, y la
 * toma un rol que no maneja precios (el Coordinador). Se avisa a administración
 * para que pueda revisarla: un recordatorio por rol destinatario, igual que las
 * alertas de observación.
 *
 * Idempotente: `notas_seguimiento` marca el correctivo, así que reeditarlo no
 * genera una alerta nueva mientras la anterior siga pendiente.
 */
async function crearAlertaCorrectivoGratuito(idCorrectivo, { usuarioId = null } = {}) {
  if (!idCorrectivo) return;
  const marca = `correctivo_gratuito:${idCorrectivo}`;
  const yaExiste = await prisma.tbl_recordatorios.findFirst({
    where: { notas_seguimiento: marca, estado: 1, estado_recordatorio: { not: 'atendido' } },
    select: { id: true }
  });
  if (yaExiste) return;

  const cor = await prisma.tbl_correctivos.findUnique({
    where: { id: idCorrectivo },
    include: {
      cliente: { select: { nombre: true } },
      ascensor: { select: { codigo: true } },
      servicio: { select: { id: true, codigo: true } }
    }
  });
  if (!cor || cor.estado !== 1) return;

  const autor = usuarioId
    ? await prisma.tbl_usuarios.findUnique({ where: { id: usuarioId }, select: { nombres: true } })
    : null;
  const partes = [
    cor.cliente?.nombre,
    cor.ascensor?.codigo ? `Ascensor ${cor.ascensor.codigo}` : null,
    autor?.nombres ? `Marcado gratuito por ${autor.nombres.trim()}` : null
  ].filter(Boolean);

  const filas = ROLES_ALERTA_GRATUITO.map(rol => ({
    tipo: 'correctivo_gratuito',
    origen: 'auto',
    titulo: `💸 Correctivo sin costo — ${cor.servicio?.codigo || `Correctivo #${cor.id}`}`,
    descripcion: `${partes.join(' · ')}${partes.length ? ' · ' : ''}${(cor.falla || '').replace(/\s+/g, ' ').trim().slice(0, 120)}`,
    fecha_recordatorio: new Date(),
    prioridad: 'alta',
    color: COLORES.correctivo_gratuito,
    estado_recordatorio: 'pendiente',
    id_servicio: cor.servicio?.id || null,
    rol_destinatario: rol,
    notas_seguimiento: marca
  }));
  await prisma.tbl_recordatorios.createMany({ data: filas });
}

/**
 * Descarta la alerta de correctivo gratuito: se llama cuando el correctivo deja
 * de estar marcado sin costo (administración le puso precio).
 */
async function descartarAlertaCorrectivoGratuito(idCorrectivo) {
  if (!idCorrectivo) return;
  await prisma.tbl_recordatorios.updateMany({
    where: {
      tipo: 'correctivo_gratuito',
      notas_seguimiento: `correctivo_gratuito:${idCorrectivo}`,
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
 * Descarta (estado_recordatorio='atendido') la alerta puntual vinculada a la
 * observación dada. Se llama cuando la observación pasa a `atendida=1`.
 */
async function descartarAlertaObservacion(idObservacion) {
  if (!idObservacion) return;
  await prisma.tbl_recordatorios.updateMany({
    where: {
      tipo: { in: ['observacion_alerta', 'observacion_facturar'] },
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
 * Domingo no se trabaja: ninguna alerta debe quedar agendada ese día. Si la
 * fecha cae domingo, se corre al lunes siguiente (día hábil más cercano hacia
 * adelante). Respeta el tipo de dato de origen: las columnas `@db.Date` llegan
 * como medianoche UTC, así que se opera en UTC para no desplazar el día.
 */
function correrSiEsDomingo(fecha) {
  const d = new Date(fecha);
  if (isNaN(d.getTime())) return fecha;
  // Una `@db.Date` llega como medianoche UTC: su día de semana se lee en UTC.
  // Un instante real (el fallback `new Date()`) se lee en hora de Lima, que es
  // el día que muestra el calendario.
  const esFechaPura = d.getUTCHours() === 0 && d.getUTCMinutes() === 0
    && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  const diaSemana = esFechaPura
    ? d.getUTCDay()
    : new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(d) + 'T00:00:00.000Z').getUTCDay();
  if (diaSemana !== 0) return d;
  if (esFechaPura) d.setUTCDate(d.getUTCDate() + 1);
  else d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Crea (idempotente) una alerta tipo 'cotizacion_urgente' SOLO cuando el
 * servicio tiene al menos una observación técnica registrada (activa) — es lo
 * que se cotizaría. Se dispara únicamente al registrar/eliminar observaciones
 * (no al generar el informe). Se agenda en la fecha_programada del servicio.
 * Si el servicio se elimina/desactiva o se queda sin observaciones, la alerta
 * se descarta. La ven los roles habilitados en
 * `utils/visibilidadCalendario.js` (super_admin, admin, coordinador) — no la
 * ven técnico ni contabilidad. Se queda pendiente hasta que un coordinador la
 * marque como atendida manualmente desde el módulo Recordatorios.
 */
async function sincronizarRecordatorioCotizacionUrgente(idServicio) {
  if (!idServicio) return;
  const s = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    include: { cliente: true, tipo_servicio: true, ascensores: { where: { estado: 1 }, include: { ascensor: { select: { edificio: { select: { nombre: true } } } } } } }
  });
  if (!s || s.estado !== 1) {
    return descartarAuto({ tipo: 'cotizacion_urgente', id_servicio: idServicio });
  }
  // La alerta solo aplica si el servicio tiene al menos una observación técnica
  // registrada (es lo que se cotizaría). Sin observaciones, se descarta.
  const observaciones = await prisma.tbl_servicios_observaciones.count({
    where: { id_servicio: idServicio, estado: 1 }
  });
  if (observaciones === 0) {
    return descartarAuto({ tipo: 'cotizacion_urgente', id_servicio: idServicio });
  }
  const titulo = `Cotización urgente — ${s.codigo}`;
  const edificioNombre = (s.ascensores || []).map(a => a.ascensor?.edificio?.nombre).find(Boolean);
  const detalleCliente = s.cliente
    ? `${s.cliente.nombre}${edificioNombre ? ` · ${edificioNombre}` : ''}`
    : '';
  const descripcion = `Servicio con observación técnica registrada. Revisar y emitir cotización.${detalleCliente ? ` · ${detalleCliente}` : ''}`;
  // Se registra en la fecha en que el técnico tiene agendado el servicio
  // (fecha_programada), NO en la fecha real de cierre: si el técnico cierra
  // tarde, la alerta igual aparece el día en que estaba programado el trabajo.
  // Como no se agenda trabajo los domingos, así nunca cae en domingo; el
  // `correrSiEsDomingo` cubre el fallback (servicio sin fecha programada) y
  // cualquier dato heredado que sí cayera domingo.
  const fechaRecordatorio = correrSiEsDomingo(s.fecha_programada || new Date());
  return upsertAuto({
    filtro: { tipo: 'cotizacion_urgente', id_servicio: idServicio },
    datos: {
      titulo,
      descripcion,
      fecha_recordatorio: fechaRecordatorio,
      prioridad: 'alta',
      color: COLORES.cotizacion_urgente,
      estado_recordatorio: 'pendiente'
    }
  });
}

/**
 * Helper común para las 3 alertas de "servicio finalizado".
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
    include: { cliente: true, tipo_servicio: true, ascensores: { where: { estado: 1 }, include: { ascensor: { select: { edificio: { select: { nombre: true } } } } } } }
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
  const edificioNombre = (s.ascensores || []).map(a => a.ascensor?.edificio?.nombre).find(Boolean);
  const detalleCliente = s.cliente
    ? `${s.cliente.nombre}${edificioNombre ? ` · ${edificioNombre}` : ''}`
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
  crearAlertaCorrectivoGratuito,
  descartarAlertaCorrectivoGratuito,
  COLORES
};

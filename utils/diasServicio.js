/**
 * Días de un servicio/proyecto multidía.
 *
 * Un trabajo puede durar varios días consecutivos. `tbl_servicios_dias` es la
 * fuente de verdad de esa grilla: una fila por día (orden 1..N) a partir de
 * `fecha_programada`. Cada día tiene EXACTAMENTE un evento en
 * `tbl_calendario_eventos` (la agenda muestra "Día k/N"); las evidencias se
 * ligan a su día vía `id_dia`.
 *
 * `sincronizarDiasYEventos` es el ÚNICO lugar que escribe los días de un
 * servicio y sus eventos de calendario: regenera ambos a la vez desde
 * (fecha_programada, hora_programada, duracion_dias) para que nunca se
 * desincronicen. Al regenerar conserva los días ya existentes (con su
 * evidencia) emparejando por `orden`.
 *
 * La completitud de un día NO se almacena: se deriva de tener ≥1 evidencia
 * activa (ver `diasSinEvidencia`).
 */

const prismaDefault = require('../config/prisma');
const { ESTADO_EVENTO_PROGRAMADO, ESTADO_EVENTO_CANCELADO } = require('./estadoEvento');
const { combinarFechaHoraLima } = require('./tiempo');
const { colorPorTipo } = require('./visibilidadCalendario');

const MS_POR_DIA = 86400000;

const tipoEventoDesdeRegistro = (tipoRegistro) =>
  tipoRegistro === 'proyecto' ? 'proyecto' : 'servicio';

/** Error de negocio: recortar la duración dejaría fuera días que ya tienen evidencia. */
class ConfirmacionRequeridaError extends Error {
  constructor(diasConEvidencia) {
    super('Recortar la duración eliminaría días que ya tienen evidencia');
    this.code = 'REQUIERE_CONFIRMACION';
    this.diasConEvidencia = diasConEvidencia;
  }
}

/**
 * N fechas consecutivas (días corridos, incluyen fines de semana) desde una
 * fecha base. Lima no observa horario de verano, así que sumar 86.400.000 ms
 * avanza exactamente un día calendario.
 */
function generarFechasConsecutivas(fechaInicio, n) {
  const base = fechaInicio instanceof Date ? fechaInicio : new Date(fechaInicio);
  const total = Math.max(1, Number(n) || 1);
  const fechas = [];
  for (let i = 0; i < total; i++) {
    fechas.push(new Date(base.getTime() + i * MS_POR_DIA));
  }
  return fechas;
}

/**
 * Conteo de evidencias activas por día de un servicio.
 * @param {object} opts
 * @param {boolean} [opts.soloGenerales=false] Si true, cuenta solo evidencias
 *   "generales" (id_respuesta NULL), excluyendo las fotos de ítems del checklist
 *   de finalización. La regla "1 evidencia general por día" usa este modo; el
 *   guard de recorte de duración cuenta TODA evidencia (cualquier trabajo del día).
 * @returns {Map<number, number>} id_dia → cantidad de evidencias activas.
 */
async function contarEvidenciasPorDia(db, idServicio, { soloGenerales = false } = {}) {
  const grupos = await db.tbl_servicios_evidencias.groupBy({
    by: ['id_dia'],
    where: {
      id_servicio: idServicio, estado: 1, id_dia: { not: null },
      ...(soloGenerales ? { id_respuesta: null } : {})
    },
    _count: { _all: true }
  });
  const mapa = new Map();
  for (const g of grupos) mapa.set(g.id_dia, g._count._all);
  return mapa;
}

/**
 * Días activos de un servicio que aún NO tienen evidencia. Lista usada por el
 * gate de finalización (solo aplica a servicios multidía).
 * @returns {Promise<Array<{ id:number, orden:number, fecha:Date }>>}
 */
async function diasSinEvidencia(db, idServicio) {
  const dias = await db.tbl_servicios_dias.findMany({
    where: { id_servicio: idServicio, estado: 1 },
    orderBy: { orden: 'asc' }
  });
  if (dias.length === 0) return [];
  // Solo cuentan las evidencias generales: las fotos de ítems del checklist no
  // "rellenan" la obligación de ≥1 evidencia general por día.
  const conteo = await contarEvidenciasPorDia(db, idServicio, { soloGenerales: true });
  return dias
    .filter(d => (conteo.get(d.id) || 0) === 0)
    .map(d => ({ id: d.id, orden: d.orden, fecha: d.fecha }));
}

/**
 * Regenera los días y los eventos de calendario de un servicio a partir de su
 * fecha/hora programada y `duracion_dias`. Idempotente.
 *
 * - Conserva los días existentes (y su evidencia) emparejando por `orden`.
 * - Días sobrantes (orden > N) se dan de baja; si alguno tiene evidencia y no
 *   se pasó `confirmar`, lanza ConfirmacionRequeridaError (no toca nada).
 * - Reutiliza los eventos de calendario existentes del servicio (incluido el
 *   evento único legacy con id_dia = null) para no dejar huérfanos ni duplicar.
 *
 * @param {object} db cliente Prisma o transacción
 * @param {number} idServicio
 * @param {{ userId?:number, confirmar?:boolean }} opts
 */
async function sincronizarDiasYEventos(db, idServicio, { userId = null, confirmar = false } = {}) {
  const servicio = await db.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    select: {
      id: true, codigo: true, titulo: true, tipo_registro: true,
      fecha_programada: true, hora_programada: true, duracion_dias: true,
      estado_servicio: true
    }
  });
  if (!servicio || !servicio.fecha_programada) return { dias: [] };

  const n = Math.max(1, Number(servicio.duracion_dias) || 1);
  const fechas = generarFechasConsecutivas(servicio.fecha_programada, n);
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };

  const diasExistentes = await db.tbl_servicios_dias.findMany({
    where: { id_servicio: idServicio, estado: 1 },
    orderBy: { orden: 'asc' }
  });
  const diasPorOrden = new Map(diasExistentes.map(d => [d.orden, d]));

  // Guard: recortar la duración no debe descartar días ya trabajados sin avisar.
  const sobrantes = diasExistentes.filter(d => d.orden > n);
  if (sobrantes.length > 0 && !confirmar) {
    const conteo = await contarEvidenciasPorDia(db, idServicio);
    const conEvidencia = sobrantes
      .filter(d => (conteo.get(d.id) || 0) > 0)
      .map(d => ({ orden: d.orden, fecha: d.fecha }));
    if (conEvidencia.length > 0) throw new ConfirmacionRequeridaError(conEvidencia);
  }

  // 1. Crear/actualizar los días orden 1..N.
  const diasFinales = [];
  for (let orden = 1; orden <= n; orden++) {
    const fecha = fechas[orden - 1];
    const existente = diasPorOrden.get(orden);
    if (existente) {
      const dia = await db.tbl_servicios_dias.update({
        where: { id: existente.id },
        data: { fecha, estado: 1, ...stamp }
      });
      diasFinales.push(dia);
    } else {
      const dia = await db.tbl_servicios_dias.create({
        data: { id_servicio: idServicio, orden, fecha, user_id_registration: userId }
      });
      diasFinales.push(dia);
    }
  }

  // 2. Dar de baja los días sobrantes (orden > N).
  for (const d of sobrantes) {
    await db.tbl_servicios_dias.update({
      where: { id: d.id },
      data: { estado: 0, ...stamp }
    });
  }

  // 3. Sincronizar los eventos de calendario: uno por día activo. Se reutilizan
  //    los eventos existentes del servicio (incluido el legacy con id_dia null).
  const eventos = await db.tbl_calendario_eventos.findMany({
    where: { id_servicio: idServicio, estado: 1 },
    orderBy: { id: 'asc' }
  });
  const eventosPorDia = new Map();
  const eventosLibres = [];
  for (const e of eventos) {
    if (e.id_dia) eventosPorDia.set(e.id_dia, e);
    else eventosLibres.push(e);
  }

  // Tipo/color base para días NUEVOS: se hereda del evento existente del servicio
  // (preserva la semántica de emergencia/correctivo/mantenimiento) y, si no hay,
  // se deriva de tipo_registro. En los eventos ya existentes NO se tocan tipo ni
  // color (no relabelamos eventos de otros módulos al regenerar).
  const tipoBase = eventos[0]?.tipo_evento || tipoEventoDesdeRegistro(servicio.tipo_registro);
  const colorBase = eventos[0]?.color || colorPorTipo(tipoBase);
  const eventosUsados = new Set();

  for (const dia of diasFinales) {
    const titulo = `${servicio.codigo} – ${servicio.titulo}` + (n > 1 ? ` (Día ${dia.orden}/${n})` : '');
    const fechaInicio = combinarFechaHoraLima(dia.fecha, servicio.hora_programada);
    let evento = eventosPorDia.get(dia.id) || eventosLibres.shift();
    if (evento) {
      await db.tbl_calendario_eventos.update({
        where: { id: evento.id },
        data: { id_dia: dia.id, titulo, fecha_inicio: fechaInicio, ...stamp }
      });
      eventosUsados.add(evento.id);
    } else {
      const creado = await db.tbl_calendario_eventos.create({
        data: {
          id_servicio: idServicio,
          id_dia: dia.id,
          titulo,
          tipo_evento: tipoBase,
          fecha_inicio: fechaInicio,
          estado_evento: ESTADO_EVENTO_PROGRAMADO,
          color: colorBase
        }
      });
      eventosUsados.add(creado.id);
    }
  }

  // 4. Dar de baja los eventos que sobraron (de días eliminados o duplicados).
  const sobrantesEventos = eventos.filter(e => !eventosUsados.has(e.id));
  for (const e of sobrantesEventos) {
    await db.tbl_calendario_eventos.update({
      where: { id: e.id },
      data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, ...stamp }
    });
  }

  return { dias: diasFinales };
}

module.exports = {
  sincronizarDiasYEventos,
  diasSinEvidencia,
  generarFechasConsecutivas,
  contarEvidenciasPorDia,
  ConfirmacionRequeridaError,
  tipoEventoDesdeRegistro
};

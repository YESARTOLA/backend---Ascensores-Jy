/**
 * Días de un servicio/proyecto multidía.
 *
 * Un trabajo puede ocupar varios días, y NO necesariamente corridos: un rango
 * (10–14 de agosto), fechas sueltas (10, 15 y 20 de agosto) o una combinación de
 * ambos. `tbl_servicios_dias` es la fuente de verdad de esa programación: una
 * fila por día programado, con `orden` 1..N asignado por fecha ascendente.
 * Cada día tiene EXACTAMENTE un evento en `tbl_calendario_eventos` (la agenda
 * muestra "Día k/N"), así que el técnico solo ve en su calendario los días que
 * realmente se van a trabajar. Las evidencias se ligan a su día vía `id_dia`.
 *
 * `sincronizarDiasYEventos` es el ÚNICO lugar que escribe los días de un
 * servicio y sus eventos de calendario: regenera ambos a la vez, y de paso
 * deriva en el servicio `fecha_programada` (= primer día programado) y
 * `duracion_dias` (= CANTIDAD de días programados, no el lapso entre el primero
 * y el último), para que nunca se desincronicen.
 *
 * Al regenerar conserva los días ya existentes (con su evidencia) emparejando
 * primero por FECHA exacta —el día 15 sigue siendo el día 15 aunque cambie su
 * posición— y luego, para las fechas que quedan sin dueño, por `orden` entre los
 * días sobrantes: así una reprogramación en bloque (mover todo una semana)
 * arrastra la evidencia en lugar de descartarla.
 *
 * La completitud de un día NO se almacena: se deriva de tener ≥1 evidencia
 * activa (ver `diasSinEvidencia`).
 */

const { ESTADO_EVENTO_PROGRAMADO, ESTADO_EVENTO_CANCELADO } = require('./estadoEvento');
const { combinarFechaHoraLima, parseYMDLima, ymdDeFecha } = require('./tiempo');
const { colorPorTipo } = require('./visibilidadCalendario');
const { normalizarProgramacion, desplazarFechas, diasEntreYMD } = require('./programacionDias');

const MS_POR_DIA = 86400000;

const tipoEventoDesdeRegistro = (tipoRegistro) =>
  tipoRegistro === 'proyecto' ? 'proyecto' : 'servicio';

/** Error de negocio: la nueva programación deja fuera días que ya tienen evidencia. */
class ConfirmacionRequeridaError extends Error {
  constructor(diasConEvidencia) {
    super('La nueva programación eliminaría días que ya tienen evidencia');
    this.code = 'REQUIERE_CONFIRMACION';
    this.diasConEvidencia = diasConEvidencia;
  }
}

/**
 * Ejecuta `fn` dentro de una transacción si `db` es el cliente Prisma raíz; si ya
 * es un cliente transaccional (no expone `$transaction`), la reutiliza. Evita
 * dejar la grilla a medio regenerar si algo falla en medio.
 */
function enTransaccion(db, fn) {
  return typeof db?.$transaction === 'function'
    ? db.$transaction(fn, { timeout: 20000 })
    : fn(db);
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
 *   guard de reprogramación cuenta TODA evidencia (cualquier trabajo del día).
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
 * Programación vigente de un servicio: fechas 'YYYY-MM-DD' ascendentes de sus
 * días activos. Lista vacía si aún no se generó la grilla.
 */
async function fechasProgramadas(db, idServicio) {
  const dias = await db.tbl_servicios_dias.findMany({
    where: { id_servicio: idServicio, estado: 1 },
    orderBy: { fecha: 'asc' },
    select: { fecha: true }
  });
  return dias.map(d => ymdDeFecha(d.fecha)).filter(Boolean);
}

/**
 * Empareja cada fecha objetivo con un día ya existente, en dos pasadas:
 *   1. por FECHA exacta (incluye días dados de baja: si se vuelve a programar el
 *      15 se recupera el día original con su evidencia);
 *   2. por ORDEN entre los días ACTIVOS que quedaron sin fecha, para que una
 *      reprogramación en bloque mueva los días en vez de recrearlos.
 * Los días activos que no reciben fecha son los "sobrantes" (se dan de baja).
 *
 * @returns {{ asignacion: Map<string, object>, sobrantes: object[] }}
 */
function emparejarDias(fechasYMD, existentes) {
  const porFecha = new Map();
  for (const d of existentes) {
    const ymd = ymdDeFecha(d.fecha);
    // Con dos filas para la misma fecha (activa e inactiva) gana la activa.
    const previo = porFecha.get(ymd);
    if (!previo || (previo.estado !== 1 && d.estado === 1)) porFecha.set(ymd, d);
  }

  const asignacion = new Map();
  const usados = new Set();
  const pendientes = [];
  for (const ymd of fechasYMD) {
    const candidato = porFecha.get(ymd);
    if (candidato && !usados.has(candidato.id)) {
      asignacion.set(ymd, candidato);
      usados.add(candidato.id);
    } else {
      pendientes.push(ymd);
    }
  }

  const librePorOrden = existentes
    .filter(d => d.estado === 1 && !usados.has(d.id))
    .sort((a, b) => a.orden - b.orden);
  for (const ymd of pendientes) {
    const reutilizable = librePorOrden.shift();
    if (!reutilizable) break;
    asignacion.set(ymd, reutilizable);
    usados.add(reutilizable.id);
  }

  return { asignacion, sobrantes: librePorOrden };
}

/**
 * Regenera los días programados de un servicio y sus eventos de calendario.
 * Idempotente.
 *
 * @param {object} db cliente Prisma o transacción
 * @param {number} idServicio
 * @param {object} opts
 * @param {number} [opts.userId]
 * @param {boolean} [opts.confirmar=false] permite descartar días con evidencia
 * @param {Array|object} [opts.fechas] nueva programación (fechas sueltas y/o
 *   rangos; ver utils/programacionDias). Si se omite, se conserva la
 *   programación vigente y, si aún no hay días, se derivan días corridos desde
 *   `fecha_programada` según `duracion_dias` (retrocompatible).
 * @param {string} [opts.tituloBase] título de los eventos (default `código – título`)
 * @param {string} [opts.tipoEvento] fuerza el tipo de evento (emergencia/correctivo…)
 * @param {string} [opts.color] fuerza el color del evento
 * @param {number} [opts.idEmergencia] vincula los eventos a una emergencia
 * @param {Date}   [opts.fechaFinEvento] `fecha_fin` del evento cuando la
 *   programación es de un solo día (fecha estimada de término).
 * @param {boolean} [opts.sinEventos=false] genera solo la grilla de días, sin
 *   llevarla al calendario. Lo usan los BORRADORES: conservan la programación
 *   cargada en el formulario pero siguen invisibles en la agenda hasta que se
 *   promueven (al promoverse se sincroniza de nuevo y se crean los eventos).
 */
async function sincronizarDiasYEventos(db, idServicio, opts = {}) {
  const {
    userId = null, confirmar = false, fechas = null,
    tituloBase = null, tipoEvento = null, color = null,
    idEmergencia = null, fechaFinEvento = null, sinEventos = false
  } = opts;

  // Se normaliza FUERA de la transacción: un tramo inválido debe fallar antes de
  // tocar nada (el caller lo traduce a un 400).
  const fechasPedidas = normalizarProgramacion(fechas);

  return enTransaccion(db, async (tx) => {
    const servicio = await tx.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio },
      select: {
        id: true, codigo: true, titulo: true, tipo_registro: true,
        fecha_programada: true, hora_programada: true, duracion_dias: true,
        estado_servicio: true
      }
    });
    if (!servicio) return { dias: [], fechas: [] };

    const existentes = await tx.tbl_servicios_dias.findMany({
      where: { id_servicio: idServicio },
      orderBy: { orden: 'asc' }
    });

    // Fechas objetivo: las pedidas > la programación vigente > días corridos
    // desde la fecha programada (grilla inicial de un servicio legacy).
    let fechasYMD = fechasPedidas;
    if (!fechasYMD) {
      const vigentes = existentes.filter(d => d.estado === 1).map(d => ymdDeFecha(d.fecha)).filter(Boolean);
      if (vigentes.length > 0) {
        fechasYMD = [...new Set(vigentes)].sort();
      } else {
        if (!servicio.fecha_programada) return { dias: [], fechas: [] };
        fechasYMD = generarFechasConsecutivas(servicio.fecha_programada, servicio.duracion_dias)
          .map(f => ymdDeFecha(f));
      }
    }

    const n = fechasYMD.length;
    const stamp = { user_id_modification: userId, date_time_modification: new Date() };
    const { asignacion, sobrantes } = emparejarDias(fechasYMD, existentes);

    // Guard: reprogramar no debe descartar en silencio días ya trabajados.
    if (sobrantes.length > 0 && !confirmar) {
      const conteo = await contarEvidenciasPorDia(tx, idServicio);
      const conEvidencia = sobrantes
        .filter(d => (conteo.get(d.id) || 0) > 0)
        .map(d => ({ orden: d.orden, fecha: d.fecha }));
      if (conEvidencia.length > 0) throw new ConfirmacionRequeridaError(conEvidencia);
    }

    // `orden` es único por servicio, incluidos los días dados de baja. Antes de
    // renumerar se aparcan todos en órdenes negativos (únicos por construcción)
    // para que ningún paso intermedio choque con el índice.
    for (const d of existentes) {
      if (d.orden !== -d.id) {
        await tx.tbl_servicios_dias.update({ where: { id: d.id }, data: { orden: -d.id } });
      }
    }

    // 1. Crear/actualizar los días 1..N en orden de fecha.
    const diasFinales = [];
    for (let i = 0; i < n; i++) {
      const ymd = fechasYMD[i];
      const orden = i + 1;
      const fecha = parseYMDLima(ymd);
      const existente = asignacion.get(ymd);
      if (existente) {
        diasFinales.push(await tx.tbl_servicios_dias.update({
          where: { id: existente.id },
          data: { orden, fecha, estado: 1, ...stamp }
        }));
      } else {
        diasFinales.push(await tx.tbl_servicios_dias.create({
          data: { id_servicio: idServicio, orden, fecha, user_id_registration: userId }
        }));
      }
    }

    // 2. Dar de baja los días que ya no están programados.
    for (const d of sobrantes) {
      await tx.tbl_servicios_dias.update({ where: { id: d.id }, data: { estado: 0, ...stamp } });
    }

    // 3. Derivar en el servicio la fecha programada (primer día) y la cantidad de
    //    días programados: los listados y el panel del técnico siguen leyendo de
    //    ahí, y así jamás contradicen la grilla.
    const cambiaFecha = ymdDeFecha(servicio.fecha_programada) !== fechasYMD[0];
    if (cambiaFecha || servicio.duracion_dias !== n) {
      await tx.tbl_servicios_proyectos.update({
        where: { id: idServicio },
        data: { fecha_programada: parseYMDLima(fechasYMD[0]), duracion_dias: n, ...stamp }
      });
    }

    if (sinEventos) return { dias: diasFinales, fechas: fechasYMD };

    // 4. Sincronizar los eventos de calendario: uno por día programado. Se
    //    reutilizan los eventos existentes del servicio (incluido el legacy con
    //    id_dia null) para no dejar huérfanos ni duplicar.
    const eventos = await tx.tbl_calendario_eventos.findMany({
      where: { id_servicio: idServicio, estado: 1 },
      orderBy: { id: 'asc' }
    });
    const eventosPorDia = new Map();
    const eventosLibres = [];
    for (const e of eventos) {
      if (e.id_dia) eventosPorDia.set(e.id_dia, e);
      else eventosLibres.push(e);
    }

    // Tipo/color base para días NUEVOS: lo que pida el caller (módulo operativo),
    // si no el del evento existente del servicio (preserva la semántica de
    // emergencia/correctivo/mantenimiento) y, si no hay, se deriva de
    // tipo_registro. Sin indicación explícita NO se relabelan los eventos ya
    // existentes: no se reetiquetan eventos de otros módulos al regenerar.
    const tipoBase = tipoEvento || eventos[0]?.tipo_evento || tipoEventoDesdeRegistro(servicio.tipo_registro);
    const colorBase = color || (tipoEvento ? colorPorTipo(tipoEvento) : eventos[0]?.color) || colorPorTipo(tipoBase);
    const reetiquetar = !!tipoEvento;
    const base = tituloBase || `${servicio.codigo} – ${servicio.titulo}`;
    const eventosUsados = new Set();

    for (const dia of diasFinales) {
      const titulo = base + (n > 1 ? ` (Día ${dia.orden}/${n})` : '');
      const fechaInicio = combinarFechaHoraLima(dia.fecha, servicio.hora_programada);
      // La fecha estimada de término solo extiende el evento cuando el trabajo se
      // programó en un único día; con varios días, cada día ya es su propio evento.
      const fechaFin = n === 1 ? (fechaFinEvento || null) : null;
      const evento = eventosPorDia.get(dia.id) || eventosLibres.shift();
      if (evento) {
        await tx.tbl_calendario_eventos.update({
          where: { id: evento.id },
          data: {
            id_dia: dia.id, titulo, fecha_inicio: fechaInicio, fecha_fin: fechaFin,
            ...(reetiquetar ? { tipo_evento: tipoBase, color: colorBase } : {}),
            ...(idEmergencia ? { id_emergencia: idEmergencia } : {}),
            ...stamp
          }
        });
        eventosUsados.add(evento.id);
      } else {
        const creado = await tx.tbl_calendario_eventos.create({
          data: {
            id_servicio: idServicio,
            id_dia: dia.id,
            ...(idEmergencia ? { id_emergencia: idEmergencia } : {}),
            titulo,
            tipo_evento: tipoBase,
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
            estado_evento: ESTADO_EVENTO_PROGRAMADO,
            color: colorBase,
            user_id_registration: userId
          }
        });
        eventosUsados.add(creado.id);
      }
    }

    // 5. Dar de baja los eventos que sobraron (de días eliminados o duplicados).
    for (const e of eventos.filter(ev => !eventosUsados.has(ev.id))) {
      await tx.tbl_calendario_eventos.update({
        where: { id: e.id },
        data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, ...stamp }
      });
    }

    return { dias: diasFinales, fechas: fechasYMD };
  });
}

/**
 * Programación vigente movida `delta` días (o hasta una nueva fecha de inicio),
 * conservando su FORMA: un trabajo de 10/15/20 reprogramado una semana después
 * pasa a 17/22/27, no a tres días corridos. Devuelve null si el servicio todavía
 * no tiene grilla de días (el caller cae entonces a los días corridos clásicos).
 *
 * @param {object} db
 * @param {number} idServicio
 * @param {{delta?:number, nuevoInicio?:string}} opts
 */
async function reprogramarConservandoForma(db, idServicio, { delta = null, nuevoInicio = null } = {}) {
  const vigentes = await fechasProgramadas(db, idServicio);
  if (vigentes.length === 0) return null;
  const desplazamiento = delta != null ? delta : diasEntreYMD(vigentes[0], nuevoInicio);
  if (!desplazamiento) return vigentes;
  return desplazarFechas(vigentes, desplazamiento);
}

module.exports = {
  sincronizarDiasYEventos,
  reprogramarConservandoForma,
  diasSinEvidencia,
  fechasProgramadas,
  generarFechasConsecutivas,
  contarEvidenciasPorDia,
  ConfirmacionRequeridaError,
  tipoEventoDesdeRegistro
};

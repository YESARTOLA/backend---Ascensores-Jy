/**
 * RECONSTRUCCIÓN DEL CRONOGRAMA DE UN PLAN — reparación de planes sin programación.
 *
 * Los planes creados ANTES de la migración al modelo mensual
 * (20260823120000_plan_mantenimiento_mensual) no tienen ninguna fila en
 * tbl_mantenimientos_programacion: esa tabla nació vacía. Sin cronograma, el
 * plan se ve roto aunque sus datos estén bien —"0 de 0" mantenimientos
 * programados, meses "0/0", y en "Mantenimientos del plan" solo aparecen los
 * servicios ya creados, sin las visitas pendientes.
 *
 * Este módulo reconstruye ese cronograma:
 *
 *  1. Rearma la serie teórica de cada ascensor con SU frecuencia y la duración
 *     del plan.
 *  2. ENGANCHA los servicios que ya existen: un servicio del plan sobre un
 *     ascensor en una fecha se convierte en la visita de esa fecha (conservando
 *     su evento de calendario), de modo que lo ya ejecutado cuenta como
 *     realizado en su mes.
 *  3. Para el resto reutiliza los eventos futuros que el modelo anterior dejó
 *     en el calendario (mismo ascensor+fecha) y solo crea evento nuevo cuando no
 *     hay ninguno que reutilizar — así no se duplican eventos.
 *
 * Es la ÚNICA implementación de esta reparación: la usan tanto el script masivo
 * `scripts/backfillProgramacionPlanes.js` como el endpoint por plan
 * (POST /mantenimientos/:id/programacion/reconstruir).
 *
 * NO toca planes que ya tienen cronograma: para esos, el camino es la
 * regeneración normal (mantenimientosController._regenerarProgramacion), que
 * conserva lo materializado y completa lo que falte.
 */

const { ymdDeFecha, parseYMDLima } = require('./tiempo');
const { programacionDelPlan, mesDeFecha } = require('./programacionPlanMantenimiento');
const { frecuenciaDeAscensor, tituloBasePlan, eventoDeVisita } = require('./planMantenimientoMensual');
const { obtenerFrecuencia } = require('./frecuenciaMantenimiento');

// Horizonte amplio para ubicar en un mes del plan los servicios reagendados
// fuera de la duración pactada (50 años): nunca deben quedarse sin mes.
const HORIZONTE_MESES_EXTRA = 600;

/**
 * Reconstruye el cronograma de UN plan que no tiene ninguna visita registrada.
 *
 * @param {object} client  Cliente Prisma transaccional (o el global).
 * @param {object} plan    Plan con `ascensores` (junction) incluidos, y cada uno
 *                         con su `ascensor` (id, codigo, edificio.nombre).
 * @param {object} opts
 * @param {number|null} [opts.userId]  Autor del cambio (null = sistema).
 * @returns {Promise<{creadas:number, enganchadas:number, eventosCreados:number,
 *                    eventosReutilizados:number, motivo?:string}>}
 */
async function reconstruirCronogramaPlan(client, plan, { userId = null } = {}) {
  const vacio = { creadas: 0, enganchadas: 0, eventosCreados: 0, eventosReutilizados: 0 };

  const activos = (plan.ascensores || []).filter(f => f.estado === 1);
  if (activos.length === 0) return { ...vacio, motivo: 'El plan no tiene ascensores activos' };

  const yaTiene = await client.tbl_mantenimientos_programacion.count({ where: { id_plan: plan.id } });
  if (yaTiene > 0) return { ...vacio, motivo: 'El plan ya tiene cronograma' };

  const fechaInicioYMD = ymdDeFecha(plan.fecha_inicio);
  const esEventual = plan.tipo_plan === 'eventual';
  const duracionMeses = esEventual ? 1 : Number(plan.duracion_meses || 12);

  // Serie teórica. Un plan eventual —o uno legado sin frecuencia válida— recibe
  // una única visita por ascensor en la fecha de inicio.
  const teoricas = (esEventual || !obtenerFrecuencia(plan.frecuencia))
    ? activos.map(f => ({ id_ascensor: f.id_ascensor, ordinal: 1, numero_mes: 1, fecha: fechaInicioYMD }))
    : programacionDelPlan({
        fechaInicioYMD,
        duracionMeses,
        ascensores: activos.map(f => ({ id_ascensor: f.id_ascensor, ...frecuenciaDeAscensor(f, plan) }))
      });

  // Servicios vivos del plan, indexados por ascensor + fecha programada.
  const servicios = await client.tbl_servicios_proyectos.findMany({
    where: { id_mantenimiento_plan: plan.id, estado: 1 },
    select: {
      id: true, fecha_programada: true,
      ascensores: { where: { estado: 1 }, select: { id_ascensor: true } },
      eventos_calendario: { where: { estado: 1 }, select: { id: true }, take: 1 }
    }
  });
  const servicioPorClave = new Map();
  for (const s of servicios) {
    for (const a of s.ascensores) {
      servicioPorClave.set(`${a.id_ascensor}|${ymdDeFecha(s.fecha_programada)}`, s);
    }
  }

  // Eventos del plan sin servicio: programación futura del modelo anterior. El
  // modelo viejo no ligaba evento ↔ ascensor, así que solo se pueden reutilizar
  // por fecha; se reparten entre los ascensores de esa fecha.
  const eventosLibres = await client.tbl_calendario_eventos.findMany({
    where: { id_mantenimiento_plan: plan.id, estado: 1, id_servicio: null },
    select: { id: true, fecha_inicio: true },
    orderBy: { fecha_inicio: 'asc' }
  });
  const librePorFecha = new Map();
  for (const e of eventosLibres) {
    const k = ymdDeFecha(e.fecha_inicio);
    if (!librePorFecha.has(k)) librePorFecha.set(k, []);
    librePorFecha.get(k).push(e.id);
  }

  const junctionPorAscensor = new Map(activos.map(f => [f.id_ascensor, f]));
  const tituloBase = tituloBasePlan(activos.map(f => f.ascensor?.edificio?.nombre).find(Boolean) || null);

  // A la serie teórica se le añaden las fechas de servicios REALES que no
  // coincidan con ninguna teórica (visitas reagendadas), para no perder ningún
  // mantenimiento ya ejecutado.
  const clavesTeoricas = new Set(teoricas.map(t => `${t.id_ascensor}|${t.fecha}`));
  const extra = [];
  for (const [clave] of servicioPorClave) {
    if (clavesTeoricas.has(clave)) continue;
    const [idAsc, fecha] = clave.split('|');
    if (!junctionPorAscensor.has(Number(idAsc))) continue;
    extra.push({ id_ascensor: Number(idAsc), fecha, numero_mes: null, ordinal: null });
  }

  const todas = [...teoricas, ...extra].sort((a, b) =>
    a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.id_ascensor - b.id_ascensor
  );

  // Ordinal correlativo por ascensor sobre el conjunto final ordenado por fecha.
  const contador = new Map();
  const filas = todas.map(t => {
    const n = (contador.get(t.id_ascensor) || 0) + 1;
    contador.set(t.id_ascensor, n);
    // Mes del plan: el teórico, o el que corresponda a la fecha para los extra.
    // Una fecha anterior al inicio del plan no tiene ventana: cae al mes 1.
    const numeroMes = t.numero_mes
      ?? (mesDeFecha(fechaInicioYMD, Math.max(duracionMeses, HORIZONTE_MESES_EXTRA), t.fecha) || 1);
    return { ...t, ordinal: n, numero_mes: numeroMes };
  });

  const salida = { ...vacio };
  for (const f of filas) {
    const junction = junctionPorAscensor.get(f.id_ascensor);
    if (!junction) continue;
    const servicio = servicioPorClave.get(`${f.id_ascensor}|${f.fecha}`) || null;

    // Evento de la visita: el del servicio si ya lo tiene; si no, uno libre de
    // esa fecha; y como último recurso, uno nuevo.
    let idEvento = servicio?.eventos_calendario?.[0]?.id || null;
    if (!idEvento) {
      const libres = librePorFecha.get(f.fecha) || [];
      idEvento = libres.shift() || null;
      if (idEvento) salida.eventosReutilizados++;
    }
    if (!idEvento) {
      const nuevo = await client.tbl_calendario_eventos.create({
        data: eventoDeVisita({
          plan, fechaYMD: f.fecha, tituloBase, codigoAscensor: junction.ascensor?.codigo || null
        })
      });
      idEvento = nuevo.id;
      salida.eventosCreados++;
    }

    await client.tbl_mantenimientos_programacion.create({
      data: {
        id_plan: plan.id,
        id_plan_ascensor: junction.id,
        id_ascensor: f.id_ascensor,
        numero_mes: f.numero_mes,
        ordinal: f.ordinal,
        fecha_programada: parseYMDLima(f.fecha),
        id_servicio: servicio?.id || null,
        id_evento: idEvento,
        user_id_registration: userId
      }
    });
    salida.creadas++;
    if (servicio) salida.enganchadas++;
  }

  // `cantidad_mantenimientos` es derivado del cronograma.
  await client.tbl_mantenimientos_planes.update({
    where: { id: plan.id },
    data: { cantidad_mantenimientos: salida.creadas }
  });

  return salida;
}

module.exports = { reconstruirCronogramaPlan, HORIZONTE_MESES_EXTRA };

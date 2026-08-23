/**
 * BACKFILL — cronograma de los planes de mantenimiento existentes.
 *
 * La migración 20260823120000_plan_mantenimiento_mensual añadió la duración en
 * meses, el monto mensual y la frecuencia por ascensor, pero el cronograma
 * (tbl_mantenimientos_programacion) es una tabla nueva y nace vacía. Este script
 * la puebla para los planes ya creados:
 *
 *  1. Reconstruye la serie teórica de cada ascensor con su frecuencia y la
 *     duración del plan.
 *  2. ENGANCHA a esa serie los mantenimientos que ya existen: un servicio del
 *     plan sobre un ascensor en una fecha se convierte en la visita de esa
 *     fecha, conservando su evento de calendario.
 *  3. Crea las visitas restantes reutilizando los eventos futuros que el modelo
 *     anterior ya había dejado en el calendario (mismo ascensor + misma fecha),
 *     y genera evento nuevo solo cuando no hay ninguno que reutilizar.
 *
 * Es IDEMPOTENTE: un plan que ya tiene cronograma se salta.
 *
 * Uso:
 *   node scripts/backfillProgramacionPlanes.js            (aplica)
 *   node scripts/backfillProgramacionPlanes.js --dry-run  (solo informa)
 */
const prisma = require('../config/prisma');
const { ymdDeFecha, parseYMDLima } = require('../utils/tiempo');
const { programacionDelPlan } = require('../utils/programacionPlanMantenimiento');
const { frecuenciaDeAscensor, tituloBasePlan, eventoDeVisita } = require('../utils/planMantenimientoMensual');
const { obtenerFrecuencia } = require('../utils/frecuenciaMantenimiento');

const DRY = process.argv.includes('--dry-run');
const USER_SISTEMA = null;

async function procesarPlan(plan, resumen) {
  const activos = (plan.ascensores || []).filter(f => f.estado === 1);
  if (activos.length === 0) { resumen.sinAscensores++; return; }

  const fechaInicioYMD = ymdDeFecha(plan.fecha_inicio);
  const esEventual = plan.tipo_plan === 'eventual';
  const duracionMeses = esEventual ? 1 : Number(plan.duracion_meses || 12);

  // Serie teórica. Un plan sin frecuencia válida (eventuales legados) recibe una
  // única visita por ascensor en la fecha de inicio.
  let teoricas;
  try {
    teoricas = esEventual || !obtenerFrecuencia(plan.frecuencia)
      ? activos.map(f => ({ id_ascensor: f.id_ascensor, ordinal: 1, numero_mes: 1, fecha: fechaInicioYMD }))
      : programacionDelPlan({
          fechaInicioYMD,
          duracionMeses,
          ascensores: activos.map(f => ({ id_ascensor: f.id_ascensor, ...frecuenciaDeAscensor(f, plan) }))
        });
  } catch (e) {
    resumen.errores.push(`Plan ${plan.id}: ${e.message}`);
    return;
  }

  // Servicios ya materializados del plan, indexados por ascensor + fecha.
  const servicios = await prisma.tbl_servicios_proyectos.findMany({
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

  // Eventos del plan sin servicio (programación futura del modelo anterior).
  // El modelo viejo no ligaba evento ↔ ascensor, así que solo se pueden
  // reutilizar por fecha; se reparten entre los ascensores de esa fecha.
  const eventosLibres = await prisma.tbl_calendario_eventos.findMany({
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

  // Visitas a crear. A la serie teórica se le añaden las fechas de servicios
  // reales que no coincidan con ninguna teórica (reagendados), para no perder
  // ningún mantenimiento ya ejecutado.
  const clavesTeoricas = new Set(teoricas.map(t => `${t.id_ascensor}|${t.fecha}`));
  const extra = [];
  for (const [clave, s] of servicioPorClave) {
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
    let numeroMes = t.numero_mes;
    if (numeroMes == null) {
      const { mesDeFecha } = require('../utils/programacionPlanMantenimiento');
      numeroMes = mesDeFecha(fechaInicioYMD, Math.max(duracionMeses, 600), t.fecha) || 1;
    }
    return { ...t, ordinal: n, numero_mes: numeroMes };
  });

  if (DRY) {
    resumen.planes++;
    resumen.visitas += filas.length;
    resumen.enganchadas += filas.filter(f => servicioPorClave.has(`${f.id_ascensor}|${f.fecha}`)).length;
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const f of filas) {
      const junction = junctionPorAscensor.get(f.id_ascensor);
      if (!junction) continue;
      const clave = `${f.id_ascensor}|${f.fecha}`;
      const servicio = servicioPorClave.get(clave) || null;

      let idEvento = servicio?.eventos_calendario?.[0]?.id || null;
      if (!idEvento) {
        const libres = librePorFecha.get(f.fecha) || [];
        idEvento = libres.shift() || null;
      }
      if (!idEvento) {
        const nuevo = await tx.tbl_calendario_eventos.create({
          data: eventoDeVisita({
            plan, fechaYMD: f.fecha, tituloBase, codigoAscensor: junction.ascensor?.codigo || null
          })
        });
        idEvento = nuevo.id;
        resumen.eventosCreados++;
      }

      await tx.tbl_mantenimientos_programacion.create({
        data: {
          id_plan: plan.id,
          id_plan_ascensor: junction.id,
          id_ascensor: f.id_ascensor,
          numero_mes: f.numero_mes,
          ordinal: f.ordinal,
          fecha_programada: parseYMDLima(f.fecha),
          id_servicio: servicio?.id || null,
          id_evento: idEvento,
          user_id_registration: USER_SISTEMA
        }
      });
      if (servicio) resumen.enganchadas++;
    }
    await tx.tbl_mantenimientos_planes.update({
      where: { id: plan.id }, data: { cantidad_mantenimientos: filas.length }
    });
  }, { timeout: 120000 });

  resumen.planes++;
  resumen.visitas += filas.length;
}

(async () => {
  const resumen = {
    planes: 0, visitas: 0, enganchadas: 0, eventosCreados: 0,
    saltados: 0, sinAscensores: 0, errores: []
  };

  const planes = await prisma.tbl_mantenimientos_planes.findMany({
    orderBy: { id: 'asc' },
    include: {
      ascensores: {
        where: { estado: 1 },
        include: { ascensor: { select: { id: true, codigo: true, edificio: { select: { nombre: true } } } } }
      },
      _count: { select: { programacion: true } }
    }
  });

  console.log(`${DRY ? '[DRY-RUN] ' : ''}Planes a revisar: ${planes.length}`);
  for (const plan of planes) {
    if (plan._count.programacion > 0) { resumen.saltados++; continue; }
    try {
      await procesarPlan(plan, resumen);
    } catch (e) {
      resumen.errores.push(`Plan ${plan.id}: ${e.message}`);
    }
  }

  console.log('\n--- RESUMEN ---');
  console.log(`Planes procesados     : ${resumen.planes}`);
  console.log(`Planes ya con crono.  : ${resumen.saltados}`);
  console.log(`Planes sin ascensores : ${resumen.sinAscensores}`);
  console.log(`Visitas creadas       : ${resumen.visitas}`);
  console.log(`  ↳ con servicio ya   : ${resumen.enganchadas}`);
  console.log(`Eventos nuevos        : ${resumen.eventosCreados}`);
  if (resumen.errores.length) {
    console.log(`\nErrores (${resumen.errores.length}):`);
    resumen.errores.slice(0, 30).forEach(e => console.log('  - ' + e));
  }
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FALLO:', e);
  await prisma.$disconnect();
  process.exit(1);
});

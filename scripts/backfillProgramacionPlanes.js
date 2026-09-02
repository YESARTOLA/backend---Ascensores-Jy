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
const { ymdDeFecha } = require('../utils/tiempo');
const { programacionDelPlan } = require('../utils/programacionPlanMantenimiento');
const { frecuenciaDeAscensor } = require('../utils/planMantenimientoMensual');
const { obtenerFrecuencia } = require('../utils/frecuenciaMantenimiento');
// MISMA reparación que ofrece el botón "Generar programación" del detalle del
// plan (POST /mantenimientos/:id/programacion/reconstruir): una sola
// implementación para el arreglo masivo y para el de un plan suelto.
const { reconstruirCronogramaPlan } = require('../utils/reconstruirCronogramaPlan');

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

  // DRY-RUN: solo informa cuántas visitas saldrían y cuántas engancharían con un
  // servicio ya existente. No toca la base.
  if (DRY) {
    const servicios = await prisma.tbl_servicios_proyectos.findMany({
      where: { id_mantenimiento_plan: plan.id, estado: 1 },
      select: { fecha_programada: true, ascensores: { where: { estado: 1 }, select: { id_ascensor: true } } }
    });
    const claves = new Set();
    for (const s of servicios) {
      for (const a of s.ascensores) claves.add(`${a.id_ascensor}|${ymdDeFecha(s.fecha_programada)}`);
    }
    const clavesTeoricas = new Set(teoricas.map(t => `${t.id_ascensor}|${t.fecha}`));
    const extra = [...claves].filter(k => !clavesTeoricas.has(k)).length;
    resumen.planes++;
    resumen.visitas += teoricas.length + extra;
    resumen.enganchadas += claves.size;
    return;
  }

  // La reconstrucción real vive en utils/reconstruirCronogramaPlan: la misma que
  // usa el botón "Generar programación" del detalle del plan.
  const r = await prisma.$transaction(
    (tx) => reconstruirCronogramaPlan(tx, plan, { userId: USER_SISTEMA }),
    { timeout: 120000 }
  );
  if (r.motivo) { resumen.errores.push(`Plan ${plan.id}: ${r.motivo}`); return; }

  resumen.planes++;
  resumen.visitas += r.creadas;
  resumen.enganchadas += r.enganchadas;
  resumen.eventosCreados += r.eventosCreados;
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

/**
 * SANEAMIENTO de visitas duplicadas en el cronograma de los planes.
 *
 * Hasta la corrección de `teoricasFaltantes`, tanto la reconstrucción del
 * cronograma (utils/reconstruirCronogramaPlan) como su regeneración al editar
 * un plan (mantenimientosController._regenerarProgramacion) comparaban la serie
 * teórica con lo existente por FECHA EXACTA. Un mantenimiento reagendado a otro
 * día dejaba entonces su fecha teórica "libre", y el cronograma la volvía a
 * programar: el mes acababa con dos visitas —la real, ya ejecutada, y una
 * fantasma en el día pactado—.
 *
 * Consecuencias que esto dejó en los planes existentes:
 *   · el plan declara más mantenimientos de los contratados (un plan mensual de
 *     8 meses pidiendo 12 salidas);
 *   · esos meses nunca llegan a "completo" (les falta una visita que nadie va a
 *     hacer), así que aprobar el mes exige la aprobación forzada.
 *
 * Este script borra ESAS visitas fantasma y solo esas:
 *   · nunca toca una visita con servicio (lo ejecutado o en curso manda);
 *   · nunca toca una visita omitida a mano (activo = 0): es una decisión
 *     registrada del usuario y se conserva como constancia;
 *   · borra únicamente visitas ACTIVAS y SIN servicio que sobran en su mes,
 *     junto con su evento de calendario (que tampoco tiene servicio);
 *   · un mes con MÁS mantenimientos reales de los pactados se deja intacto: lo
 *     ejecutado no se descarta.
 * Tampoco crea nada: si a un plan le faltan visitas, eso se resuelve editándolo
 * (la regeneración ya completa lo que falte).
 *
 * `cantidad_mantenimientos` del plan se recalcula al final, que es lo que
 * muestra la ficha como "N de N mantenimientos programados".
 *
 * Uso:
 *   node scripts/sanearVisitasDuplicadas.js --dry-run   (solo informa; por defecto)
 *   node scripts/sanearVisitasDuplicadas.js --aplicar   (escribe los cambios)
 *   node scripts/sanearVisitasDuplicadas.js --aplicar --plan 123   (un solo plan)
 */
const prisma = require('../config/prisma');
const { ymdDeFecha } = require('../utils/tiempo');
const { programacionDelPlan, teoricasFaltantes } = require('../utils/programacionPlanMantenimiento');
const { frecuenciaDeAscensor } = require('../utils/planMantenimientoMensual');

const APLICAR = process.argv.includes('--aplicar');
const idxPlan = process.argv.indexOf('--plan');
const SOLO_PLAN = idxPlan >= 0 ? Number(process.argv[idxPlan + 1]) : null;
const prefijo = APLICAR ? '' : '[DRY-RUN] ';

/**
 * Visitas activas sin servicio que sobran en el cronograma de un plan.
 *
 * El cupo de cada (ascensor, mes) sale de la MISMA regla que usa ahora el
 * generador: sobre la serie teórica se descuentan las visitas ya registradas
 * con servicio, y lo que queda es lo que debería seguir pendiente. Entre las
 * pendientes reales de ese mes se conservan las que caen en una fecha teórica
 * —son las que el plan pactó— y sobran las demás.
 */
function visitasSobrantes(plan, visitas) {
  const teoricas = programacionDelPlan({
    fechaInicioYMD: ymdDeFecha(plan.fecha_inicio),
    duracionMeses: Number(plan.duracion_meses || 12),
    ascensores: plan.ascensores.map(f => ({ id_ascensor: f.id_ascensor, ...frecuenciaDeAscensor(f, plan) }))
  });

  const activas = visitas.filter(v => v.activo === 1);
  const conServicio = activas.filter(v => v.id_servicio);
  const pendientes = activas.filter(v => !v.id_servicio);

  // Lo que debería quedar pendiente una vez descontado lo ya materializado.
  const deberian = teoricasFaltantes(teoricas, conServicio.map(v => ({
    id_ascensor: v.id_ascensor, numero_mes: v.numero_mes, fecha: ymdDeFecha(v.fecha_programada)
  })));

  const cupo = new Map();          // (ascensor|mes) → cuántas pendientes caben
  const fechasTeoricas = new Set(); // (ascensor|fecha) de la serie teórica
  for (const t of deberian) cupo.set(`${t.id_ascensor}|${t.numero_mes}`, (cupo.get(`${t.id_ascensor}|${t.numero_mes}`) || 0) + 1);
  for (const t of teoricas) fechasTeoricas.add(`${t.id_ascensor}|${t.fecha}`);

  const porGrupo = new Map();
  for (const v of pendientes) {
    const k = `${v.id_ascensor}|${v.numero_mes}`;
    if (!porGrupo.has(k)) porGrupo.set(k, []);
    porGrupo.get(k).push(v);
  }

  const sobrantes = [];
  for (const [k, lista] of porGrupo) {
    // Se conservan primero las que están en una fecha de la serie teórica.
    const orden = [...lista].sort((a, b) => {
      const ta = fechasTeoricas.has(`${a.id_ascensor}|${ymdDeFecha(a.fecha_programada)}`) ? 0 : 1;
      const tb = fechasTeoricas.has(`${b.id_ascensor}|${ymdDeFecha(b.fecha_programada)}`) ? 0 : 1;
      return ta - tb || (a.fecha_programada - b.fecha_programada);
    });
    sobrantes.push(...orden.slice(cupo.get(k) || 0));
  }
  return { sobrantes, teoricas: teoricas.length, activas: activas.length };
}

(async () => {
  const planes = await prisma.tbl_mantenimientos_planes.findMany({
    where: {
      estado: 1,
      tipo_plan: { not: 'eventual' },
      ...(SOLO_PLAN ? { id: SOLO_PLAN } : {})
    },
    include: {
      cliente: { select: { nombre: true } },
      ascensores: { where: { estado: 1 } }
    },
    orderBy: { id: 'asc' }
  });

  let planesTocados = 0;
  let visitasBorradas = 0;
  let eventosBorrados = 0;

  for (const plan of planes) {
    if (plan.ascensores.length === 0) continue;

    const visitas = await prisma.tbl_mantenimientos_programacion.findMany({
      where: { id_plan: plan.id, estado: 1 },
      select: {
        id: true, id_ascensor: true, numero_mes: true, fecha_programada: true,
        activo: true, id_servicio: true, id_evento: true
      }
    });

    const { sobrantes, teoricas, activas } = visitasSobrantes(plan, visitas);
    if (sobrantes.length === 0) continue;

    planesTocados++;
    console.log(`\nplan #${plan.id} · ${plan.cliente?.nombre?.slice(0, 45) || '—'} · inicio ${ymdDeFecha(plan.fecha_inicio)} · ${plan.duracion_meses} mes(es)`);
    console.log(`   contratadas ${teoricas} · en cronograma ${activas} · sobran ${sobrantes.length}`);
    for (const v of sobrantes) {
      console.log(`   ✕ mes ${String(v.numero_mes).padStart(2)} · ${ymdDeFecha(v.fecha_programada)} (visita ${v.id}, sin servicio)`);
    }

    if (!APLICAR) continue;

    const ids = sobrantes.map(v => v.id);
    const idsEvento = sobrantes.map(v => v.id_evento).filter(Boolean);
    await prisma.$transaction(async (tx) => {
      await tx.tbl_mantenimientos_programacion.deleteMany({ where: { id: { in: ids } } });
      if (idsEvento.length > 0) {
        // Solo eventos sin servicio: los del calendario que ya materializaron un
        // mantenimiento no se tocan nunca.
        const borrados = await tx.tbl_calendario_eventos.deleteMany({
          where: { id: { in: idsEvento }, id_servicio: null }
        });
        eventosBorrados += borrados.count;
      }
      const total = await tx.tbl_mantenimientos_programacion.count({
        where: { id_plan: plan.id, estado: 1 }
      });
      await tx.tbl_mantenimientos_planes.update({
        where: { id: plan.id },
        data: { cantidad_mantenimientos: total, date_time_modification: new Date() }
      });
    });
    visitasBorradas += ids.length;
  }

  console.log(`\n${prefijo}--- SANEAMIENTO DE VISITAS DUPLICADAS ---`);
  console.log(`Planes revisados          : ${planes.length}`);
  console.log(`Planes con visitas de más : ${planesTocados}`);
  console.log(`Visitas ${APLICAR ? 'eliminadas' : 'a eliminar '}       : ${APLICAR ? visitasBorradas : 'ver detalle arriba'}`);
  if (APLICAR) console.log(`Eventos de calendario     : ${eventosBorrados}`);
  if (!APLICAR) console.log('\nNada se modificó. Ejecute con --aplicar para escribir los cambios.');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FALLO:', e);
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * SANEAMIENTO posterior al backfill del cronograma mensual.
 *
 * Corrige dos residuos que deja el modelo anterior de planes:
 *
 *  1. EVENTOS COMPARTIDOS. Antes de "un servicio por ascensor" existían
 *     servicios de plan que cubrían VARIOS ascensores a la vez, con un único
 *     evento de calendario. Al reconstruir el cronograma, las visitas de esos
 *     ascensores quedan correctamente enganchadas al mismo servicio (ese
 *     servicio sí atendió a todos), pero no pueden compartir el evento: la
 *     cancelación de una visita arrastraría el evento de las otras. Se conserva
 *     el evento en la primera visita y se desvincula (id_evento = NULL) de las
 *     demás, que mantienen su servicio.
 *
 *  2. EVENTOS FANTASMA. El generador anterior encadenaba cada fecha a partir de
 *     la anterior, así que al pasar por un mes corto (28/29 días) el día se
 *     "pegaba" y arrastraba el desfase al resto de la serie (30 → 28 → 28…).
 *     El generador nuevo calcula cada fecha desde la de inicio, sin arrastre.
 *     Los eventos viejos con fecha desfasada no corresponden a ninguna visita
 *     del cronograma: son programación inexistente y se cancelan.
 *     Solo se tocan eventos SIN servicio: nada ya ejecutado se ve afectado.
 *
 * Uso:
 *   node scripts/sanearCalendarioPlanes.js            (aplica)
 *   node scripts/sanearCalendarioPlanes.js --dry-run  (solo informa)
 */
const prisma = require('../config/prisma');
const { ESTADO_EVENTO_CANCELADO } = require('../utils/estadoEvento');

const DRY = process.argv.includes('--dry-run');

(async () => {
  // ---------------------------------------------------------------
  // 1. Eventos compartidos por varias visitas
  // ---------------------------------------------------------------
  const compartidos = await prisma.$queryRawUnsafe(`
    SELECT id_evento, array_agg(id ORDER BY id) AS visitas
      FROM tbl_mantenimientos_programacion
     WHERE id_evento IS NOT NULL
     GROUP BY id_evento HAVING COUNT(*) > 1`);

  let desvinculadas = 0;
  for (const c of compartidos) {
    const secundarias = c.visitas.slice(1).map(Number);
    if (secundarias.length === 0) continue;
    if (!DRY) {
      await prisma.tbl_mantenimientos_programacion.updateMany({
        where: { id: { in: secundarias } },
        data: { id_evento: null }
      });
    }
    desvinculadas += secundarias.length;
  }

  // ---------------------------------------------------------------
  // 2. Eventos de plan sin servicio y fuera del cronograma
  // ---------------------------------------------------------------
  const fantasma = await prisma.$queryRawUnsafe(`
    SELECT e.id, e.id_mantenimiento_plan AS plan, e.fecha_inicio, e.titulo
      FROM tbl_calendario_eventos e
      JOIN tbl_mantenimientos_planes p ON p.id = e.id_mantenimiento_plan
     WHERE e.estado = 1
       AND e.id_servicio IS NULL
       AND EXISTS (SELECT 1 FROM tbl_mantenimientos_programacion pr WHERE pr.id_plan = p.id)
       AND NOT EXISTS (SELECT 1 FROM tbl_mantenimientos_programacion pr WHERE pr.id_evento = e.id)
     ORDER BY e.id`);

  if (!DRY && fantasma.length > 0) {
    await prisma.tbl_calendario_eventos.updateMany({
      where: { id: { in: fantasma.map(f => Number(f.id)) } },
      data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, date_time_modification: new Date() }
    });
  }

  console.log(`${DRY ? '[DRY-RUN] ' : ''}--- SANEAMIENTO ---`);
  console.log(`Eventos compartidos       : ${compartidos.length}`);
  console.log(`  ↳ visitas desvinculadas : ${desvinculadas}`);
  console.log(`Eventos fantasma          : ${fantasma.length}`);
  for (const f of fantasma.slice(0, 20)) {
    console.log(`  - evento ${f.id} · plan ${f.plan} · ${new Date(f.fecha_inicio).toISOString().slice(0, 10)} · ${f.titulo}`);
  }
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FALLO:', e);
  await prisma.$disconnect();
  process.exit(1);
});

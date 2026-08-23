const prisma = require('../../config/prisma');
(async () => {
  const q = s => prisma.$queryRawUnsafe(s);
  console.log('=== COBROS EN 0 (activos) ===');
  console.table(await q(`
    SELECT
      COUNT(*) FILTER (WHERE monto_total = 0) AS en_cero,
      COUNT(*) FILTER (WHERE monto_total > 0) AS con_monto,
      COUNT(*) AS total
    FROM tbl_cobros WHERE estado = 1`));

  console.log('=== ORIGEN DE LOS COBROS EN 0 ===');
  console.table(await q(`
    SELECT
      CASE WHEN c.id_mantenimiento_plan IS NOT NULL THEN 'plan de mantenimiento'
           WHEN s.origen IS NOT NULL THEN 'servicio: ' || s.origen
           ELSE 'sin servicio ni plan' END AS origen,
      COUNT(*) n,
      COUNT(*) FILTER (WHERE c.numero_cuotas = 0) sin_cuotas
    FROM tbl_cobros c
    LEFT JOIN tbl_servicios_proyectos s ON s.id = c.id_servicio
    WHERE c.estado = 1 AND c.monto_total = 0
    GROUP BY 1 ORDER BY 2 DESC`));

  console.log('=== MUESTRA de cobros en 0 por servicio de mantenimiento ===');
  console.table(await q(`
    SELECT c.id, c.id_servicio, s.codigo, s.origen, s.id_mantenimiento_plan AS plan,
           s.precio_interno, s.sin_cobro, s.estado_servicio, c.estado_cobro
    FROM tbl_cobros c JOIN tbl_servicios_proyectos s ON s.id = c.id_servicio
    WHERE c.estado = 1 AND c.monto_total = 0
    ORDER BY c.id DESC LIMIT 12`));
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });

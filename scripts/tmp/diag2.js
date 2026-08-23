const prisma = require('../../config/prisma');
(async () => {
  const q = s => prisma.$queryRawUnsafe(s);
  console.log('=== PLANES ACTIVOS: ¿tienen cobro de plan? ===');
  console.table(await q(`
    SELECT
      CASE WHEN c.id IS NULL THEN 'SIN cobro de plan' ELSE 'con cobro de plan' END AS situacion,
      COUNT(*) planes,
      COALESCE(SUM(p.monto_mensual * GREATEST(0, COALESCE(p.duracion_meses,0) - LEAST(p.cantidad_mantenimientos_gratuitos, COALESCE(p.duracion_meses,0)))), 0) AS valor_contratos
    FROM tbl_mantenimientos_planes p
    LEFT JOIN tbl_cobros c ON c.id_mantenimiento_plan = p.id AND c.estado = 1
    WHERE p.estado = 1 GROUP BY 1`));

  console.log('=== ¿Cómo se cobran hoy los planes migrados? (cobros por servicio de plan) ===');
  console.table(await q(`
    SELECT COUNT(*) cobros_por_servicio_de_plan,
           SUM(c.monto_total) monto,
           COUNT(*) FILTER (WHERE c.saldo_pendiente > 0) abiertos
    FROM tbl_cobros c JOIN tbl_servicios_proyectos s ON s.id = c.id_servicio
    WHERE c.estado = 1 AND s.id_mantenimiento_plan IS NOT NULL`));

  console.log('=== Los 2 cobros de plan vacíos ===');
  console.table(await q(`
    SELECT c.id AS cobro, p.id AS plan, p.duracion_meses AS meses, p.monto_mensual AS mensual,
           p.cantidad_mantenimientos_gratuitos AS gratis, c.monto_total, c.numero_cuotas,
           (SELECT COUNT(*) FROM tbl_mantenimientos_programacion pr WHERE pr.id_plan = p.id AND pr.estado=1) AS visitas
    FROM tbl_cobros c JOIN tbl_mantenimientos_planes p ON p.id = c.id_mantenimiento_plan
    WHERE c.estado = 1`));
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });

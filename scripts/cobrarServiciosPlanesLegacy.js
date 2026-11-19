/**
 * SANEAMIENTO — mantenimientos de planes LEGACY que quedaron sin cobro.
 *
 * Los planes creados antes del cobro único por plan (jun–jul 2026) cobran y
 * facturan POR SERVICIO: cada mantenimiento lleva su propio cobro. Desde el
 * modelo mensual, serviciosController.finalizar dejó de crearle cobro a TODO
 * servicio de plan, también a los de estos planes, que no tienen cuota de mes
 * que facturar: esos mantenimientos quedaron sin ninguna vía de cobro ni de
 * factura (Contabilidad ofrecía «Facturar mes» con la bandeja vacía).
 *
 * Desde el arreglo, finalizar les crea el cobro propio
 * (utils/cobroServicioPlanLegacy.js). Este script lo crea para lo cerrado
 * ANTES, con la misma regla de importe: el precio del servicio o, si nació en
 * 0, lo que cobró por servicio el último mantenimiento del plan.
 *
 * Fuera de alcance: servicios gratuitos (sin_cobro = 1), cancelados, no
 * realizados, los que ya tienen fila de cobro (aunque esté dada de baja) y los
 * de planes con monto mensual 0 sin precio propio.
 *
 * Es IDEMPOTENTE: un servicio que ya tiene cobro no vuelve a tocarse.
 *
 * Uso:
 *   node scripts/cobrarServiciosPlanesLegacy.js             (solo informa)
 *   node scripts/cobrarServiciosPlanesLegacy.js --aplicar   (crea los cobros)
 */
const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { sincronizarRecordatorioFacturarServicio } = require('../utils/recordatoriosAuto');
const {
  planFacturaPorMes,
  montoCobroServicioPlanLegacy,
  crearCobroServicioPlanLegacy
} = require('../utils/cobroServicioPlanLegacy');

const APLICAR = process.argv.includes('--aplicar');

(async () => {
  const candidatos = await prisma.tbl_servicios_proyectos.findMany({
    where: {
      id_mantenimiento_plan: { not: null },
      estado: 1,
      estado_servicio: { not: 'Cancelado' },
      sin_cobro: { not: 1 },
      servicio_realizado: { isNot: null },
      cobro: { is: null },
      mantenimiento_plan: { is: { estado: 1 } }
    },
    orderBy: [{ id_mantenimiento_plan: 'asc' }, { fecha_programada: 'asc' }, { id: 'asc' }],
    include: {
      mantenimiento_plan: { select: { id: true, estado_plan: true, monto_mensual: true } },
      servicio_realizado: { select: { estado_administrativo: true, estado_cobro: true } }
    }
  });

  const legacy = [];
  const cachePlan = new Map();
  for (const s of candidatos) {
    const idPlan = s.id_mantenimiento_plan;
    if (!cachePlan.has(idPlan)) cachePlan.set(idPlan, await planFacturaPorMes(prisma, idPlan));
    if (!cachePlan.get(idPlan)) legacy.push(s);
  }

  let creados = 0;
  let total = 0;
  const omitidos = [];
  for (const s of legacy) {
    const monto = await montoCobroServicioPlanLegacy(prisma, s);
    const fila = [
      `plan #${s.id_mantenimiento_plan} (${s.mantenimiento_plan.estado_plan})`,
      s.codigo,
      String(s.fecha_programada?.toISOString?.() || '').slice(0, 10),
      s.estado_servicio,
      s.servicio_realizado?.estado_administrativo,
      `precio ${Number(s.precio_interno)}`,
      `→ cobro ${s.moneda} ${monto}`
    ].join(' · ');
    if (monto <= 0) {
      omitidos.push(`${fila} (sin importe: no se crea)`);
      continue;
    }
    console.log(`${APLICAR ? 'CREA' : 'CREARÍA'}  ${fila}`);
    total += monto;
    if (!APLICAR) continue;

    const cobro = await prisma.$transaction(async (tx) => {
      // Re-chequeo dentro de la transacción (idempotencia ante una carrera).
      const ya = await tx.tbl_cobros.findUnique({ where: { id_servicio: s.id }, select: { id: true } });
      if (ya) return null;
      const nuevo = await crearCobroServicioPlanLegacy(tx, s, monto, null);
      await tx.tbl_servicios_realizados.updateMany({
        where: { id_servicio: s.id },
        data: { estado_cobro: nuevo.estado_cobro, date_time_modification: new Date() }
      });
      return nuevo;
    });
    if (!cobro) continue;
    creados += 1;
    await registrarAuditoria({
      id_usuario: null, entidad: 'tbl_cobros', id_entidad: cobro.id, accion: 'CREATE',
      valor_nuevo: { ...cobro, origen: 'scripts/cobrarServiciosPlanesLegacy.js', id_servicio: s.id, codigo: s.codigo }
    });
    await sincronizarRecordatorioFacturarServicio(s.id).catch(err => console.error(`  alerta facturar ${s.codigo}:`, err.message));
  }

  if (omitidos.length) {
    console.log('\nOmitidos:');
    for (const o of omitidos) console.log(`  ${o}`);
  }
  const resumen = APLICAR
    ? `${creados} cobro(s) creado(s)`
    : `${legacy.length - omitidos.length} cobro(s) por crear (simulación: sin cambios; use --aplicar)`;
  console.log(`\n${candidatos.length} candidato(s) · ${legacy.length} de planes legacy · ${resumen} · total ${total.toFixed(2)}`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

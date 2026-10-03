/**
 * REESCALADO — monto mensual de los planes cuyo importe calculó el sistema.
 *
 * Desde la regla «solo se cobran los meses con mantenimiento» (ver
 * utils/planMantenimientoMensual.totalesDelPlan), el `monto_mensual` es el
 * precio de un mes CON mantenimiento: trimestral × 12 meses a S/ 200 = S/ 800.
 *
 * Pero hay planes cuyo monto mensual no lo escribió nadie: lo derivó el sistema
 * repartiendo el total del contrato entre TODOS los meses —
 *   - la migración 20260823120000_plan_mantenimiento_mensual (planes creados
 *     antes del 23/08/2026): «trimestral de 300 a 12 meses pasa a 100/mes»;
 *   - la conversión de una cotización/servicio en plan (observaciones
 *     «Generada por …»), hasta este cambio.
 * Con la regla nueva esos planes cobrarían de menos (un trimestral, un tercio).
 * Este script les recalcula el monto para que conserven su total contratado:
 *
 *     nuevo monto = total anterior / meses que ahora se cobran
 *
 * NO toca: planes cuyos meses cobrables no cambian (mensuales, quincenales…),
 * planes cuyo monto se editó a mano después de crearse (lo dice la auditoría:
 * ese importe ya lo eligió una persona) ni las cuotas ya aprobadas, que
 * conservan su importe.
 *
 * Redondeo: el monto derivado arrastra el redondeo de la división original
 * (800 / 6 = 133.33 → 133.33 × 6 = 799.98). Si el entero más cercano
 * reproduce el total anterior dentro de ese error, se usa el entero (400, no
 * 399.99).
 *
 * Uso (por defecto SOLO informa; no escribe nada):
 *   node scripts/reescalarMontoPlanesDerivados.js
 *   node scripts/reescalarMontoPlanesDerivados.js --aplicar
 */
const prisma = require('../config/prisma');
const { mesesDelPlan, round2 } = require('../utils/planMantenimientoMensual');
const { registrarAuditoria } = require('../utils/auditoria');

const APLICAR = process.argv.includes('--aplicar');
// Inicio del modelo mensual (migración 20260823120000), medianoche de Lima.
const INICIO_MODELO_MENSUAL = new Date('2026-08-23T05:00:00.000Z');

function montoDerivadoPorSistema(plan) {
  if (plan.date_time_registration && plan.date_time_registration < INICIO_MODELO_MENSUAL) return true;
  return String(plan.observaciones || '').startsWith('Generada por');
}

// ¿Alguien cambió el monto mensual después de crear el plan?
function montoEditadoAMano(auditorias) {
  return auditorias.some(a => {
    const antes = a.valor_anterior?.monto_mensual;
    const despues = a.valor_nuevo?.monto_mensual;
    return antes != null && despues != null && round2(antes) !== round2(despues);
  });
}

function nuevoMonto(totalAnterior, mesesAnteriores, mesesNuevos) {
  const exacto = round2(totalAnterior / mesesNuevos);
  const entero = Math.round(exacto);
  // Error máximo heredado: hasta medio céntimo por cada mes del reparto original.
  const tolerancia = 0.005 * mesesAnteriores + 0.005;
  return Math.abs(entero * mesesNuevos - totalAnterior) <= tolerancia ? entero : exacto;
}

async function main() {
  const planes = await prisma.tbl_mantenimientos_planes.findMany({
    where: { estado: 1, tipo_plan: 'continuo' },
    select: {
      id: true, monto_mensual: true, moneda: true, duracion_meses: true,
      cantidad_mantenimientos_gratuitos: true, observaciones: true, date_time_registration: true,
      cliente: { select: { nombre: true } }
    },
    orderBy: { id: 'asc' }
  });

  const cambios = [];
  const omitidos = { editados_a_mano: [], sin_meses_cobrables: [] };
  for (const plan of planes) {
    if (!montoDerivadoPorSistema(plan) || Number(plan.monto_mensual || 0) <= 0) continue;
    const meses = Number(plan.duracion_meses || 0);
    const gratuitos = Math.min(Number(plan.cantidad_mantenimientos_gratuitos || 0), meses);
    const mesesAnteriores = Math.max(0, meses - gratuitos);
    const info = await mesesDelPlan(prisma, plan.id);
    const mesesNuevos = info.totales.meses_facturables;
    if (mesesNuevos === mesesAnteriores) continue;
    if (mesesNuevos === 0) { omitidos.sin_meses_cobrables.push(plan.id); continue; }

    const auditorias = await prisma.tbl_auditoria.findMany({
      where: { entidad: 'tbl_mantenimientos_planes', id_entidad: plan.id },
      select: { valor_anterior: true, valor_nuevo: true }
    });
    if (montoEditadoAMano(auditorias)) { omitidos.editados_a_mano.push(plan.id); continue; }

    const totalAnterior = round2(Number(plan.monto_mensual) * mesesAnteriores);
    const monto = nuevoMonto(totalAnterior, mesesAnteriores, mesesNuevos);
    cambios.push({
      id: plan.id,
      cliente: plan.cliente?.nombre || '',
      moneda: plan.moneda,
      monto_anterior: Number(plan.monto_mensual),
      meses_cobrados_antes: mesesAnteriores,
      total_anterior: totalAnterior,
      monto_nuevo: monto,
      meses_cobrados_ahora: mesesNuevos,
      total_nuevo: round2(monto * mesesNuevos),
      cuotas_aprobadas: info.meses.filter(m => m.cuota).length
    });
  }

  console.table(cambios.map(c => ({
    plan: c.id, cliente: c.cliente.slice(0, 32),
    'monto antes': c.monto_anterior, 'meses antes': c.meses_cobrados_antes, 'total antes': c.total_anterior,
    'monto nuevo': c.monto_nuevo, 'meses ahora': c.meses_cobrados_ahora, 'total nuevo': c.total_nuevo,
    'cuotas ya aprobadas': c.cuotas_aprobadas
  })));
  console.log(`Planes a reescalar: ${cambios.length}`);
  console.log(`Omitidos por monto editado a mano: ${omitidos.editados_a_mano.length}${omitidos.editados_a_mano.length ? ` (${omitidos.editados_a_mano.join(', ')})` : ''}`);
  console.log(`Omitidos sin meses cobrables: ${omitidos.sin_meses_cobrables.length}${omitidos.sin_meses_cobrables.length ? ` (${omitidos.sin_meses_cobrables.join(', ')})` : ''}`);

  if (!APLICAR) {
    console.log('\nSimulación: no se escribió nada. Para aplicar: --aplicar');
    return;
  }
  for (const c of cambios) {
    await prisma.tbl_mantenimientos_planes.update({
      where: { id: c.id },
      data: { monto_mensual: c.monto_nuevo, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: null, entidad: 'tbl_mantenimientos_planes', id_entidad: c.id,
      accion: 'REESCALADO_MONTO_MENSUAL',
      valor_anterior: { monto_mensual: c.monto_anterior, total: c.total_anterior, meses_cobrados: c.meses_cobrados_antes },
      valor_nuevo: { monto_mensual: c.monto_nuevo, total: c.total_nuevo, meses_cobrados: c.meses_cobrados_ahora },
      ip: 'script'
    });
  }
  console.log(`\nAplicado: ${cambios.length} plan(es) reescalado(s).`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

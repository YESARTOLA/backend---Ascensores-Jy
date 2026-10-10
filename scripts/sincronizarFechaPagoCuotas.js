/**
 * SANEAMIENTO — fecha de pago de las cuotas.
 *
 * Hasta el 08/10/2026 registrarPago guardaba como fecha de pago de la cuota el
 * DÍA EN QUE SE CARGÓ el abono, no la fecha real de cobro que se ingresa en el
 * abono: un abono del 09/09 registrado el 07/10 dejaba la cuota "pagada el
 * 07/10". Lo mismo pasó, en versiones anteriores, con el "último abono" del
 * cobro.
 *
 * Este script realinea ambas fechas con las de los abonos usando la regla única
 * de utils/fechaPagoCuotas.js (la cuota toma la fecha más reciente de los abonos
 * que la cubren). Es IDEMPOTENTE: lo que ya coincide no se toca. Al abrir un
 * cobro en la app se aplica la misma corrección para ese cobro.
 *
 * Uso (por defecto SOLO informa; no escribe nada):
 *   node scripts/sincronizarFechaPagoCuotas.js
 *   node scripts/sincronizarFechaPagoCuotas.js --aplicar
 */
const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { sincronizarFechasPagoCuotas } = require('../utils/fechaPagoCuotas');

const APLICAR = process.argv.includes('--aplicar');
const ddmm = (ymd) => (ymd ? ymd.split('-').reverse().join('/') : '—');

async function main() {
  const cobros = await prisma.tbl_cobros.findMany({
    where: { estado: 1, pagos: { some: { estado: 1 } } },
    select: { id: true, servicio: { select: { codigo: true } } },
    orderBy: { id: 'asc' }
  });

  let cuotasCambiadas = 0, cobrosCambiados = 0;
  for (const c of cobros) {
    const cambios = APLICAR
      ? await prisma.$transaction(tx => sincronizarFechasPagoCuotas(tx, c.id, null))
      : await sincronizarFechasPagoCuotas(prisma, c.id, null, { simular: true });
    if (cambios.cuotas.length === 0 && !cambios.ultimoAbono) continue;

    cobrosCambiados++;
    cuotasCambiadas += cambios.cuotas.length;
    console.log(`Cobro #${c.id} ${c.servicio?.codigo || ''}`.trim());
    for (const cu of cambios.cuotas) {
      console.log(`  cuota ${cu.numero_cuota}: fecha pago ${ddmm(cu.antes)} → ${ddmm(cu.despues)}`);
    }
    if (cambios.ultimoAbono) {
      console.log(`  último abono: ${ddmm(cambios.ultimoAbono.antes)} → ${ddmm(cambios.ultimoAbono.despues)}`);
    }
    if (APLICAR) {
      await registrarAuditoria({
        id_usuario: null, entidad: 'tbl_cobros', id_entidad: c.id,
        accion: 'SINCRONIZAR_FECHA_PAGO_CUOTAS', valor_nuevo: cambios, ip: 'script'
      });
    }
  }

  console.log(`\nCobros con abonos revisados: ${cobros.length}`);
  console.log(`Cobros a corregir: ${cobrosCambiados} · cuotas: ${cuotasCambiadas}`);
  if (!APLICAR) console.log('\nSimulación: no se escribió nada. Para aplicar: --aplicar');
  else console.log('\nAplicado.');
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

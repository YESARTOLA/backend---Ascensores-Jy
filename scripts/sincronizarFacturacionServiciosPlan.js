/**
 * SANEAMIENTO — estado de factura y de cobro de los mantenimientos de PLAN.
 *
 * Los mantenimientos de un plan no tienen factura ni cobro propios: les
 * corresponden los de la cuota de SU MES en el cobro único del plan. Antes no
 * se sincronizaban: al facturar o pagar un mes, Contabilidad seguía mostrando
 * esos mantenimientos "Sin factura" / "Sin cobro", con el botón "Facturar mes",
 * y no entraban en la tarjeta ni en los filtros "Facturado" / "Situación".
 *
 * Desde el arreglo, cada movimiento del plan (aprobar o revertir un mes,
 * factura, abono, cierre) los sincroniza (utils/facturacionServiciosPlan.js).
 * Este script alinea lo ocurrido ANTES del arreglo, con la misma regla.
 *
 * Es IDEMPOTENTE: lo que ya está alineado no se toca.
 *
 * Uso:
 *   node scripts/sincronizarFacturacionServiciosPlan.js            (aplica)
 *   node scripts/sincronizarFacturacionServiciosPlan.js --dry-run  (solo informa)
 */
const prisma = require('../config/prisma');
const {
  facturacionDeServiciosPlan,
  sincronizarFacturacionServiciosPlan
} = require('../utils/facturacionServiciosPlan');

const DRY = process.argv.includes('--dry-run');

(async () => {
  // Planes con mantenimientos realizados y cobro de plan activo: los únicos en
  // los que la regla aplica.
  const planes = await prisma.tbl_mantenimientos_planes.findMany({
    where: {
      cobro: { is: { estado: 1 } },
      servicios_generados: { some: { servicio_realizado: { isNot: null } } }
    },
    select: { id: true },
    orderBy: { id: 'asc' }
  });

  let totalCambios = 0;
  for (const { id } of planes) {
    const realizados = await prisma.tbl_servicios_realizados.findMany({
      where: { servicio: { is: { id_mantenimiento_plan: id } } },
      select: { id_servicio: true, estado_facturacion: true, estado_cobro: true, servicio: { select: { codigo: true } } }
    });
    const situacion = await facturacionDeServiciosPlan(prisma, realizados.map(r => r.id_servicio));
    const cambios = realizados
      .map(r => ({ r, info: situacion.get(r.id_servicio) }))
      .filter(({ r, info }) => info && (info.estado_facturacion !== r.estado_facturacion || info.estado_cobro !== r.estado_cobro));
    if (cambios.length === 0) continue;

    totalCambios += cambios.length;
    console.log(`Plan #${id}:`);
    for (const { r, info } of cambios) {
      const partes = [];
      if (info.estado_facturacion !== r.estado_facturacion) {
        partes.push(`factura: ${r.estado_facturacion} → ${info.estado_facturacion}${info.factura ? ` (${info.factura.numero_factura})` : ''}`);
      }
      if (info.estado_cobro !== r.estado_cobro) partes.push(`cobro: ${r.estado_cobro} → ${info.estado_cobro}`);
      console.log(`  ${r.servicio?.codigo || r.id_servicio} · mes ${info.numero_mes ?? '?'} · ${partes.join(' · ')}`);
    }
    if (!DRY) await sincronizarFacturacionServiciosPlan(prisma, id, null);
  }

  console.log(`\n${planes.length} plan(es) revisado(s) · ${totalCambios} servicio(s) ${DRY ? 'por corregir (dry-run, sin cambios)' : 'corregido(s)'}`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

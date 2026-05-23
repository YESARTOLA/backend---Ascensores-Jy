const prisma = require('../config/prisma');

(async () => {
  const conf = await prisma.tbl_configuracion.findMany({ orderBy: { clave: 'asc' } });
  console.log('=== Configuración cargada ===');
  for (const c of conf) {
    const v = c.valor.length > 60 ? c.valor.slice(0, 60) + '…' : c.valor;
    console.log(`  ${c.clave} = ${v}`);
  }
  const cots = await prisma.tbl_cotizaciones.count();
  const vers = await prisma.tbl_cotizaciones_versiones.count();
  const items = await prisma.tbl_cotizaciones_items.count();
  console.log(`\n=== Tablas ===\nCotizaciones: ${cots} | Versiones: ${vers} | Items: ${items}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

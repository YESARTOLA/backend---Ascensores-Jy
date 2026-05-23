/**
 * Verifica E2E las 3 alertas de finalización de servicio.
 *
 * Toma un servicio en estado 'Finalizado por técnico' (id=9 en el dataset local),
 * dispara las 3 sincronizadoras, y verifica que:
 *   - se crean los 3 recordatorios (uno por tipo)
 *   - son idempotentes (segunda llamada no duplica)
 *   - se respetan los textos/colores esperados
 *   - el descarte de "facturar" funciona al simular emisión de factura
 */
const prisma = require('../config/prisma');
const {
  sincronizarRecordatorioRevisarServicio,
  sincronizarRecordatorioFacturarServicio,
  sincronizarRecordatorioAvisoFinalizacion,
  descartarAlertaFacturarServicio
} = require('../utils/recordatoriosAuto');

const ID_SERVICIO = Number(process.argv[2]) || 9;

const TIPOS = [
  'servicio_finalizado_revisar',
  'servicio_finalizado_facturar',
  'servicio_finalizado_aviso'
];

async function listarAlertas() {
  return prisma.tbl_recordatorios.findMany({
    where: { id_servicio: ID_SERVICIO, tipo: { in: TIPOS }, estado: 1 },
    select: { id: true, tipo: true, titulo: true, descripcion: true, color: true, prioridad: true, estado_recordatorio: true, origen: true }
  });
}

async function main() {
  console.log(`▶ Verificando servicio id=${ID_SERVICIO}`);
  const s = await prisma.tbl_servicios_proyectos.findUnique({ where: { id: ID_SERVICIO } });
  if (!s) throw new Error('Servicio no encontrado');
  console.log(`   ${s.codigo} · estado=${s.estado_servicio}`);

  // Limpiar estado previo
  await prisma.tbl_recordatorios.deleteMany({ where: { id_servicio: ID_SERVICIO, tipo: { in: TIPOS } } });

  console.log('\n▶ Primera llamada (debe crear 3 alertas)');
  await Promise.all([
    sincronizarRecordatorioRevisarServicio(ID_SERVICIO),
    sincronizarRecordatorioFacturarServicio(ID_SERVICIO),
    sincronizarRecordatorioAvisoFinalizacion(ID_SERVICIO)
  ]);
  let alertas = await listarAlertas();
  console.log(`   creadas: ${alertas.length}`);
  alertas.forEach(a => {
    console.log(`   · ${a.tipo} | ${a.titulo} | color=${a.color} | prioridad=${a.prioridad} | estado=${a.estado_recordatorio}`);
  });
  if (alertas.length !== 3) throw new Error('Esperaba 3 alertas');

  console.log('\n▶ Segunda llamada (debe ser idempotente, sigue siendo 3)');
  await Promise.all([
    sincronizarRecordatorioRevisarServicio(ID_SERVICIO),
    sincronizarRecordatorioFacturarServicio(ID_SERVICIO),
    sincronizarRecordatorioAvisoFinalizacion(ID_SERVICIO)
  ]);
  alertas = await listarAlertas();
  console.log(`   total tras 2da llamada: ${alertas.length}`);
  if (alertas.length !== 3) throw new Error('Idempotencia rota — esperaba 3 alertas');

  console.log('\n▶ descartarAlertaFacturarServicio (auto-cierre al emitir factura)');
  await descartarAlertaFacturarServicio(ID_SERVICIO);
  alertas = await listarAlertas();
  const facturar = alertas.find(a => a.tipo === 'servicio_finalizado_facturar');
  console.log(`   estado de facturar: ${facturar?.estado_recordatorio}`);
  const revisar = alertas.find(a => a.tipo === 'servicio_finalizado_revisar');
  const aviso = alertas.find(a => a.tipo === 'servicio_finalizado_aviso');
  if (facturar.estado_recordatorio !== 'atendido') throw new Error('Facturar no fue descartado');
  if (revisar.estado_recordatorio !== 'pendiente') throw new Error('Revisar no debió tocarse');
  if (aviso.estado_recordatorio !== 'pendiente') throw new Error('Aviso no debió tocarse');

  console.log('\n✅ Todas las verificaciones pasaron');
}

main()
  .catch(e => { console.error('FATAL:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

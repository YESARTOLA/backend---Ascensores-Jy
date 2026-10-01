/**
 * SANEAMIENTO — estado global de las cotizaciones.
 *
 * El estado_global se deriva del servicio y de su cobro, pero se recalcula solo
 * cuando cambia el estado del servicio. Dos defectos dejaron cotizaciones
 * desalineadas que ningún evento posterior iba a corregir:
 *
 *  1. Al aprobarse la revisión administrativa el servicio pasaba SIEMPRE a
 *     'A gestión de cobro', aunque su cobro ya tuviera abonos o factura (un
 *     servicio de cotización es cobrable desde que se aprueba). Si el adelanto
 *     ya cubría todo, no llegaba otro abono que lo moviera y la cotización
 *     seguía "por cobrar" con el cobro saldado.
 *  2. El estado global no miraba el saldo del cobro, solo el del servicio.
 *
 * Este script:
 *  a) realinea los servicios de cotización que están en el circuito de cobro
 *     con lo que dicta su cobro, si ese cobro tuvo movimiento (abonos o
 *     factura) — misma regla que la revisión, los abonos y las facturas;
 *  b) recalcula el estado_global de todas las cotizaciones activas.
 *
 * Es IDEMPOTENTE: lo que ya está alineado no se toca.
 *
 * Uso:
 *   node scripts/resincronizarEstadoGlobalCotizaciones.js            (aplica)
 *   node scripts/resincronizarEstadoGlobalCotizaciones.js --dry-run  (solo informa)
 */
const prisma = require('../config/prisma');
const {
  cambiarEstadoServicio,
  estadoServicioPorMovimientoDeCobro,
  ESTADOS_SERVICIO_EN_COBRO
} = require('../utils/estadoServicio');
const { ESTADO_GLOBAL } = require('../utils/estadoCotizacion');
const { sincronizarEstadoGlobal, calcularEstadoGlobal } = require('../controllers/cotizacionesController');

const DRY = process.argv.includes('--dry-run');
const USER_SISTEMA = null;

async function realinearServicios() {
  const servicios = await prisma.tbl_servicios_proyectos.findMany({
    where: {
      estado: 1,
      id_cotizacion: { not: null },
      estado_servicio: { in: ESTADOS_SERVICIO_EN_COBRO }
    },
    select: {
      id: true, codigo: true, estado_servicio: true,
      cobro: { select: { estado: true, estado_cobro: true, total_abonado: true, saldo_pendiente: true } },
      servicio_realizado: { select: { estado_facturacion: true } }
    },
    orderBy: { id: 'asc' }
  });

  const cambios = [];
  for (const s of servicios) {
    const destino = estadoServicioPorMovimientoDeCobro({
      cobro: s.cobro,
      estadoFacturacion: s.servicio_realizado?.estado_facturacion
    });
    if (!destino || destino === s.estado_servicio) continue;
    cambios.push({ codigo: s.codigo, de: s.estado_servicio, a: destino });
    if (!DRY) {
      await cambiarEstadoServicio(s.id, destino, USER_SISTEMA, 'Saneamiento: estado alineado con su cobro');
    }
  }
  return { revisados: servicios.length, cambios };
}

async function cotizacionesActivas() {
  return prisma.tbl_cotizaciones.findMany({
    where: { estado: 1, estado_global: { not: ESTADO_GLOBAL.ANULADO } },
    select: {
      id: true, codigo: true, estado_global: true,
      servicios: {
        where: { estado: 1 },
        take: 1,
        select: {
          estado_servicio: true, sin_cobro: true,
          cobro: { select: { estado: true, estado_cobro: true, saldo_pendiente: true } }
        }
      }
    },
    orderBy: { id: 'asc' }
  });
}

// `antes`: estado_global de cada cotización al arrancar el script. Al aplicar,
// el paso a) ya recalcula en segundo plano las cotizaciones de los servicios
// que realinea, así que el informe se arma contra esa foto inicial.
async function recalcularGlobales(antes) {
  const cotizaciones = await cotizacionesActivas();
  const cambios = [];
  for (const c of cotizaciones) {
    let destino;
    if (DRY) {
      // Mismo cálculo que sincronizarEstadoGlobal, sin escribir.
      const servicio = c.servicios[0] || null;
      const cobro = servicio?.cobro?.estado === 1 ? servicio.cobro : null;
      destino = calcularEstadoGlobal(servicio, cobro);
    } else {
      destino = await sincronizarEstadoGlobal(c.id);
    }
    const previo = antes.get(c.id) ?? c.estado_global;
    if (destino && destino !== previo) {
      cambios.push({ codigo: c.codigo, de: previo, a: destino });
    }
  }
  return { revisadas: cotizaciones.length, cambios };
}

function imprimir(titulo, cambios) {
  console.log(`\n${titulo}: ${cambios.length}`);
  for (const c of cambios) console.log(`  ${c.codigo}: ${c.de} → ${c.a}`);
}

async function main() {
  console.log(DRY ? '== DRY-RUN: no se escribe nada ==' : '== Aplicando cambios ==');
  const antes = new Map((await cotizacionesActivas()).map(c => [c.id, c.estado_global]));

  const srv = await realinearServicios();
  console.log(`Servicios de cotización en cobro revisados: ${srv.revisados}`);
  imprimir(DRY ? 'Servicios que se realinearían' : 'Servicios realineados', srv.cambios);

  // El paso a) no altera este cálculo: con el trabajo ya terminado, el global
  // depende del saldo del cobro y no del estado exacto del servicio.
  const glob = await recalcularGlobales(antes);
  console.log(`\nCotizaciones activas revisadas: ${glob.revisadas}`);
  imprimir(DRY ? 'Estados globales que cambiarían' : 'Estados globales corregidos', glob.cambios);

  // cambiarEstadoServicio dispara en segundo plano la sincronización de
  // recordatorios y emergencias: se les da margen antes de cerrar la conexión.
  if (!DRY && srv.cambios.length > 0) await new Promise(r => setTimeout(r, 3000));
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

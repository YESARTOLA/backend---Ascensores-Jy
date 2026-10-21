/**
 * SANEAMIENTO — estado de facturación agregado de los servicios.
 *
 * Desde el 20/10/2026 la facturación GENERAL de un servicio puede hacerse en
 * varias partes (una primera factura parcial y luego una segunda, tercera… por
 * lo que falte). Antes, una sola factura general —aunque fuera por menos del
 * total— dejaba el servicio como 'Facturado' y, con ello, su estado en
 * 'Facturado' / 'Cerrado'. Con la regla nueva (utils/estadoFactura.js,
 * calcularEstadoFacturacion con `total`) ese servicio es 'Parcialmente
 * facturado' hasta completar el total.
 *
 * El estado guardado solo se recalcula cuando cambia alguna factura, así que
 * los servicios facturados en parte ANTES del cambio quedan desalineados hasta
 * que se les registre otra. Este script:
 *  a) recalcula estado_facturacion de todo servicio con facturas PROPIAS
 *     vigentes (las facturas de plan, sin servicio, no entran: a los
 *     mantenimientos de plan los sincroniza sincronizarFacturacionServiciosPlan.js);
 *  b) realinea el estado del servicio con su cobro si está en el circuito de
 *     cobro — la misma regla que se aplica al registrar o anular una factura.
 *
 * Es IDEMPOTENTE: lo que ya está alineado no se toca.
 *
 * Uso:
 *   node scripts/resincronizarEstadoFacturacion.js            (aplica)
 *   node scripts/resincronizarEstadoFacturacion.js --dry-run  (solo informa)
 */
const prisma = require('../config/prisma');
const { calcularEstadoFacturacion, ESTADO_FACTURA_ANULADA } = require('../utils/estadoFactura');
const {
  cambiarEstadoServicio,
  estadoServicioPorMovimientoDeCobro,
  ESTADOS_SERVICIO_EN_COBRO
} = require('../utils/estadoServicio');

const DRY = process.argv.includes('--dry-run');
const USER_SISTEMA = null;

function imprimir(titulo, cambios) {
  console.log(`\n${titulo}: ${cambios.length}`);
  for (const c of cambios) console.log(`  ${c.codigo}: ${c.de} → ${c.a}`);
}

async function main() {
  console.log(DRY ? '== DRY-RUN: no se escribe nada ==' : '== Aplicando cambios ==');

  const servicios = await prisma.tbl_servicios_proyectos.findMany({
    where: {
      estado: 1,
      facturas: { some: { estado: 1, estado_factura: { not: ESTADO_FACTURA_ANULADA } } },
      servicio_realizado: { isNot: null }
    },
    select: {
      id: true, codigo: true, precio_interno: true, estado_servicio: true,
      // Mismos datos que facturasController.recomputarEstadoFacturacionServicio.
      facturas: { where: { estado: 1 }, select: { id: true, id_cuota: true, monto: true, estado: true, estado_factura: true } },
      cobro: {
        select: {
          estado: true, estado_cobro: true, monto_total: true, total_abonado: true, saldo_pendiente: true,
          cuotas: { where: { estado: 1 }, select: { id: true, estado: true } }
        }
      },
      servicio_realizado: { select: { estado_facturacion: true } }
    },
    orderBy: { id: 'asc' }
  });

  const cambiosFacturacion = [];
  const cambiosServicio = [];
  for (const s of servicios) {
    // a) estado_facturacion agregado.
    const destino = calcularEstadoFacturacion({
      facturas: s.facturas,
      cuotas: s.cobro?.cuotas || [],
      total: Number(s.cobro?.monto_total ?? s.precio_interno ?? 0)
    });
    const previo = s.servicio_realizado?.estado_facturacion;
    if (destino !== previo) {
      cambiosFacturacion.push({ codigo: s.codigo, de: previo, a: destino });
      if (!DRY) {
        await prisma.tbl_servicios_realizados.updateMany({
          where: { id_servicio: s.id },
          data: { estado_facturacion: destino, date_time_modification: new Date() }
        });
      }
    }
    // b) estado del servicio, si lo dicta el cobro.
    if (!ESTADOS_SERVICIO_EN_COBRO.includes(s.estado_servicio)) continue;
    const destinoServicio = estadoServicioPorMovimientoDeCobro({ cobro: s.cobro, estadoFacturacion: destino });
    if (!destinoServicio || destinoServicio === s.estado_servicio) continue;
    cambiosServicio.push({ codigo: s.codigo, de: s.estado_servicio, a: destinoServicio });
    if (!DRY) {
      await cambiarEstadoServicio(s.id, destinoServicio, USER_SISTEMA, 'Saneamiento: estado alineado con su facturación');
    }
  }

  console.log(`Servicios con facturas propias vigentes revisados: ${servicios.length}`);
  imprimir(DRY ? 'Estados de facturación que cambiarían' : 'Estados de facturación corregidos', cambiosFacturacion);
  imprimir(DRY ? 'Servicios que se realinearían' : 'Servicios realineados', cambiosServicio);

  // cambiarEstadoServicio dispara en segundo plano la sincronización de
  // recordatorios y emergencias: se les da margen antes de cerrar la conexión.
  if (!DRY && cambiosServicio.length > 0) await new Promise(r => setTimeout(r, 3000));
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

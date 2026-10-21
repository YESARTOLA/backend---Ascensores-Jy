/**
 * IMPORTES de facturación de un servicio realizado: cuánto YA SE FACTURÓ y
 * cuánto FALTA FACTURAR. Es la regla única de Contabilidad para:
 *   · las columnas "Facturado" / "Por facturar" de cada fila;
 *   · las tarjetas "Por facturar" / "Facturado" (cantidad e importe);
 *   · los botones de filtro homónimos (qué servicios deja en la tabla).
 * Las tres cosas salen de `situacionFacturacion`, así que no pueden divergir.
 *
 * Un servicio facturado EN PARTE (p. ej. cuota 1 facturada, cuota 2 no) está en
 * los DOS grupos: en "Facturado" por lo ya emitido y en "Por facturar" por su
 * saldo. Nunca por su total.
 *
 * Lo que queda por facturar es lo que el sistema todavía permite emitir (mismas
 * reglas que facturasController.validarCoberturaFactura y que la bandeja
 * "Por facturar" de cuotas, cobrosController.cuotasNoFacturadas):
 *   · sin comprobantes → el total cobrable del servicio;
 *   · facturado por cuotas → las cuotas activas que aún no tienen factura;
 *   · facturado en general (comprobantes sin cuota, en una o varias emisiones)
 *     → el total cobrable menos lo ya emitido: una primera factura parcial se
 *     completa con una segunda, tercera… hasta cubrir el total.
 * Los mantenimientos de un PLAN (modelo mensual, sin cobro propio) facturan la
 * cuota de su MES (utils/facturacionServiciosPlan.js): lo facturado es la
 * factura del mes y lo pendiente, la cuota del mes aprobado que aún no la tiene.
 */
const { MONEDA_POR_DEFECTO } = require('./catalogosBancarios');
const { esFacturaActiva } = require('./estadoFactura');
const { facturacionDeServiciosPlan } = require('./facturacionServiciosPlan');

// Los dos grupos que Contabilidad presenta como tarjetas y botones de filtro.
// Valores admitidos por el query param `grupo_facturacion`.
const GRUPOS_FACTURACION = ['por_facturar', 'facturado'];

const centavos = (v) => Math.round(Number(v || 0) * 100);
const aSoles = (c) => c / 100;

// Lo que se necesita de cada realizado para calcular su situación.
const SELECT_SITUACION_FACTURACION = {
  id: true,
  id_servicio: true,
  servicio: {
    select: {
      moneda: true, precio_interno: true, sin_cobro: true, requiere_factura: true,
      id_mantenimiento_plan: true,
      cobro: {
        select: {
          estado: true, monto_total: true,
          cuotas: { where: { estado: 1 }, select: { id: true, numero_cuota: true, monto: true } }
        }
      },
      // Mismo origen que recomputarEstadoFacturacionServicio: las facturas del
      // servicio (id_servicio), las que dan su estado_facturacion.
      facturas: {
        where: { estado: 1 },
        select: {
          id: true, id_cuota: true, numero_factura: true, tipo_comprobante: true,
          fecha_emision: true, monto: true, estado: true, estado_factura: true,
          cuota: { select: { numero_cuota: true } }
        },
        orderBy: { id: 'asc' }
      }
    }
  }
};

/**
 * ¿El servicio admite un comprobante PROPIO? Espejo de facturasController.crear:
 *   · los gratuitos no se facturan;
 *   · un mantenimiento de plan solo factura por servicio si es legacy con cobro
 *     propio vivo (su marca "Sin factura" es la de todo servicio de plan y no lo
 *     bloquea);
 *   · el resto, salvo que esté marcado "Sin factura" (requiere_factura = 0).
 */
function admiteFacturaPorServicio(servicio) {
  if (!servicio || servicio.sin_cobro === 1) return false;
  if (servicio.id_mantenimiento_plan) return !!(servicio.cobro && servicio.cobro.estado === 1);
  return servicio.requiere_factura !== 0;
}

const resumenFactura = (f, numeroCuota) => ({
  id: f.id,
  id_cuota: f.id_cuota ?? null,
  numero_factura: f.numero_factura,
  tipo_comprobante: f.tipo_comprobante,
  fecha_emision: f.fecha_emision,
  estado_factura: f.estado_factura,
  monto: Number(f.monto),
  numero_cuota: numeroCuota ?? null
});

/**
 * Situación de facturación de UN realizado.
 *
 * @param {object} realizado fila con la forma de SELECT_SITUACION_FACTURACION
 * @param {object|null} plan entrada de facturacionDeServiciosPlan, si el
 *   servicio factura por el mes de su plan
 * @returns {{
 *   moneda: string, facturado: number, por_facturar: number,
 *   facturas: object[], cuotas_por_facturar: number[], de_plan: boolean,
 *   clave_facturado: string|null, clave_por_facturar: string|null
 * }}
 * Las claves identifican el comprobante / la cuota del MES de un plan: varias
 * visitas comparten ese importe y las tarjetas lo suman una sola vez.
 */
function situacionFacturacion(realizado, plan = null) {
  const srv = realizado?.servicio || {};
  const moneda = srv.moneda || MONEDA_POR_DEFECTO;

  if (plan) {
    const factura = plan.factura || null;
    const cuotaPendiente = !factura && plan.cuota && centavos(plan.cuota.monto) > 0;
    return {
      moneda,
      facturado: factura ? Number(factura.monto) : 0,
      por_facturar: cuotaPendiente ? Number(plan.cuota.monto) : 0,
      facturas: factura ? [resumenFactura(factura, factura.id_cuota != null ? plan.numero_cuota : null)] : [],
      cuotas_por_facturar: cuotaPendiente ? [plan.numero_cuota] : [],
      de_plan: true,
      clave_facturado: factura ? `factura:${factura.id}` : null,
      clave_por_facturar: cuotaPendiente ? `cuota:${plan.id_cuota}` : null
    };
  }

  const facturas = (srv.facturas || []).filter(esFacturaActiva);
  const facturadoCent = facturas.reduce((acc, f) => acc + centavos(f.monto), 0);

  let porFacturarCent = 0;
  let cuotasPorFacturar = [];
  if (admiteFacturaPorServicio(srv)) {
    // Total cobrable: el monto del cobro y, sin cobro, el precio del servicio
    // (el mismo tope con que facturasController valida la facturación general).
    const totalCent = centavos(srv.cobro?.monto_total ?? srv.precio_interno ?? 0);
    if (facturas.length === 0) {
      porFacturarCent = totalCent;
    } else if (facturas.some(f => f.id_cuota == null)) {
      // Facturación general: falta la diferencia entre el total y lo emitido.
      porFacturarCent = totalCent - facturadoCent;
    } else {
      const facturadas = new Set(facturas.map(f => f.id_cuota));
      const pendientes = (srv.cobro?.cuotas || [])
        .filter(c => centavos(c.monto) > 0 && !facturadas.has(c.id));
      porFacturarCent = pendientes.reduce((acc, c) => acc + centavos(c.monto), 0);
      cuotasPorFacturar = pendientes.map(c => c.numero_cuota).sort((a, b) => a - b);
    }
  }

  return {
    moneda,
    facturado: aSoles(facturadoCent),
    por_facturar: aSoles(Math.max(0, porFacturarCent)),
    facturas: facturas.map(f => resumenFactura(f, f.cuota?.numero_cuota)),
    cuotas_por_facturar: cuotasPorFacturar,
    de_plan: false,
    clave_facturado: null,
    clave_por_facturar: null
  };
}

/**
 * ¿La situación pertenece al grupo? Es el criterio de la tarjeta y del botón.
 *   · por_facturar → queda importe por emitir;
 *   · facturado    → tiene al menos un comprobante vigente (aunque sea parcial).
 */
function enGrupoFacturacion(situacion, grupo) {
  if (!situacion) return false;
  if (grupo === 'por_facturar') return centavos(situacion.por_facturar) > 0;
  if (grupo === 'facturado') return situacion.facturas.length > 0;
  return false;
}

/**
 * Situación de todos los realizados que cumplen `where` (sin paginar).
 *
 * @returns {Promise<Map<number, object>>} id del realizado → situación
 */
async function situacionesFacturacion(client, where) {
  const filas = await client.tbl_servicios_realizados.findMany({
    where, select: SELECT_SITUACION_FACTURACION, orderBy: { id: 'desc' }
  });
  const plan = await facturacionDeServiciosPlan(
    client,
    filas.filter(f => f.servicio?.id_mantenimiento_plan).map(f => f.id_servicio)
  );
  return new Map(filas.map(f => [f.id, situacionFacturacion(f, plan.get(f.id_servicio) || null)]));
}

/**
 * Tarjetas de Contabilidad sobre un conjunto de situaciones.
 *
 * `cantidad` cuenta servicios; los importes van POR MONEDA (PEN y USD no se
 * suman) y el comprobante / la cuota del mes de un plan entra una sola vez
 * aunque cubra varias visitas. `parciales` = servicios que están en los dos
 * grupos (facturados en parte).
 */
function resumirFacturacion(situaciones) {
  const grupos = {
    por_facturar: { cantidad: 0, montos: new Map(), campo: 'por_facturar', clave: 'clave_por_facturar' },
    facturado: { cantidad: 0, montos: new Map(), campo: 'facturado', clave: 'clave_facturado' }
  };
  const sumadas = new Set();
  let parciales = 0;
  for (const s of situaciones) {
    const enPorFacturar = enGrupoFacturacion(s, 'por_facturar');
    const enFacturado = enGrupoFacturacion(s, 'facturado');
    if (enPorFacturar && enFacturado) parciales++;
    for (const [nombre, g] of Object.entries(grupos)) {
      if (!(nombre === 'por_facturar' ? enPorFacturar : enFacturado)) continue;
      g.cantidad++;
      const clave = s[g.clave];
      if (clave) {
        if (sumadas.has(clave)) continue;
        sumadas.add(clave);
      }
      g.montos.set(s.moneda, (g.montos.get(s.moneda) || 0) + centavos(s[g.campo]));
    }
  }
  // Array ordenado por importe descendente: la moneda principal queda primero.
  const aSalida = (g) => ({
    cantidad: g.cantidad,
    montos: [...g.montos.entries()]
      .map(([moneda, cent]) => ({ moneda, total: aSoles(cent) }))
      .sort((a, b) => b.total - a.total)
  });
  return {
    por_facturar: aSalida(grupos.por_facturar),
    facturado: aSalida(grupos.facturado),
    parciales
  };
}

module.exports = {
  GRUPOS_FACTURACION,
  SELECT_SITUACION_FACTURACION,
  admiteFacturaPorServicio,
  situacionFacturacion,
  situacionesFacturacion,
  enGrupoFacturacion,
  resumirFacturacion
};

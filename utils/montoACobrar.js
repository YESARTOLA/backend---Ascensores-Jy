/**
 * SSoT de "¿este registro tiene un importe que cobrar?".
 *
 * Gestión de cobros y Contabilidad no listan lo que no mueve dinero: los
 * servicios gratuitos / sin costo y los que quedaron en S/ 0.00 (un pago de
 * contratista registrado sin importe, o el cobro único de un plan de
 * mantenimiento que aún no tiene ningún mes aprobado). No hay nada que cobrar
 * ni que facturar, y solo ensucian la cartera.
 *
 * No es una baja: el registro sigue en su módulo de origen y reaparece solo en
 * cuanto tenga importe (p. ej. al aprobarse el primer mes del plan, que suma su
 * cuota al monto del cobro).
 */

/** Cobros (tbl_cobros): su monto facturado es mayor que cero. */
function whereCobroConMonto() {
  return { monto_total: { gt: 0 } };
}

/**
 * Cuotas (tbl_cobros_cuotas) con importe. Las de 0 son los MESES GRATUITOS de
 * un plan (se prestan pero no se cobran) y la cuota única de un cobro sin monto.
 */
function whereCuotaConMonto() {
  return { monto: { gt: 0 } };
}

/**
 * Servicios realizados (tbl_servicios_realizados) que Contabilidad lista: fuera
 * los gratuitos (sin_cobro = 1, que la tabla pinta "Sin costo") y los que no
 * tienen importe por ninguna de las fuentes con que se arma su "Total":
 *   · el precio del servicio;
 *   · el monto mensual del plan — las visitas de plan nacen con precio 0 porque
 *     lo pactado es el mensual del plan;
 *   · su cobro activo — manda el dinero real aunque el precio haya quedado en 0.
 *
 * Combínalo dentro de un AND: usa la relación `servicio`, que el consumidor
 * puede estar filtrando por su cuenta.
 */
function whereRealizadoConMonto() {
  return {
    servicio: {
      is: {
        sin_cobro: { not: 1 },
        OR: [
          { precio_interno: { gt: 0 } },
          { mantenimiento_plan: { is: { monto_mensual: { gt: 0 } } } },
          { cobro: { is: { estado: 1, monto_total: { gt: 0 } } } }
        ]
      }
    }
  };
}

/** Monto de un filtro ("150", "150.5", "150,50"): número ≥ 0 con 2 decimales, o null. */
function montoDeFiltro(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const n = Number(String(valor).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Servicios realizados cuyo "Total" de Contabilidad está entre `min` y `max`
 * (extremos opcionales e inclusivos), o null si no se pidió rango. Mismo
 * criterio que pinta la columna (frontend utils/planMantenimiento.js,
 * precioMensualDelPlan), para que el filtro traiga lo que la columna dice:
 *   · visita de un plan sin precio propio → el monto mensual del plan;
 *   · cualquier otro servicio → su precio.
 *
 * Combínalo dentro de un AND, como whereRealizadoConMonto.
 */
function whereTotalRealizadoEnRango({ min, max }) {
  const desde = montoDeFiltro(min);
  const hasta = montoDeFiltro(max);
  if (desde === null && hasta === null) return null;
  const rango = {
    ...(desde !== null ? { gte: desde } : {}),
    ...(hasta !== null ? { lte: hasta } : {})
  };
  return {
    servicio: {
      is: {
        OR: [
          { id_mantenimiento_plan: { not: null }, precio_interno: 0, mantenimiento_plan: { is: { monto_mensual: rango } } },
          { AND: [{ OR: [{ id_mantenimiento_plan: null }, { precio_interno: { not: 0 } }] }, { precio_interno: rango }] }
        ]
      }
    }
  };
}

module.exports = { whereCobroConMonto, whereCuotaConMonto, whereRealizadoConMonto, whereTotalRealizadoEnRango };

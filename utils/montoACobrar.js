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

module.exports = { whereCobroConMonto, whereCuotaConMonto, whereRealizadoConMonto };

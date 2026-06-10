/**
 * Cálculo de totales de una versión de cotización.
 *
 * Reglas:
 *   importe_linea = cantidad * precio_unitario * (1 - descuento_porcentaje/100)
 *   subtotal      = Σ importes
 *   igv           = subtotal * igv_tasa   (0 si la cotización es sin IGV)
 *   total         = subtotal + igv
 *
 * Todos los cálculos usan Number (suficiente para montos < 10^9 con 2 decimales).
 * Se redondea a 2 decimales en cada paso para que coincida con lo que ve el cliente.
 */

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function calcularImporteLinea(item) {
  const cantidad = Number(item.cantidad) || 0;
  const precio = Number(item.precio_unitario) || 0;
  const desc = Number(item.descuento_porcentaje) || 0;
  const importe = cantidad * precio * (1 - desc / 100);
  return round2(importe);
}

function calcularTotalesVersion(items, igvTasa, sinIgv = false) {
  // Sin IGV: la tasa efectiva es 0 (no se afecta el subtotal).
  const tasa = sinIgv ? 0 : (Number(igvTasa) || 0);
  let subtotal = 0;
  for (const it of items) subtotal += calcularImporteLinea(it);
  subtotal = round2(subtotal);
  const igv = round2(subtotal * tasa);
  const monto_total = round2(subtotal + igv);
  return { subtotal, igv, igv_tasa: tasa, monto_total };
}

/**
 * Normaliza y valida un plan de cuotas informativo de una versión.
 *
 * Recibe un arreglo del cliente con forma { numero_cuota, fecha_vencimiento, monto }
 * y un montoTotal de referencia. Devuelve un arreglo limpio listo para persistir
 * en `plan_cuotas` (JSON), o lanza Error si el plan es inválido.
 *
 * Reglas:
 *   - Mínimo 2 cuotas (1 sola cuota = pago al contado, no aplica).
 *   - Cada cuota: fecha ISO (YYYY-MM-DD) válida, monto > 0.
 *   - La suma de cuotas debe igualar el montoTotal con tolerancia de centavo.
 */
function normalizarPlanCuotas(plan, montoTotal) {
  if (!Array.isArray(plan) || plan.length < 2) {
    throw new Error('El plan de cuotas debe tener al menos 2 cuotas');
  }
  const fechaRegex = /^\d{4}-\d{2}-\d{2}$/;
  const normalizadas = plan.map((c, i) => {
    const numero = Number.isFinite(Number(c.numero_cuota)) ? Number(c.numero_cuota) : i + 1;
    const fecha = typeof c.fecha_vencimiento === 'string'
      ? c.fecha_vencimiento.slice(0, 10)
      : (c.fecha_vencimiento instanceof Date ? c.fecha_vencimiento.toISOString().slice(0, 10) : '');
    const monto = round2(c.monto);
    if (!fechaRegex.test(fecha) || Number.isNaN(new Date(fecha).getTime())) {
      throw new Error(`Cuota ${numero}: fecha de vencimiento inválida`);
    }
    if (!(monto > 0)) {
      throw new Error(`Cuota ${numero}: el monto debe ser mayor a 0`);
    }
    const observacion = typeof c.observacion === 'string' ? c.observacion.trim().slice(0, 200) : '';
    return { numero_cuota: numero, fecha_vencimiento: fecha, monto, observacion };
  });
  normalizadas.sort((a, b) => a.numero_cuota - b.numero_cuota);
  // renumerar para evitar huecos / duplicados que vengan del cliente
  normalizadas.forEach((c, i) => { c.numero_cuota = i + 1; });
  const suma = round2(normalizadas.reduce((acc, c) => acc + c.monto, 0));
  const total = round2(montoTotal);
  if (Math.abs(suma - total) > 0.01) {
    throw new Error(`La suma de cuotas (${suma.toFixed(2)}) no coincide con el total (${total.toFixed(2)})`);
  }
  return normalizadas;
}

module.exports = {
  calcularImporteLinea,
  calcularTotalesVersion,
  normalizarPlanCuotas,
  round2
};

/**
 * Cálculo de totales de una versión de cotización.
 *
 * Reglas:
 *   Descuento del ítem según `descuento_tipo` (espejo en el frontend:
 *   components/cotizaciones/ItemsCotizacionEditor.jsx, calcImporte):
 *     'porcentaje' → importe_linea = cantidad * precio_unitario * (1 - descuento_porcentaje/100)
 *     'monto'      → importe_linea = cantidad * precio_unitario - descuento_monto
 *   El monto fijo se descuenta UNA vez de la línea, no por unidad.
 *
 *   Más IGV (por defecto): los precios registrados NO incluyen IGV.
 *     subtotal = Σ importes
 *     igv      = subtotal * igv_tasa
 *     total    = subtotal + igv
 *
 *   IGV incluido: los precios registrados YA son finales; el IGV se desglosa
 *   sin aumentar el precio (118 → 100 + 18).
 *     total    = Σ importes
 *     subtotal = total / (1 + igv_tasa)
 *     igv      = total - subtotal          (así subtotal + igv = total exacto)
 *
 *   Sin IGV: tasa 0 → subtotal = total = Σ importes, igv = 0.
 *
 * Todos los cálculos usan Number (suficiente para montos < 10^9 con 2 decimales).
 * Se redondea a 2 decimales en cada paso para que coincida con lo que ve el cliente.
 */

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Tipos de descuento de un ítem (tbl_cotizaciones_items.descuento_tipo).
const DESCUENTO_PORCENTAJE = 'porcentaje';
const DESCUENTO_MONTO = 'monto';
const TIPOS_DESCUENTO = [DESCUENTO_PORCENTAJE, DESCUENTO_MONTO];

// Sin tipo (ítems previos a la opción, clientes viejos) = porcentaje.
const tipoDescuento = (item) => (item?.descuento_tipo === DESCUENTO_MONTO ? DESCUENTO_MONTO : DESCUENTO_PORCENTAJE);

// cantidad × precio unitario, antes del descuento.
const importeBruto = (item) => round2((Number(item.cantidad) || 0) * (Number(item.precio_unitario) || 0));

function calcularImporteLinea(item) {
  if (tipoDescuento(item) === DESCUENTO_MONTO) {
    return round2(importeBruto(item) - (Number(item.descuento_monto) || 0));
  }
  const cantidad = Number(item.cantidad) || 0;
  const precio = Number(item.precio_unitario) || 0;
  const desc = Number(item.descuento_porcentaje) || 0;
  const importe = cantidad * precio * (1 - desc / 100);
  return round2(importe);
}

/**
 * Descuento de un ítem listo para persistir: el tipo y su valor; el campo del
 * otro tipo queda en 0 para que no quede un descuento "dormido" en la fila.
 * Lanza Error si el descuento no es válido: porcentaje entre 0 y 100; monto
 * fijo entre 0 y el importe de la línea (nunca deja el ítem en negativo).
 *
 * @param {object} item ítem tal como llega del cliente
 * @param {number} numero posición del ítem, para el mensaje de error
 * @returns {{descuento_tipo: string, descuento_porcentaje: number, descuento_monto: number}}
 */
function normalizarDescuentoItem(item, numero) {
  const tipo = item?.descuento_tipo == null || item.descuento_tipo === '' ? DESCUENTO_PORCENTAJE : item.descuento_tipo;
  if (!TIPOS_DESCUENTO.includes(tipo)) {
    throw new Error(`Ítem ${numero}: tipo de descuento inválido (use porcentaje o monto fijo)`);
  }
  if (tipo === DESCUENTO_MONTO) {
    const monto = round2(Number(item.descuento_monto) || 0);
    const bruto = importeBruto(item);
    if (monto < 0) throw new Error(`Ítem ${numero}: el descuento no puede ser negativo`);
    if (monto > bruto) {
      throw new Error(`Ítem ${numero}: el descuento (${monto.toFixed(2)}) no puede superar el importe del ítem (${bruto.toFixed(2)})`);
    }
    return { descuento_tipo: DESCUENTO_MONTO, descuento_porcentaje: 0, descuento_monto: monto };
  }
  const porcentaje = round2(Number(item.descuento_porcentaje) || 0);
  if (porcentaje < 0 || porcentaje > 100) {
    throw new Error(`Ítem ${numero}: el descuento debe estar entre 0% y 100%`);
  }
  return { descuento_tipo: DESCUENTO_PORCENTAJE, descuento_porcentaje: porcentaje, descuento_monto: 0 };
}

// Ítems del cliente con su descuento normalizado (lanza Error como arriba).
const normalizarDescuentosItems = (items) =>
  items.map((it, i) => ({ ...it, ...normalizarDescuentoItem(it, i + 1) }));

function calcularTotalesVersion(items, igvTasa, sinIgv = false, igvIncluido = false) {
  // Sin IGV: la tasa efectiva es 0 (no se afecta el subtotal).
  const tasa = sinIgv ? 0 : (Number(igvTasa) || 0);
  let suma = 0;
  for (const it of items) suma += calcularImporteLinea(it);
  suma = round2(suma);
  if (igvIncluido && tasa > 0) {
    const subtotal = round2(suma / (1 + tasa));
    return { subtotal, igv: round2(suma - subtotal), igv_tasa: tasa, monto_total: suma };
  }
  const igv = round2(suma * tasa);
  return { subtotal: suma, igv, igv_tasa: tasa, monto_total: round2(suma + igv) };
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
  DESCUENTO_PORCENTAJE,
  DESCUENTO_MONTO,
  TIPOS_DESCUENTO,
  tipoDescuento,
  calcularImporteLinea,
  normalizarDescuentoItem,
  normalizarDescuentosItems,
  calcularTotalesVersion,
  normalizarPlanCuotas,
  round2
};

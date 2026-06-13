/**
 * Validación compartida del arreglo de ascensores con monto que reciben tanto
 * Servicios/Proyectos como los Planes de mantenimiento. Cada servicio/plan cubre
 * N ascensores y reparte un precio total entre ellos; aquí se valida que:
 *   - haya al menos un ascensor y no se repitan,
 *   - cada monto sea un número >= 0,
 *   - todos los ascensores pertenezcan al cliente (vía tbl_edificios.id_cliente),
 *   - la suma de montos coincida con el precio total (tolerancia de un centavo),
 *     cuando se provee un precio total con el cual contrastar.
 *
 * SSoT de esta lógica: no debe duplicarse en los controladores.
 */
const prisma = require('../config/prisma');

const TOLERANCIA_SUMA_ASCENSORES = 0.01;

/**
 * Reparte `total` entre `n` ascensores en partes iguales al centavo; el último
 * absorbe el sobrante para que la suma cuadre exactamente con el total.
 * Devuelve un arreglo de Number con `n` montos.
 */
function repartirParejo(total, n) {
  if (!n || n <= 0) return [];
  const totalCentavos = Math.round(Number(total || 0) * 100);
  const base = Math.floor(totalCentavos / n);
  const sobra = totalCentavos - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i === n - 1 ? sobra : 0)) / 100);
}

async function validarAscensores(input, idCliente, precioInterno, monedaServicio) {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: 'Debe seleccionar al menos un ascensor' };
  }
  const items = [];
  const vistos = new Set();
  let suma = 0;
  for (const raw of input) {
    const idAsc = Number(raw?.id_ascensor);
    const monto = Number(raw?.monto);
    if (!Number.isFinite(idAsc) || idAsc <= 0) {
      return { ok: false, error: 'id_ascensor inválido en la lista de ascensores' };
    }
    if (!Number.isFinite(monto) || monto < 0) {
      return { ok: false, error: 'monto inválido en la lista de ascensores' };
    }
    if (vistos.has(idAsc)) {
      return { ok: false, error: 'No se puede repetir un mismo ascensor' };
    }
    vistos.add(idAsc);
    suma += monto;
    items.push({ id_ascensor: idAsc, monto });
  }
  // Validar que todos los ascensores pertenezcan al cliente. El ascensor se
  // asocia al cliente a través de su edificio (tbl_edificios.id_cliente).
  const ascBD = await prisma.tbl_ascensores.findMany({
    where: { id: { in: items.map(i => i.id_ascensor) }, estado: 1 },
    include: { edificio: { select: { id_cliente: true } } }
  });
  if (ascBD.length !== items.length) {
    return { ok: false, error: 'Uno o más ascensores no existen o están inactivos' };
  }
  for (const a of ascBD) {
    if (a.edificio?.id_cliente !== Number(idCliente)) {
      return { ok: false, error: `El ascensor ${a.codigo} no pertenece al cliente seleccionado` };
    }
  }
  // Validar que la suma de montos coincida con el precio total (tolerancia centavo)
  const precio = Number(precioInterno);
  if (Number.isFinite(precio) && Math.abs(suma - precio) > TOLERANCIA_SUMA_ASCENSORES) {
    return { ok: false, error: `La suma de montos por ascensor (S/ ${suma.toFixed(2)}) no coincide con el precio total (S/ ${precio.toFixed(2)})` };
  }
  return { ok: true, items, suma, moneda: monedaServicio || 'PEN' };
}

module.exports = { validarAscensores, repartirParejo, TOLERANCIA_SUMA_ASCENSORES };

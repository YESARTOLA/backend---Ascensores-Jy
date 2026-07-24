/**
 * Reglas compartidas de los ascensores que cubre un servicio/plan. Conviven dos
 * modelos de precio, y cada uno usa una entrada distinta de este módulo:
 *
 *   - Servicios y Proyectos: reparten UN precio total entre N ascensores. Usan
 *     `validarAscensores`, que además exige que la suma de montos cuadre con ese
 *     total (tolerancia de un centavo).
 *   - Planes de mantenimiento: NO reparten nada. Cada ascensor aporta su propio
 *     precio de catálogo para el subtipo (tbl_ascensores_precios). Usan
 *     `preciosConfiguradosPorAscensor`, que devuelve montos autoritativos desde
 *     la base y por lo tanto ignora cualquier monto que mande el cliente HTTP.
 *
 * Ambos comparten `validarPertenenciaAscensores`. SSoT de esta lógica: no debe
 * duplicarse en los controladores.
 */
const prisma = require('../config/prisma');
const { MONEDA_POR_DEFECTO } = require('./catalogosBancarios');

const TOLERANCIA_SUMA_ASCENSORES = 0.01;

/**
 * Verifica que un conjunto de ascensores exista, esté activo, pertenezca al
 * cliente indicado (vía tbl_edificios.id_cliente) y admita servicios. SSoT de
 * la regla de pertenencia: la comparten el reparto por total (Servicios y
 * Proyectos, vía `validarAscensores`) y el precio por ascensor (Planes de
 * mantenimiento), que no reparte nada.
 *
 * @returns {Promise<{ok:true} | {ok:false, error:string}>}
 */
async function validarPertenenciaAscensores(idsAscensores, idCliente) {
  const ids = [...new Set((idsAscensores || []).map(Number))];
  const ascBD = await prisma.tbl_ascensores.findMany({
    where: { id: { in: ids }, estado: 1 },
    include: { edificio: { select: { id_cliente: true } } }
  });
  if (ascBD.length !== ids.length) {
    return { ok: false, error: 'Uno o más ascensores no existen o están inactivos' };
  }
  for (const a of ascBD) {
    if (a.edificio?.id_cliente !== Number(idCliente)) {
      return { ok: false, error: `El ascensor ${a.codigo} no pertenece al cliente seleccionado` };
    }
    // Un ascensor con la instalación cancelada no está físicamente instalado:
    // no admite servicios (correctivos, emergencias, mantenimientos ni proyectos).
    if (a.estado_operativo === 'Instalación cancelada') {
      return { ok: false, error: `El ascensor ${a.codigo} tiene la instalación cancelada y no admite servicios` };
    }
  }
  return { ok: true };
}

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
  const pertenencia = await validarPertenenciaAscensores(items.map(i => i.id_ascensor), idCliente);
  if (!pertenencia.ok) return pertenencia;

  // Validar que la suma de montos coincida con el precio total (tolerancia centavo)
  const precio = Number(precioInterno);
  if (Number.isFinite(precio) && Math.abs(suma - precio) > TOLERANCIA_SUMA_ASCENSORES) {
    return { ok: false, error: `La suma de montos por ascensor (S/ ${suma.toFixed(2)}) no coincide con el precio total (S/ ${precio.toFixed(2)})` };
  }
  return { ok: true, items, suma, moneda: monedaServicio || MONEDA_POR_DEFECTO };
}

/**
 * Precio de catálogo por ascensor para un subtipo de servicio. SSoT del
 * "bloquear": si algún ascensor no tiene precio configurado para ese subtipo,
 * devuelve `{ ok:false }` nombrando los ascensores faltantes. En éxito, cada
 * `monto` es el precio configurado del ascensor (autoritativo, no del cliente).
 *
 * @param {number[]} idsAscensores
 * @param {number}   idTipoServicio
 * @returns {Promise<{ok:true, items:{id_ascensor:number,monto:number}[], suma:number, moneda:string} | {ok:false, error:string}>}
 */
async function preciosConfiguradosPorAscensor(idsAscensores, idTipoServicio) {
  const ids = [...new Set((idsAscensores || []).map(Number).filter(n => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) {
    return { ok: false, error: 'Debe seleccionar al menos un ascensor' };
  }
  const idTipo = Number(idTipoServicio);
  if (!Number.isFinite(idTipo) || idTipo <= 0) {
    return { ok: false, error: 'Tipo de servicio inválido' };
  }

  const precios = await prisma.tbl_ascensores_precios.findMany({
    where: { id_ascensor: { in: ids }, id_tipo_servicio: idTipo, estado: 1 }
  });
  const porAscensor = new Map(precios.map(p => [p.id_ascensor, p]));

  const faltantes = ids.filter(id => !porAscensor.has(id));
  if (faltantes.length > 0) {
    const codigos = await prisma.tbl_ascensores.findMany({
      where: { id: { in: faltantes } }, select: { codigo: true }
    });
    const lista = codigos.map(c => c.codigo).join(', ');
    return {
      ok: false,
      error: `Configure primero el precio para este subtipo de servicio en el/los ascensor(es): ${lista}`
    };
  }

  // Moneda homogénea: un plan multi-ascensor se factura en un único cobro/cuota
  // por periodo (suma de todos los ascensores), y una cuota tiene una sola moneda.
  // No se puede mezclar PEN y USD en el mismo plan.
  const monedas = [...new Set(precios.map(p => p.moneda || MONEDA_POR_DEFECTO))];
  if (monedas.length > 1) {
    return { ok: false, error: 'Todos los ascensores del plan deben usar la misma moneda' };
  }

  const items = ids.map(id => ({ id_ascensor: id, monto: Number(porAscensor.get(id).precio) }));
  const suma = items.reduce((acc, it) => acc + it.monto, 0);
  const moneda = precios[0]?.moneda || MONEDA_POR_DEFECTO;
  return { ok: true, items, suma, moneda };
}

module.exports = {
  validarAscensores,
  validarPertenenciaAscensores,
  repartirParejo,
  preciosConfiguradosPorAscensor,
  TOLERANCIA_SUMA_ASCENSORES
};

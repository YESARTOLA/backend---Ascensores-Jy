/**
 * Fecha de pago de las cuotas de un cobro — regla ÚNICA.
 *
 * La "Fecha pago" de una cuota es la fecha REAL de cobro del abono que la
 * terminó de cubrir (tbl_pagos.fecha_pago, la que registra Contabilidad), no
 * el día en que se cargó el abono en el sistema. No hay vínculo pago↔cuota en
 * la base: se reconstruye repitiendo la imputación FIFO de registrarPago
 * (abonos en el orden en que se registraron, cuotas por numero_cuota), donde
 * cada cuota consume lo que efectivamente tiene pagado (monto_pagado).
 *
 * Se usa al editar la fecha de un abono y en el saneamiento del histórico
 * (scripts/sincronizarFechaPagoCuotas.js).
 */

const aCentavos = (n) => Math.round(Number(n || 0) * 100);
const ymd = (f) => (f ? new Date(f).toISOString().slice(0, 10) : null);

/**
 * @param {Array} cuotas activas del cobro ({ id, numero_cuota, monto, monto_pagado, estado_cuota })
 * @param {Array} pagos activos del cobro ({ id, numero_abono, monto, fecha_pago })
 * @returns {Map<number, Date>} id de cuota Pagada → fecha_pago del abono que la completó
 */
function fechasPagoPorCuota(cuotas, pagos) {
  const cola = [...pagos]
    .sort((a, b) => a.numero_abono - b.numero_abono || a.id - b.id)
    .map(p => ({ fecha: p.fecha_pago, restante: aCentavos(p.monto) }));
  const resultado = new Map();
  let i = 0;
  for (const cu of [...cuotas].sort((a, b) => a.numero_cuota - b.numero_cuota)) {
    let falta = aCentavos(cu.monto_pagado);
    if (falta <= 0) continue;
    let ultimo = null;
    while (falta > 0 && i < cola.length) {
      const tomar = Math.min(falta, cola[i].restante);
      falta -= tomar;
      cola[i].restante -= tomar;
      ultimo = cola[i];
      if (cola[i].restante <= 0) i++;
    }
    // Sin abonos suficientes para explicar lo pagado: no se adivina.
    if (falta > 0) break;
    const pagada = cu.estado_cuota === 'Pagada' && aCentavos(cu.monto) > 0;
    if (pagada && ultimo) resultado.set(cu.id, ultimo.fecha);
  }
  return resultado;
}

/**
 * Alinea en la base las fechas de pago de las cuotas y la fecha del último
 * abono del cobro con las fechas reales de sus abonos.
 *
 * @param db       cliente Prisma o transacción
 * @param idCobro
 * @param userId   auditoría de modificación (null en scripts)
 * @param opts.simular  true → solo calcula, no escribe
 * @returns {Promise<{cuotas: Array<{id, numero_cuota, antes, despues}>, ultimoAbono: {antes, despues}|null}>}
 */
async function sincronizarFechasPagoCuotas(db, idCobro, userId = null, { simular = false } = {}) {
  // Secuencial: `db` puede ser una transacción interactiva.
  const cobro = await db.tbl_cobros.findUnique({ where: { id: idCobro }, select: { fecha_ultimo_abono: true } });
  const cuotas = await db.tbl_cobros_cuotas.findMany({
    where: { id_cobro: idCobro, estado: 1 },
    select: { id: true, numero_cuota: true, monto: true, monto_pagado: true, estado_cuota: true, fecha_pago: true }
  });
  const pagos = await db.tbl_pagos.findMany({
    where: { id_cobro: idCobro, estado: 1 },
    select: { id: true, numero_abono: true, monto: true, fecha_pago: true }
  });
  const cambios = { cuotas: [], ultimoAbono: null };
  if (!cobro || pagos.length === 0) return cambios;

  const stamp = { user_id_modification: userId, date_time_modification: new Date() };
  const fechas = fechasPagoPorCuota(cuotas, pagos);
  for (const cu of cuotas) {
    const fecha = fechas.get(cu.id);
    if (!fecha || ymd(fecha) === ymd(cu.fecha_pago)) continue;
    cambios.cuotas.push({ id: cu.id, numero_cuota: cu.numero_cuota, antes: ymd(cu.fecha_pago), despues: ymd(fecha) });
    if (!simular) {
      await db.tbl_cobros_cuotas.update({ where: { id: cu.id }, data: { fecha_pago: fecha, ...stamp } });
    }
  }

  const ultimo = pagos.reduce((max, p) => (ymd(p.fecha_pago) > ymd(max) ? p.fecha_pago : max), pagos[0].fecha_pago);
  if (ymd(ultimo) !== ymd(cobro.fecha_ultimo_abono)) {
    cambios.ultimoAbono = { antes: ymd(cobro.fecha_ultimo_abono), despues: ymd(ultimo) };
    if (!simular) {
      await db.tbl_cobros.update({ where: { id: idCobro }, data: { fecha_ultimo_abono: ultimo, ...stamp } });
    }
  }
  return cambios;
}

module.exports = { fechasPagoPorCuota, sincronizarFechasPagoCuotas };

/**
 * Ajuste de un cobro cuando cambia el MONTO de un abono ya registrado
 * (cobrosController.editarPago).
 *
 * Trabaja por DIFERENCIA, igual que registrarPago, para no reordenar lo que ya
 * está imputado a las cuotas:
 *  - si el abono sube, la diferencia se aplica FIFO a las cuotas con saldo y la
 *    cuota que se complete toma la fecha de ese abono;
 *  - si baja, la diferencia se retira de las últimas cuotas con pago (de la
 *    última hacia la primera); la cuota que deje de estar Pagada pierde su
 *    fecha de pago. Un sobrepago previo (solo Super Admin) absorbe primero la
 *    rebaja, porque ese excedente nunca estuvo imputado a ninguna cuota.
 *
 * Los totales del cobro se recalculan con la suma de los abonos activos. El
 * "último abono" lo realinea quien llama (utils/fechaPagoCuotas.js) y los
 * efectos sobre el servicio y los recordatorios también son de quien llama.
 */

const aCentavos = (n) => Math.round(Number(n || 0) * 100);
const aSoles = (c) => Number((c / 100).toFixed(2));

/**
 * @param db          transacción Prisma
 * @param cobro       cobro con `cuotas` activas y `pagos` activos, donde el abono
 *                    editado YA tiene su monto nuevo (en memoria y en la base)
 * @param deltaCents  monto nuevo − monto anterior del abono, en centavos (≠ 0)
 * @param fechaAbono  fecha real de cobro (Date) del abono editado
 * @param userId      auditoría de modificación
 * @returns {Promise<{total_abonado, saldo_pendiente, estado_cobro, cuotas_pagadas, cuotas_faltantes, fecha_proximo_abono, cuotas: Array}>}
 */
async function aplicarCambioMontoAbono(db, cobro, deltaCents, fechaAbono, userId) {
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };
  const cuotas = [...cobro.cuotas].sort((a, b) => a.numero_cuota - b.numero_cuota);
  const cambios = [];
  let pagadasDelta = 0;

  const persistir = async (cu, pagadoCents) => {
    const montoCents = aCentavos(cu.monto);
    const estado = pagadoCents >= montoCents ? 'Pagada' : pagadoCents > 0 ? 'Parcial' : 'Pendiente';
    // La cuota que ya estaba pagada conserva su fecha; la que se completa ahora
    // toma la del abono; la que deja de estar pagada se queda sin fecha.
    const fecha = estado !== 'Pagada' ? null : cu.estado_cuota === 'Pagada' ? cu.fecha_pago : fechaAbono;
    if (cu.estado_cuota === 'Pagada' && estado !== 'Pagada') pagadasDelta--;
    if (cu.estado_cuota !== 'Pagada' && estado === 'Pagada') pagadasDelta++;
    cambios.push({
      id: cu.id, numero_cuota: cu.numero_cuota,
      antes: { monto_pagado: Number(cu.monto_pagado), estado_cuota: cu.estado_cuota },
      despues: { monto_pagado: aSoles(pagadoCents), estado_cuota: estado }
    });
    await db.tbl_cobros_cuotas.update({
      where: { id: cu.id },
      data: { monto_pagado: aSoles(pagadoCents), estado_cuota: estado, fecha_pago: fecha, ...stamp }
    });
    cu.monto_pagado = aSoles(pagadoCents);
    cu.estado_cuota = estado;
    cu.fecha_pago = fecha;
  };

  const totalCents = cobro.pagos.reduce((acc, p) => acc + aCentavos(p.monto), 0);
  const imputadoCents = cuotas.reduce((acc, c) => acc + aCentavos(c.monto_pagado), 0);

  if (deltaCents > 0) {
    let restante = deltaCents;
    for (const cu of cuotas) {
      if (restante <= 0) break;
      const falta = aCentavos(cu.monto) - aCentavos(cu.monto_pagado);
      if (falta <= 0) continue;
      const aplicar = Math.min(restante, falta);
      await persistir(cu, aCentavos(cu.monto_pagado) + aplicar);
      restante -= aplicar;
    }
  } else if (deltaCents < 0) {
    // Lo abonado antes del cambio que no estaba imputado a ninguna cuota.
    const sobranteCents = Math.max(0, (totalCents - deltaCents) - imputadoCents);
    let quitar = Math.max(0, -deltaCents - sobranteCents);
    for (const cu of [...cuotas].reverse()) {
      if (quitar <= 0) break;
      const pagado = aCentavos(cu.monto_pagado);
      if (pagado <= 0) continue;
      const tomar = Math.min(quitar, pagado);
      await persistir(cu, pagado - tomar);
      quitar -= tomar;
    }
  }

  const saldoCents = Math.max(0, aCentavos(cobro.monto_total) - totalCents);
  const cuotasPagadas = Math.max(0, Number(cobro.cuotas_pagadas || 0) + pagadasDelta);
  const proxima = cuotas.find(c => aCentavos(c.monto_pagado) < aCentavos(c.monto));
  const fechaProximo = saldoCents === 0 ? null : proxima ? proxima.fecha_vencimiento : cobro.fecha_proximo_abono;
  const data = {
    total_abonado: aSoles(totalCents),
    saldo_pendiente: aSoles(saldoCents),
    estado_cobro: saldoCents === 0 ? 'Pagado' : totalCents > 0 ? 'Parcialmente pagado' : 'En gestión',
    cuotas_pagadas: cuotasPagadas,
    cuotas_faltantes: Math.max(0, Number(cobro.numero_cuotas || 0) - cuotasPagadas),
    fecha_proximo_abono: fechaProximo
  };
  await db.tbl_cobros.update({ where: { id: cobro.id }, data: { ...data, ...stamp } });
  Object.assign(cobro, data);
  return { ...data, cuotas: cambios };
}

module.exports = { aplicarCambioMontoAbono };

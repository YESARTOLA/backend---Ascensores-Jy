/**
 * Fechas de pago de un cobro — reglas ÚNICAS.
 *
 * Las tres fechas que ve el usuario en CobroDetalle (fecha de cada abono,
 * "Fecha pago" de cada cuota y "Último abono" del resumen) salen de los
 * abonos: solo la fecha del abono se edita; las otras dos se derivan.
 *
 * 1) "Fecha pago" de una cuota: la fecha REAL de cobro más reciente entre los
 *    abonos que la cubren (tbl_pagos.fecha_pago, la que registra Contabilidad),
 *    es decir, el día en que la cuota quedó completamente pagada; nunca el día
 *    en que se cargó el abono. No hay vínculo pago↔cuota en la base: se
 *    reconstruye repitiendo la imputación FIFO de registrarPago (abonos en el
 *    orden en que se registraron, cuotas por numero_cuota), donde cada cuota
 *    consume lo que efectivamente tiene pagado (monto_pagado). No se edita a
 *    mano: se realinea sola cuando cambia un abono y al abrir el cobro.
 *
 * 2) "Último abono" del cobro (tbl_cobros.fecha_ultimo_abono): la fecha de
 *    cobro más reciente de los abonos activos; sin abonos, null. Con el cobro
 *    pagado coincide con la "Fecha pago" más reciente de las cuotas.
 *
 * Se usan al registrar o editar un abono, al leer el cobro (autocorrección) y
 * en el saneamiento del histórico (scripts/sincronizarFechaPagoCuotas.js).
 */

const aCentavos = (n) => Math.round(Number(n || 0) * 100);
const ymd = (f) => (f ? new Date(f).toISOString().slice(0, 10) : null);
// Auditoría de modificación: solo cuando hay un usuario (los scripts y las
// lecturas no sobreescriben con null al último que modificó el registro).
const sello = (userId) => (userId == null ? {} : { user_id_modification: userId, date_time_modification: new Date() });

/**
 * Regla 1: fecha de pago de cada cuota pagada.
 *
 * @param {Array} cuotas activas del cobro ({ id, numero_cuota, monto, monto_pagado, estado_cuota })
 * @param {Array} pagos activos del cobro ({ id, numero_abono, monto, fecha_pago })
 * @returns {Map<number, {fecha: Date, id_pago: number}>} id de cuota Pagada → abono
 *   más reciente entre los que la cubren (su fecha es la fecha de pago de la cuota)
 */
function fechasPagoPorCuota(cuotas, pagos) {
  const cola = [...pagos]
    .sort((a, b) => a.numero_abono - b.numero_abono || a.id - b.id)
    .map(p => ({ id_pago: p.id, fecha: p.fecha_pago, restante: aCentavos(p.monto) }));
  const resultado = new Map();
  let i = 0;
  for (const cu of [...cuotas].sort((a, b) => a.numero_cuota - b.numero_cuota)) {
    let falta = aCentavos(cu.monto_pagado);
    if (falta <= 0) continue;
    let masReciente = null;
    while (falta > 0 && i < cola.length) {
      const tomar = Math.min(falta, cola[i].restante);
      falta -= tomar;
      cola[i].restante -= tomar;
      if (tomar > 0 && (!masReciente || ymd(cola[i].fecha) > ymd(masReciente.fecha))) masReciente = cola[i];
      if (cola[i].restante <= 0) i++;
    }
    // Sin abonos suficientes para explicar lo pagado: no se adivina.
    if (falta > 0) break;
    const pagada = cu.estado_cuota === 'Pagada' && aCentavos(cu.monto) > 0;
    if (pagada && masReciente) resultado.set(cu.id, { fecha: masReciente.fecha, id_pago: masReciente.id_pago });
  }
  return resultado;
}

/**
 * Regla 2: "Último abono" del cobro.
 *
 * @param {Array} pagos activos del cobro ({ fecha_pago })
 * @returns {Date|null} fecha de cobro más reciente; sin abonos, null
 */
function fechaUltimoAbono(pagos) {
  return (pagos || []).reduce((max, p) => (p?.fecha_pago && (!max || ymd(p.fecha_pago) > ymd(max)) ? p.fecha_pago : max), null);
}

async function cargarCobro(db, idCobro) {
  return db.tbl_cobros.findUnique({
    where: { id: idCobro },
    select: {
      id: true,
      fecha_ultimo_abono: true,
      cuotas: {
        where: { estado: 1 },
        select: { id: true, numero_cuota: true, monto: true, monto_pagado: true, estado_cuota: true, fecha_pago: true }
      },
      pagos: { where: { estado: 1 }, select: { id: true, numero_abono: true, monto: true, fecha_pago: true } }
    }
  });
}

/**
 * Alinea tbl_cobros.fecha_ultimo_abono con la regla 2.
 *
 * @param db      cliente Prisma o transacción
 * @param cobro   id del cobro, o el cobro ya cargado con { id, fecha_ultimo_abono,
 *                pagos (activos, con fecha_pago) }; si viene cargado se actualiza en memoria
 * @param userId  auditoría de modificación (null en scripts y lecturas)
 * @param opts.simular  true → solo calcula, no escribe
 * @returns {Promise<{antes, despues}|null>} el cambio, o null si ya coincidía
 */
async function sincronizarUltimoAbono(db, cobro, userId = null, { simular = false } = {}) {
  if (typeof cobro === 'number') cobro = await cargarCobro(db, cobro);
  if (!cobro) return null;
  const ultimo = fechaUltimoAbono(cobro.pagos);
  if (ymd(ultimo) === ymd(cobro.fecha_ultimo_abono)) return null;
  const cambio = { antes: ymd(cobro.fecha_ultimo_abono), despues: ymd(ultimo) };
  if (!simular) {
    await db.tbl_cobros.update({ where: { id: cobro.id }, data: { fecha_ultimo_abono: ultimo, ...sello(userId) } });
    cobro.fecha_ultimo_abono = ultimo;
  }
  return cambio;
}

/**
 * Alinea en la base las fechas de pago de las cuotas (regla 1) y el último
 * abono del cobro (regla 2) con las fechas reales de sus abonos.
 *
 * @param db      cliente Prisma o transacción
 * @param cobro   id del cobro, o el cobro ya cargado con { id, fecha_ultimo_abono,
 *                cuotas activas, pagos activos }; si viene cargado se actualiza en memoria
 * @param userId  auditoría de modificación (null en scripts y lecturas)
 * @param opts.simular  true → solo calcula, no escribe
 * @returns {Promise<{cuotas: Array<{id, numero_cuota, antes, despues}>, ultimoAbono: {antes, despues}|null}>}
 */
async function sincronizarFechasPagoCuotas(db, cobro, userId = null, { simular = false } = {}) {
  if (typeof cobro === 'number') cobro = await cargarCobro(db, cobro);
  const cambios = { cuotas: [], ultimoAbono: null };
  if (!cobro) return cambios;

  if ((cobro.pagos || []).length > 0) {
    const imputaciones = fechasPagoPorCuota(cobro.cuotas || [], cobro.pagos);
    for (const cu of cobro.cuotas || []) {
      const imp = imputaciones.get(cu.id);
      if (!imp || ymd(imp.fecha) === ymd(cu.fecha_pago)) continue;
      cambios.cuotas.push({ id: cu.id, numero_cuota: cu.numero_cuota, antes: ymd(cu.fecha_pago), despues: ymd(imp.fecha) });
      if (!simular) {
        await db.tbl_cobros_cuotas.update({ where: { id: cu.id }, data: { fecha_pago: imp.fecha, ...sello(userId) } });
        cu.fecha_pago = imp.fecha;
      }
    }
  }

  cambios.ultimoAbono = await sincronizarUltimoAbono(db, cobro, userId, { simular });
  return cambios;
}

module.exports = { fechasPagoPorCuota, fechaUltimoAbono, sincronizarUltimoAbono, sincronizarFechasPagoCuotas };

/**
 * Crea el cobro inicial de un servicio dentro de una transacción Prisma.
 *
 * Centraliza la lógica para que la aprobación de cotización y el fallback de
 * finalización de servicio (servicios sin cotización: directos, mantenimientos)
 * produzcan cobros con la misma forma:
 *
 *   - estado_cobro = "Sin cobro" si monto <= 0; "Pendiente de iniciar" si > 0
 *   - 1 cuota por el total (vencimiento = fechaCuotaUnica) o N cuotas si
 *     se pasa planCuotas
 *   - saldo_variable hereda del parámetro (false por defecto)
 *
 * Punto único de la regla, reutilizado por:
 *  - cotizacionesController.aprobar (con plan_cuotas y saldo_variable de la versión)
 *  - serviciosController.finalizar  (1 cuota, saldo_variable=false)
 */
const { parseYMDLima } = require('./tiempo');

/**
 * @param {object} tx - cliente Prisma transaccional o el client global
 * @param {object} opts
 * @param {number} [opts.idServicio] - servicio dueño del cobro (XOR plan)
 * @param {number} [opts.idMantenimientoPlan] - plan dueño del cobro (cobro único por el total del plan; XOR servicio)
 * @param {number} opts.idCliente
 * @param {number} opts.monto
 * @param {string} opts.moneda
 * @param {Date} opts.fechaCuotaUnica - vencimiento si no hay plan
 * @param {Array<{numero_cuota:number, fecha_vencimiento:string|Date, monto:number}>} [opts.planCuotas]
 * @param {boolean} [opts.saldoVariable=false]
 * @param {boolean} [opts.sinCuotas=false] - crea el cobro SIN cuotas (numero_cuotas=0).
 *   Lo usan los planes de mantenimiento: el cobro nace vacío (monto 0) y crece con
 *   una cuota por cada periodo aprobado (ver mantenimientosController.aprobarPeriodo).
 * @param {number} opts.idUsuario
 */
async function crearCobroInicial(tx, opts) {
  const {
    idServicio = null, idMantenimientoPlan = null, idCliente, monto, moneda,
    fechaCuotaUnica, planCuotas, saldoVariable = false, sinCuotas = false, idUsuario
  } = opts;

  const montoNum = Number(monto || 0);
  const estadoCobroInicial = montoNum > 0 ? 'Pendiente de iniciar' : 'Sin cobro';
  const cuotasFuente = sinCuotas
    ? []
    : (Array.isArray(planCuotas) && planCuotas.length > 0
        ? planCuotas
        : [{ numero_cuota: 1, fecha_vencimiento: fechaCuotaUnica, monto: montoNum }]);

  const cuotasACrear = cuotasFuente.map(c => ({
    numero_cuota: Number(c.numero_cuota),
    fecha_vencimiento: c.fecha_vencimiento instanceof Date
      ? c.fecha_vencimiento
      : parseYMDLima(c.fecha_vencimiento),
    monto: Number(c.monto),
    user_id_registration: idUsuario
  }));
  const primeraCuotaFecha = cuotasACrear[0]?.fecha_vencimiento || fechaCuotaUnica;

  return tx.tbl_cobros.create({
    data: {
      id_servicio: idServicio,
      id_mantenimiento_plan: idMantenimientoPlan,
      id_cliente: idCliente,
      monto_total: montoNum,
      saldo_pendiente: montoNum,
      total_abonado: 0,
      numero_cuotas: cuotasACrear.length,
      cuotas_pagadas: 0,
      cuotas_faltantes: cuotasACrear.length,
      fecha_proximo_abono: (montoNum > 0 && cuotasACrear.length) ? primeraCuotaFecha : null,
      moneda,
      estado_cobro: estadoCobroInicial,
      saldo_variable: Boolean(saldoVariable),
      user_id_registration: idUsuario,
      cuotas: cuotasACrear.length ? { create: cuotasACrear } : undefined
    }
  });
}

module.exports = { crearCobroInicial };

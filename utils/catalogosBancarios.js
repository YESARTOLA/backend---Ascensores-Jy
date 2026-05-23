/**
 * Catálogos cerrados para cuentas bancarias y métodos de pago.
 * Fuente única de verdad: backend la usa para validar; frontend la consume
 * para renderizar selects y aplicar la regla "requiere cuenta bancaria".
 */

const TIPOS_CUENTA = [
  { codigo: 'Corriente',     etiqueta: 'Corriente' },
  { codigo: 'Ahorros',       etiqueta: 'Ahorros' },
  { codigo: 'Detracciones',  etiqueta: 'Detracciones' }
];

const MONEDAS = [
  { codigo: 'PEN', etiqueta: 'Soles (PEN)', simbolo: 'S/' },
  { codigo: 'USD', etiqueta: 'Dólares (USD)', simbolo: '$' }
];

const METODOS_PAGO = [
  { codigo: 'Efectivo',       etiqueta: 'Efectivo',       requiere_cuenta: false },
  { codigo: 'Transferencia',  etiqueta: 'Transferencia',  requiere_cuenta: true  },
  { codigo: 'Yape',           etiqueta: 'Yape',           requiere_cuenta: true  },
  { codigo: 'Plin',           etiqueta: 'Plin',           requiere_cuenta: true  },
  { codigo: 'Depósito',       etiqueta: 'Depósito',       requiere_cuenta: true  },
  { codigo: 'Otro',           etiqueta: 'Otro',           requiere_cuenta: false }
];

const TIPOS_CUENTA_CODIGOS = TIPOS_CUENTA.map(t => t.codigo);
const MONEDAS_CODIGOS = MONEDAS.map(m => m.codigo);
const METODOS_PAGO_CODIGOS = METODOS_PAGO.map(m => m.codigo);
const METODOS_REQUIEREN_CUENTA = METODOS_PAGO.filter(m => m.requiere_cuenta).map(m => m.codigo);

module.exports = {
  TIPOS_CUENTA,
  MONEDAS,
  METODOS_PAGO,
  TIPOS_CUENTA_CODIGOS,
  MONEDAS_CODIGOS,
  METODOS_PAGO_CODIGOS,
  METODOS_REQUIEREN_CUENTA
};

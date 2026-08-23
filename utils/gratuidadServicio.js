/**
 * SSoT de la GRATUIDAD de un servicio operativo al registrarlo.
 *
 * Dos reglas, aplicadas en el backend porque la UI no basta (el JSON se puede
 * manipular desde DevTools):
 *
 *  1. Un rol SIN visibilidad financiera —hoy el Coordinador— solo registra
 *     servicios GRATUITOS. No maneja precios, así que no puede comprometer un
 *     cobro al cliente: la marca no es opcional para él y se ignora lo que
 *     venga en el payload. Administración puede convertirlo en cobrable después
 *     desde el servicio, que es donde vive el dato económico.
 *
 *  2. GRATUITO IMPLICA SIN FACTURA. No se factura lo que no se cobra, venga de
 *     donde venga la marca: vale igual para administración cuando registra un
 *     servicio con cobertura.
 *
 * Las EMERGENCIAS no pasan por aquí: son gratuitas para todos los roles por
 * definición del negocio (ver emergenciasController.crear), no por permiso.
 */
const { puedeVerFinanzasReq } = require('./visibilidadFinanzas');

/**
 * @param {object} req   petición (aporta el rol del usuario)
 * @param {object} datos payload del alta
 * @param {object} opciones
 * @param {number} opciones.requiereFacturaPorDefecto  valor del módulo cuando no es gratuito
 * @returns {{ sinCobro: boolean, requiereFactura: number, fijaPrecio: boolean, gratuidadImpuesta: boolean }}
 *   `gratuidadImpuesta` = la marca la puso la regla, no el usuario (sirve para
 *   avisar a administración y para explicarlo en la respuesta).
 */
function resolverGratuidad(req, datos = {}, { requiereFacturaPorDefecto = 1 } = {}) {
  const fijaPrecio = puedeVerFinanzasReq(req);
  const pedidoSinCobro = datos.sin_cobro === true || datos.sin_cobro === 1 || datos.sin_cobro === '1';
  // Regla 1: sin visibilidad financiera, siempre gratuito.
  const sinCobro = fijaPrecio ? pedidoSinCobro : true;
  const gratuidadImpuesta = !fijaPrecio;

  // Regla 2: gratuito ⇒ sin factura. Solo si NO es gratuito se mira el payload.
  let requiereFactura = 0;
  if (!sinCobro) {
    requiereFactura = datos.requiere_factura === undefined
      ? requiereFacturaPorDefecto
      : (datos.requiere_factura === true || datos.requiere_factura === 1 || datos.requiere_factura === '1' ? 1 : 0);
  }

  return { sinCobro, requiereFactura, fijaPrecio, gratuidadImpuesta };
}

module.exports = { resolverGratuidad };

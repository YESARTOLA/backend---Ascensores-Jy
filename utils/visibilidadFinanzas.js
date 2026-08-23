/**
 * SSoT de visibilidad de DATOS FINANCIEROS.
 *
 * Solo los roles de esta lista ven precios, montos, cobros, cuotas, pagos y
 * facturas. El resto (coordinador, técnico, vendedora, central de ventas)
 * trabaja la operación sin ningún dato económico.
 *
 * El filtrado se hace en el BACKEND (no basta con ocultarlo en la UI: el JSON
 * viaja igual al navegador y se lee desde DevTools). El frontend replica la
 * regla en `features/auth/AuthContext.jsx` (`puedeVerPrecio`) solo para no
 * pintar columnas vacías.
 */
const ROLES_FINANZAS = ['super_admin', 'admin', 'contabilidad'];

const rolDe = (u) => (u && u.rol_codigo) || null;

/** ¿Este usuario puede ver datos económicos? */
function puedeVerFinanzas(user) {
  return ROLES_FINANZAS.includes(rolDe(user));
}

/** Variante para middlewares/controladores que reciben `req`. */
function puedeVerFinanzasReq(req) {
  return puedeVerFinanzas(req && req.user);
}

/** Quita las claves indicadas de un objeto plano (no muta el original). */
function omitir(obj, claves) {
  if (!obj || typeof obj !== 'object') return obj;
  const clon = { ...obj };
  for (const k of claves) delete clon[k];
  return clon;
}

// --- Bloques económicos que se retiran por completo de un registro ----------
const BLOQUES_ECONOMICOS = ['cobro', 'cobros', 'facturas', 'pagos', 'cuotas'];

/**
 * Retira de un registro los bloques económicos completos (cobro, facturas…) y
 * los campos monetarios sueltos indicados. Devuelve el objeto tal cual si el
 * usuario tiene permiso.
 */
function sinBloquesEconomicos(registro, user, camposExtra = []) {
  if (!registro || puedeVerFinanzas(user)) return registro;
  return omitir(registro, [...BLOQUES_ECONOMICOS, ...camposExtra]);
}

// --- Servicios / Proyectos --------------------------------------------------
/**
 * Anula todo dato económico de un servicio/proyecto: su precio interno, el monto
 * por ascensor y los bloques de cobro/facturas. Pensado para los reportes y
 * listados que devuelven el registro completo.
 */
function servicioSinPrecios(servicio) {
  if (!servicio) return servicio;
  const clon = omitir(servicio, BLOQUES_ECONOMICOS);
  clon.precio_interno = null;
  if (Array.isArray(clon.ascensores)) {
    clon.ascensores = clon.ascensores.map(a => ({ ...a, monto: null }));
  }
  return clon;
}

// --- Ascensores -------------------------------------------------------------
/**
 * El IMPORTE del catálogo de precios por subtipo es dato financiero, pero el
 * HECHO de que exista un precio configurado (y su moneda) es información
 * operativa: sin ella el Coordinador no podría elegir ascensores al armar un
 * plan de mantenimiento, que es una función suya. Por eso las filas se
 * conservan sin el campo `precio` en vez de borrarse.
 *
 * El monto real nunca depende de esto: al crear el plan el backend relee los
 * precios de la base (`preciosConfiguradosPorAscensor`) e ignora lo que mande
 * el cliente HTTP.
 */
function ascensorSinFinanzas(ascensor, user) {
  if (!ascensor || puedeVerFinanzas(user)) return ascensor;
  if (!Array.isArray(ascensor.precios)) return ascensor;
  return {
    ...ascensor,
    precios: ascensor.precios.map(pr => omitir(pr, ['precio']))
  };
}

// --- Planes de mantenimiento ------------------------------------------------
/**
 * Retira del plan el monto mensual pactado (su único precio), el cobro y el
 * monto legado por ascensor. La frecuencia de cada ascensor y la duración del
 * plan SÍ se conservan: son datos operativos que el coordinador necesita para
 * saber cuándo toca cada mantenimiento.
 */
function planMantenimientoSinFinanzas(plan, user) {
  if (!plan || puedeVerFinanzas(user)) return plan;
  const clon = omitir(plan, [...BLOQUES_ECONOMICOS, 'monto_mensual']);
  if (Array.isArray(clon.ascensores)) {
    clon.ascensores = clon.ascensores.map(a => omitir(a, ['monto', 'moneda']));
  }
  return clon;
}

// --- Cotizaciones -----------------------------------------------------------
// El coordinador entra a la cotización desde el servicio: ve el alcance (ítems
// y sus fotos) y las imágenes adjuntas, nada más. Se arma por LISTA BLANCA para
// que un campo nuevo en el modelo no se filtre por olvido.
const CAMPOS_ITEM_VISIBLES = ['id', 'orden', 'descripcion', 'cantidad', 'unidad', 'id_archivo', 'archivo'];
const CAMPOS_VERSION_VISIBLES = [
  'id', 'numero_version', 'estado_version', 'fecha_envio', 'fecha_aprobacion',
  'fecha_rechazo', 'motivo_cambio', 'motivo_rechazo', 'observaciones', 'garantia'
];
const CAMPOS_COTIZACION_VISIBLES = [
  'id', 'codigo', 'estado_global', 'version_activa', 'descripcion',
  'id_cliente', 'id_tipo_servicio', 'id_subtipo_servicio',
  'cliente', 'tipo_servicio', 'subtipo_servicio', 'ascensores', 'servicios'
];

const soloClaves = (obj, claves) => {
  if (!obj) return obj;
  const salida = {};
  for (const k of claves) if (obj[k] !== undefined) salida[k] = obj[k];
  return salida;
};

/**
 * Detalle de cotización para un rol sin visibilidad financiera.
 * Conserva: cabecera operativa, ascensores e ítems (descripción / cantidad /
 * unidad / foto). Eso es el alcance del trabajo, que es lo único que necesitan
 * el Coordinador y el técnico para ejecutarlo.
 * Retira: subtotal, IGV, total, moneda, plan de cuotas, cuentas bancarias,
 * términos, PDF de la cotización, archivo de respaldo y TODOS los adjuntos de
 * la cotización —también las imágenes—: son el expediente comercial del acuerdo
 * (cotización firmada, orden de compra, presupuestos), no material de trabajo.
 */
function cotizacionSinFinanzas(cot) {
  if (!cot) return cot;
  const base = soloClaves(cot, CAMPOS_COTIZACION_VISIBLES);
  base.versiones = (cot.versiones || []).map(v => ({
    ...soloClaves(v, CAMPOS_VERSION_VISIBLES),
    items: (v.items || []).map(it => soloClaves(it, CAMPOS_ITEM_VISIBLES))
  }));
  base.archivos = [];
  // Marca para que la UI renderice la vista reducida sin adivinar por rol.
  base.sin_finanzas = true;
  return base;
}

module.exports = {
  ROLES_FINANZAS,
  puedeVerFinanzas,
  puedeVerFinanzasReq,
  omitir,
  sinBloquesEconomicos,
  servicioSinPrecios,
  ascensorSinFinanzas,
  planMantenimientoSinFinanzas,
  cotizacionSinFinanzas
};

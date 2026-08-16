/**
 * Confinamiento de roles a un conjunto cerrado de endpoints.
 *
 * Algunos roles no son "un rol con menos permisos", sino un rol que SOLO debe
 * poder tocar un módulo. Enumerar rol por rol en cada `permitirRoles` es frágil:
 * cualquier endpoint nuevo (o cualquiera que solo exija token) quedaría abierto.
 * Aquí se invierte la regla: para estos roles todo está prohibido salvo lo que
 * figura en su lista blanca.
 *
 * Se monta ANTES de las rutas de la API, sobre `/api`. Solo bloquea; no
 * autentica: cada router sigue aplicando `verificarToken` y su propio RBAC.
 */
const jwt = require('jsonwebtoken');

// Prefijos de API permitidos por rol confinado. Un prefijo cubre la ruta exacta
// y todo lo que cuelga de ella ('/leads' → '/leads/7/cotizaciones').
const RUTAS_PERMITIDAS_POR_ROL = {
  // Central de ventas: únicamente el módulo de Leads y los catálogos de solo
  // lectura que necesita su formulario (ubicación, tipo de ascensor, tipo de
  // servicio, clientes para vincular, vendedoras asignables) más la subida de
  // archivos (PDF de cotización y documentos libres del lead).
  // `/recordatorios` se permite porque la campana del layout
  // lo consulta siempre: para este rol el backend ya devuelve lista vacía.
  central_ventas: [
    '/auth',
    '/leads',
    '/clientes',
    '/tipos-servicio',
    '/tipos-ascensor',
    '/ubigeo',
    '/usuarios/catalogo',
    '/archivos',
    '/recordatorios'
  ]
};

const ROLES_CONFINADOS = Object.keys(RUTAS_PERMITIDAS_POR_ROL);

/** Rol del token, o null si no viene / no es válido (lo resuelve cada router). */
function rolDelToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET)?.rol_codigo || null;
  } catch {
    return null;
  }
}

function confinarRoles(req, res, next) {
  const rol = rolDelToken(req);
  const permitidas = rol && RUTAS_PERMITIDAS_POR_ROL[rol];
  if (!permitidas) return next();
  const ruta = req.path;
  const permitida = permitidas.some(p => ruta === p || ruta.startsWith(p + '/'));
  if (permitida) return next();
  return res.status(403).json({ error: 'No tiene permisos para esta acción' });
}

module.exports = { confinarRoles, ROLES_CONFINADOS, RUTAS_PERMITIDAS_POR_ROL };

/**
 * Middleware de control de acceso basado en roles (RBAC).
 * Recibe lista de códigos de rol permitidos (super_admin, admin, coordinador, tecnico, contabilidad).
 */
const { ROLES_FINANZAS, puedeVerFinanzasReq } = require('../utils/visibilidadFinanzas');

const permitirRoles = (...rolesPermitidos) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    const rolUsuario = req.user.rol_codigo;
    if (!rolesPermitidos.includes(rolUsuario)) {
      return res.status(403).json({ error: 'No tiene permisos para esta acción' });
    }
    next();
  };
};

const esSuperAdmin = (req, _res, _next) => req.user?.rol_codigo === 'super_admin';

// Visibilidad de datos económicos. La lista de roles vive en
// utils/visibilidadFinanzas.js (SSoT) para que middleware, controladores y
// sanitizadores no se desincronicen.
const puedeVerPrecio = (req) => puedeVerFinanzasReq(req);

/** Atajo de ruta: corta con 403 a quien no puede ver datos financieros. */
const soloFinanzas = permitirRoles(...ROLES_FINANZAS);

module.exports = { permitirRoles, esSuperAdmin, puedeVerPrecio, soloFinanzas };

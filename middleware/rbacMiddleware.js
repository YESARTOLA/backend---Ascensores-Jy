/**
 * Middleware de control de acceso basado en roles (RBAC).
 * Recibe lista de códigos de rol permitidos (super_admin, admin, coordinador, tecnico, contabilidad).
 */
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

const puedeVerPrecio = (req) => ['super_admin', 'admin', 'contabilidad'].includes(req.user?.rol_codigo);

module.exports = { permitirRoles, esSuperAdmin, puedeVerPrecio };

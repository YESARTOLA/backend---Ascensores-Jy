const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/usuariosController');

router.use(verificarToken);

// Catálogo de personas para selectores (responsable, vendedor, …). Lo consumen
// módulos operativos, no la gestión de usuarios: por eso no es solo super_admin.
router.get('/catalogo', permitirRoles('super_admin', 'admin', 'coordinador', 'vendedora', 'contabilidad', 'central_ventas'), c.catalogo);
router.get('/roles', c.roles);
router.get('/permisos', c.permisos);
router.get('/', permitirRoles('super_admin'), c.listar);
router.post('/', permitirRoles('super_admin'), c.crear);
router.put('/:id', permitirRoles('super_admin'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin'), c.cambiarEstado);

module.exports = router;

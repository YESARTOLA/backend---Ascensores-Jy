const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/usuariosController');

router.use(verificarToken);

router.get('/roles', c.roles);
router.get('/permisos', c.permisos);
router.get('/', permitirRoles('super_admin'), c.listar);
router.post('/', permitirRoles('super_admin'), c.crear);
router.put('/:id', permitirRoles('super_admin'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin'), c.cambiarEstado);

module.exports = router;

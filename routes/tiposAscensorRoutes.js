const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/tiposAscensorController');

router.use(verificarToken);

router.get('/', c.listar);
router.post('/', permitirRoles('super_admin', 'admin'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);

module.exports = router;

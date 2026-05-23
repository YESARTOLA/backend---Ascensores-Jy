const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/facturasController');

router.use(verificarToken);
router.use(permitirRoles('super_admin', 'admin', 'contabilidad'));

router.get('/', c.listar);
router.get('/:id', c.obtener);
router.post('/', c.crear);
router.patch('/:id/estado', c.cambiarEstado);

module.exports = router;

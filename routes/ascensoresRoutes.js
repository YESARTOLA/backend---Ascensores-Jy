const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/ascensoresController');

router.use(verificarToken);

router.get('/', c.listar);
router.get('/:id', c.obtener);
router.get('/:id/historial', c.historial);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);

module.exports = router;

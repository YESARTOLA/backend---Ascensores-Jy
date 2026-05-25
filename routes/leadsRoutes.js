const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/leadsController');

router.use(verificarToken);

router.get('/', c.listar);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin', 'coordinador'), c.cambiarEstado);
router.post('/:id/convertir', permitirRoles('super_admin', 'admin'), c.convertir);

module.exports = router;

const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/tiposServicioController');

router.use(verificarToken);

router.get('/', c.listar);
router.post('/', permitirRoles('super_admin', 'admin'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);

router.get('/:id/tecnicos', c.listarTecnicos);
router.post('/:id/tecnicos', permitirRoles('super_admin', 'admin'), c.vincularTecnico);
router.delete('/:id/tecnicos/:id_tecnico', permitirRoles('super_admin', 'admin'), c.desvincularTecnico);

module.exports = router;

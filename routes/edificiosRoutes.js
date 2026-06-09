const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/edificiosController');

router.use(verificarToken);

router.get('/tipos', c.listarTipos);
router.get('/distritos', c.listarDistritos);
router.get('/', c.listar);
router.get('/:id', c.obtener);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador', 'contabilidad'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);

module.exports = router;

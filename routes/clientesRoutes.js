const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/clientesController');

router.use(verificarToken);

router.get('/', c.listar);
router.get('/exportar', c.exportar);
router.get('/distritos', c.listarDistritos);
router.get('/tipos-ascensor', c.listarTiposAscensor);
router.get('/clasificaciones', c.listarClasificaciones);
router.get('/:id', c.obtener);
router.get('/:id/360', c.vista360);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador', 'contabilidad'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);

module.exports = router;

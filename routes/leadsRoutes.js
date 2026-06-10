const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/leadsController');

router.use(verificarToken);

router.get('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.listar);
router.get('/vendedores', permitirRoles('super_admin', 'admin', 'coordinador'), c.listarVendedores);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.actualizar);
router.get('/:id/historial', permitirRoles('super_admin'), c.historial);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin', 'coordinador'), c.cambiarEstado);
router.post('/:id/convertir', permitirRoles('super_admin', 'admin'), c.convertir);
router.get('/:id/cotizaciones', permitirRoles('super_admin', 'admin', 'coordinador'), c.listarCotizaciones);
router.post('/:id/cotizaciones', permitirRoles('super_admin', 'admin', 'coordinador'), c.subirCotizacion);

module.exports = router;

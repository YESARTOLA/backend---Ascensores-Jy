const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/edificiosController');

router.use(verificarToken);

router.get('/tipos', c.listarTipos);
router.get('/distritos', c.listarDistritos);
router.get('/', c.listar);
// Inactivar/reactivar masivo de todos los edificios de un cliente. Va antes de
// '/:id/estado' para que 'cliente' no se interprete como un id.
router.patch('/cliente/:idCliente/estado', permitirRoles('super_admin'), c.cambiarEstadoPorCliente);
router.get('/:id', c.obtener);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador', 'vendedora'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador', 'contabilidad'), c.actualizar);
// Inactivar/reactivar un edificio: exclusivo del Super Admin.
router.patch('/:id/estado', permitirRoles('super_admin'), c.cambiarEstado);

module.exports = router;

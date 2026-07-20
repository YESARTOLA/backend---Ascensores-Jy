const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/ascensoresController');

router.use(verificarToken);

router.get('/', c.listar);
router.get('/:id', c.obtener);
router.get('/:id/historial', c.historial);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador', 'vendedora'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.actualizar);
// Precio de UN subtipo, sin tocar el resto del catálogo del ascensor. Mismos
// roles que crear un plan de mantenimiento, que es desde donde se edita inline.
router.put('/:id/precios', permitirRoles('super_admin', 'admin', 'coordinador'), c.guardarPrecio);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);

module.exports = router;

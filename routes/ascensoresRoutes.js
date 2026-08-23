const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles, soloFinanzas } = require('../middleware/rbacMiddleware');
const c = require('../controllers/ascensoresController');

router.use(verificarToken);

router.get('/', c.listar);
// Antes de '/:id' para que 'exportar' no se interprete como un id.
router.get('/exportar', c.exportar);
router.get('/:id', c.obtener);
router.get('/:id/historial', c.historial);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador', 'vendedora'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.actualizar);
// Precio de UN subtipo, sin tocar el resto del catálogo del ascensor. Se edita
// inline desde el modal de plan de mantenimiento, y solo lo hacen los roles con
// visibilidad financiera: el Coordinador no ve precios, así que tampoco los fija.
router.put('/:id/precios', soloFinanzas, c.guardarPrecio);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);

module.exports = router;

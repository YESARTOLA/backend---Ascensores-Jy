const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/checklistController');

router.use(verificarToken);

router.get('/por-servicio/:id', c.obtenerPorServicio);
router.post('/:id/items', c.agregarItem);
router.put('/items/:id', c.actualizarItem);
router.delete('/items/:id', c.eliminarItem);
router.post('/:id/completar', c.completar);
router.patch('/:id/estado', c.cambiarEstadoChecklist);

module.exports = router;

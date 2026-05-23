const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/recordatoriosController');

router.use(verificarToken);

router.get('/contadores', c.contadores);
router.get('/proximos', c.proximos);
router.patch('/leer-todos', c.marcarTodosLeidos);
router.get('/', c.listar);
router.get('/:id', c.obtener);
router.post('/', c.crear);
router.put('/:id', c.actualizar);
router.patch('/:id/leer', c.marcarLeido);
router.patch('/:id/atender', c.marcarAtendido);
router.patch('/:id/pendiente', c.marcarPendiente);
router.patch('/:id/descartar', c.descartar);
router.delete('/:id', c.eliminar);

module.exports = router;

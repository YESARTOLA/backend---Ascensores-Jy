const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/empresasEmisorasController');

router.use(verificarToken);

router.get('/', c.listar);
router.post('/', c.crear);
router.put('/:id', c.actualizar);
router.delete('/:id', c.eliminar);

module.exports = router;

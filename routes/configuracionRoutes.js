const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/configuracionController');

router.use(verificarToken);

router.get('/', c.listar);
router.get('/:clave', c.obtener);
router.put('/:clave', c.actualizar);

module.exports = router;

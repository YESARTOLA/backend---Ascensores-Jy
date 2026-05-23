const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/checklistFinalizacionController');

router.use(verificarToken);

router.get('/', c.listarPlantillas);
router.get('/:categoria', c.obtenerPlantilla);
router.put('/:categoria', c.actualizarPlantilla);

module.exports = router;

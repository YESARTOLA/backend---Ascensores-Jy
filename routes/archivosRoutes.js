const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { recibirArchivo } = require('../middleware/uploadMiddleware');
const c = require('../controllers/archivosController');

router.use(verificarToken);

// El archivo se streamea al storage dentro del middleware: sin tope de peso y
// sin pasar por la memoria del proceso.
router.post('/', recibirArchivo('archivo'), c.subir);
router.delete('/:id', c.eliminar);

module.exports = router;

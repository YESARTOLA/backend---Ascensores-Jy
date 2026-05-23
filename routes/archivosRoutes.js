const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const c = require('../controllers/archivosController');

router.use(verificarToken);

router.post('/', upload.single('archivo'), c.subir);
router.delete('/:id', c.eliminar);

module.exports = router;

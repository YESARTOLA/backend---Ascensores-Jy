const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/evidenciasGuiasController');

router.use(verificarToken);

router.post('/servicios/:id/evidencias', c.subirEvidencia);
router.get('/servicios/:id/evidencias', c.listarEvidencias);
router.put('/evidencias/:id', c.actualizarEvidencia);
router.delete('/evidencias/:id', c.eliminarEvidencia);

module.exports = router;

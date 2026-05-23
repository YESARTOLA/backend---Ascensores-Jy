const express = require('express');
const router = express.Router();
const { login, me, logout, cambiarContrasena } = require('../controllers/authController');
const verificarToken = require('../middleware/authMiddleware');

router.post('/login', login);
router.get('/me', verificarToken, me);
router.post('/logout', verificarToken, logout);
router.post('/change-password', verificarToken, cambiarContrasena);

module.exports = router;

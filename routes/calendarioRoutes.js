const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/calendarioController');

router.use(verificarToken);
router.get('/', c.listar);
module.exports = router;

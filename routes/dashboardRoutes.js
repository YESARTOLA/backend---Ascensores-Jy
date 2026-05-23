const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/dashboardController');

router.use(verificarToken);
router.get('/', c.resumen);
module.exports = router;

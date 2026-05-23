const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/auditoriaController');

router.use(verificarToken);
router.use(permitirRoles('super_admin', 'admin'));

router.get('/', c.listar);

module.exports = router;

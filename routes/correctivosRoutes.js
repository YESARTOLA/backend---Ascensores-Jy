const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const { requiereAlcance } = require('../utils/alcanceUsuario');
const c = require('../controllers/correctivosController');

router.use(verificarToken);
// Módulo de dominio Servicios: bloqueado para usuarios cuyo ámbito sea solo Proyectos.
router.use(requiereAlcance('servicio'));

router.get('/', c.listar);
router.get('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.obtener);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.actualizar);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);

module.exports = router;

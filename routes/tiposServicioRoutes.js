const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/tiposServicioController');

router.use(verificarToken);

router.get('/catalogos', c.catalogos);
router.get('/', c.listar);
router.post('/', permitirRoles('super_admin'), c.crear);
router.put('/:id', permitirRoles('super_admin'), c.actualizar);
router.patch('/:id/estado', permitirRoles('super_admin'), c.cambiarEstado);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);

// Devuelve la ficha completa de cada técnico vinculado (nombre, documento,
// teléfono), así que se restringe a los roles que gestionan la plantilla: es la
// misma información que tecnicosController ya acota, y sin esto quedaría
// accesible por esta otra puerta.
router.get('/:id/tecnicos', permitirRoles('super_admin', 'admin', 'coordinador'), c.listarTecnicos);
router.post('/:id/tecnicos', permitirRoles('super_admin'), c.vincularTecnico);
router.delete('/:id/tecnicos/:id_tecnico', permitirRoles('super_admin'), c.desvincularTecnico);

module.exports = router;

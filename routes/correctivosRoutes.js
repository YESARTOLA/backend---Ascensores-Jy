const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const { requiereAlcance } = require('../utils/alcanceUsuario');
const { ROLES_GESTION: ROLES_ADJUNTOS } = require('../utils/adjuntosCorrectivo');
const c = require('../controllers/correctivosController');

router.use(verificarToken);
// Módulo de dominio Servicios: bloqueado para usuarios cuyo ámbito sea solo Proyectos.
router.use(requiereAlcance('servicio'));

router.get('/', c.listar);

// Adjuntos de contexto. Declarados ANTES de '/:id' para que Express no capture
// "archivos" como un id. El GET no lleva permitirRoles a propósito (igual que en
// Emergencias): el destinatario es el TÉCNICO asignado, y el controlador acota
// el acceso con la misma visibilidad del listado.
router.get('/:id/archivos', c.listarArchivos);
router.post('/:id/archivos', permitirRoles(...ROLES_ADJUNTOS), c.agregarArchivos);
router.delete('/:id/archivos/:idVinculo', permitirRoles(...ROLES_ADJUNTOS), c.eliminarArchivo);

router.get('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.obtener);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.actualizar);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);

module.exports = router;

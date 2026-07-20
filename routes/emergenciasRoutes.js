const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const { requiereAlcance } = require('../utils/alcanceUsuario');
const { ROLES_GESTION: ROLES_ADJUNTOS } = require('../utils/adjuntosEmergencia');
const c = require('../controllers/emergenciasController');

router.use(verificarToken);
// Módulo de dominio Servicios: bloqueado para usuarios cuyo ámbito sea solo Proyectos.
router.use(requiereAlcance('servicio'));

router.get('/', c.listar);

// Adjuntos de contexto. Declarados ANTES de '/:id' para que Express no capture
// "archivos" como un id.
//
// El GET NO lleva permitirRoles a propósito: el destinatario de estas fotos y
// videos es el TÉCNICO asignado, así que restringirlo a los roles de gestión
// vaciaría la funcionalidad. El acceso se acota en el controlador con la misma
// visibilidad del listado (un técnico solo alcanza sus emergencias asignadas).
router.get('/:id/archivos', c.listarArchivos);
router.post('/:id/archivos', permitirRoles(...ROLES_ADJUNTOS), c.agregarArchivos);
router.delete('/:id/archivos/:idVinculo', permitirRoles(...ROLES_ADJUNTOS), c.eliminarArchivo);

router.get('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.obtener);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador'), c.actualizar);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);

module.exports = router;

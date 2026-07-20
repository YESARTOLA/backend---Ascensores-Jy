const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const { requiereAlcance } = require('../utils/alcanceUsuario');
const c = require('../controllers/mantenimientosController');

router.use(verificarToken);
// Módulo de dominio Servicios: bloqueado para usuarios cuyo ámbito sea solo Proyectos.
router.use(requiereAlcance('servicio'));

router.get('/frecuencias', c.listarFrecuencias);
router.get('/instancias', c.listarInstancias);
router.get('/exportar', permitirRoles('super_admin', 'admin', 'coordinador', 'contabilidad'), c.exportar);
router.get('/', c.listar);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin'), c.actualizar);
router.post(
  '/eventos/:id/crear-servicio',
  permitirRoles('super_admin', 'admin', 'coordinador'),
  c.materializarEvento
);
// Preview del borrado en cascada (solo lectura). Mismo rol que el DELETE: lo
// consulta el modal de confirmación para mostrar el impacto real antes de borrar.
router.get('/:id/impacto-eliminacion', permitirRoles('super_admin'), c.impactoEliminacion);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);

module.exports = router;

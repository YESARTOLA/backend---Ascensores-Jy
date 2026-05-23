const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/cotizacionesController');

router.use(verificarToken);

// Acceso comercial: super_admin, admin, contabilidad pueden ver.
// Solo super_admin y admin pueden crear/editar/aprobar/rechazar.
router.get('/', permitirRoles('super_admin', 'admin', 'contabilidad'), c.listar);
router.get('/:id', permitirRoles('super_admin', 'admin', 'contabilidad'), c.obtener);

router.post('/', permitirRoles('super_admin', 'admin'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin'), c.actualizarCabecera);
router.put('/:id/versiones/:v', permitirRoles('super_admin', 'admin'), c.actualizarVersion);

router.post('/:id/versiones', permitirRoles('super_admin', 'admin'), c.crearNuevaVersion);
router.post('/:id/versiones/:v/aprobar', permitirRoles('super_admin', 'admin'), c.aprobar);
router.post('/:id/versiones/:v/rechazar', permitirRoles('super_admin', 'admin'), c.rechazar);

router.post('/:id/reabrir', permitirRoles('super_admin', 'admin'), c.reabrir);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);

router.get('/:id/versiones/:v/pdf', permitirRoles('super_admin', 'admin', 'contabilidad'), c.generarPdf);

router.post('/:id/archivos', permitirRoles('super_admin', 'admin'), c.agregarArchivo);
router.delete('/:id/archivos/:idAdjunto', permitirRoles('super_admin', 'admin'), c.eliminarArchivo);

module.exports = router;

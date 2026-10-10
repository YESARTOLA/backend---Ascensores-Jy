const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/cobrosController');

router.use(verificarToken);
router.use(permitirRoles('super_admin', 'admin', 'contabilidad'));

router.get('/', c.listar);
router.get('/proyectos', c.listarProyectos);
router.get('/cuotas-calendario', c.cuotasCalendario);
router.get('/cuotas-no-facturadas', c.cuotasNoFacturadas);
router.get('/:id', c.obtener);
router.put('/:id/plan-cuotas', c.actualizarPlanCuotas);
router.post('/:id/pagos', c.registrarPago);
// Corrección de un abono ya registrado (monto, fecha, método, cuenta,
// comprobante, notas): solo Super Admin y Contabilidad.
router.put('/:id/pagos/:idPago', permitirRoles('super_admin', 'contabilidad'), c.editarPago);
router.post('/:id/recordatorio', c.enviarRecordatorio);
router.patch('/:id/cerrar', c.cerrarCobro);
router.patch('/:id/incobrable', c.marcarIncobrable);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);

module.exports = router;

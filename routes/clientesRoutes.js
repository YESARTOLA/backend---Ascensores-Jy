const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/clientesController');

router.use(verificarToken);

router.get('/', c.listar);
router.get('/exportar', c.exportar);
router.get('/tipos-ascensor', c.listarTiposAscensor);
router.get('/clasificaciones', c.listarClasificaciones);
// Búsqueda por documento (RUC/DNI): el wizard de conversión de leads la usa para
// detectar y vincular un cliente existente en vez de crear un duplicado.
router.get('/por-documento/:numero', c.buscarPorDocumento);
router.get('/:id', c.obtener);
router.get('/:id/360', c.vista360);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador', 'vendedora'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador', 'contabilidad'), c.actualizar);
// Registrar un contrato nuevo (renovación) de un área: archiva la vigencia
// anterior en el historial y deja la nueva como vigente.
router.post('/:id/contrato', permitirRoles('super_admin', 'admin', 'coordinador', 'contabilidad'), c.registrarContrato);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);

module.exports = router;

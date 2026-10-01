const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/clientesController');
const clasif = require('../controllers/clasificacionesClienteController');

router.use(verificarToken);

router.get('/', c.listar);
router.get('/exportar', c.exportar);
router.get('/tipos-ascensor', c.listarTiposAscensor);
// Catálogo gestionable de clasificaciones (por área). Se lee desde cualquier rol;
// lo gestionan super_admin y admin, igual que los tipos de ascensor.
router.get('/clasificaciones', clasif.listar);
router.post('/clasificaciones', permitirRoles('super_admin', 'admin'), clasif.crear);
router.put('/clasificaciones/:id', permitirRoles('super_admin', 'admin'), clasif.actualizar);
router.patch('/clasificaciones/:id/estado', permitirRoles('super_admin', 'admin'), clasif.cambiarEstado);
// Búsqueda por documento (RUC/DNI): el wizard de conversión de leads la usa para
// detectar y vincular un cliente existente en vez de crear un duplicado.
router.get('/por-documento/:numero', c.buscarPorDocumento);
router.get('/:id', c.obtener);
router.get('/:id/360', c.vista360);
// Vista previa de lo que arrastra eliminar el cliente (doble confirmación).
router.get('/:id/impacto-eliminacion', permitirRoles('super_admin'), c.impactoEliminacion);
router.post('/', permitirRoles('super_admin', 'admin', 'coordinador', 'vendedora'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin', 'coordinador', 'contabilidad'), c.actualizar);
// Registrar un contrato nuevo (renovación) de un área: archiva la vigencia
// anterior en el historial y deja la nueva como vigente.
router.post('/:id/contrato', permitirRoles('super_admin', 'admin', 'coordinador', 'contabilidad'), c.registrarContrato);
// estado 0 = eliminación lógica en cascada; estado 1 = reactivar. Solo Super
// Admin, igual que eliminar un edificio.
router.patch('/:id/estado', permitirRoles('super_admin'), c.cambiarEstado);

module.exports = router;

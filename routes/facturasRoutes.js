const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/facturasController');

router.use(verificarToken);
router.use(permitirRoles('super_admin', 'admin', 'contabilidad'));

router.get('/', c.listar);
router.get('/:id', c.obtener);
router.post('/', c.crear);
router.patch('/:id/estado', c.cambiarEstado);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);

// Documentos de la factura: el comprobante (si se registró sin él) y los de
// soporte — constancia de detracción, de pago, XML/CDR… (utils/documentosFactura).
router.get('/:id/documentos', c.listarDocumentos);
router.post('/:id/documentos', c.agregarDocumentos);
router.delete('/:id/documentos/:idDocumento', c.eliminarDocumento);
router.patch('/:id/comprobante', c.adjuntarComprobante);

module.exports = router;

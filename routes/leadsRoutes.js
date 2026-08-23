const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const {
  ROLES_ALTA_LEAD,
  ROLES_LECTURA_LEAD,
  ROLES_EDICION_LEAD,
  ROLES_GESTION_LEAD,
  ROLES_CONVERSION_LEAD
} = require('../utils/accesoLeads');
const c = require('../controllers/leadsController');

router.use(verificarToken);

// Los roles permitidos salen de utils/accesoLeads (SSoT del módulo). El alcance
// POR LEAD (la Vendedora solo opera los suyos) lo aplica el controlador.
router.get('/', permitirRoles(...ROLES_LECTURA_LEAD), c.listar);
router.get('/vendedores', permitirRoles(...ROLES_LECTURA_LEAD), c.listarVendedores);
// Catálogo de personas asignables (rutas ANTES de '/:id' para que no las capture).
router.get('/asignables', permitirRoles(...ROLES_LECTURA_LEAD), c.listarAsignables);
// Aviso de prospecto ya registrado mientras se llena el formulario. Lo consulta
// quien da de alta o edita, por eso comparte los roles de edición.
router.get('/duplicados', permitirRoles(...ROLES_EDICION_LEAD), c.verificarDuplicados);
router.post('/', permitirRoles(...ROLES_ALTA_LEAD), c.crear);
router.put('/:id', permitirRoles(...ROLES_EDICION_LEAD), c.actualizar);
router.get('/:id/historial', permitirRoles('super_admin'), c.historial);
router.patch('/:id/estado', permitirRoles(...ROLES_GESTION_LEAD), c.cambiarEstado);
router.post('/:id/convertir', permitirRoles(...ROLES_CONVERSION_LEAD), c.convertir);
router.get('/:id/cotizaciones', permitirRoles(...ROLES_LECTURA_LEAD), c.listarCotizaciones);
router.post('/:id/cotizaciones', permitirRoles(...ROLES_GESTION_LEAD), c.subirCotizacion);
// Documentos libres del lead: los sube la Central de ventas (ROLES_GESTION_LEAD)
// y la Vendedora asignada solo los consulta (ROLES_LECTURA_LEAD).
router.get('/:id/documentos', permitirRoles(...ROLES_LECTURA_LEAD), c.listarDocumentos);
router.post('/:id/documentos', permitirRoles(...ROLES_GESTION_LEAD), c.agregarDocumentos);
router.delete('/:id/documentos/:idVinculo', permitirRoles(...ROLES_GESTION_LEAD), c.eliminarDocumento);

module.exports = router;

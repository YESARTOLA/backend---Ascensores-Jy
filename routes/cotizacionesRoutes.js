const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const { tiposRegistroPermitidos } = require('../utils/alcanceUsuario');
const c = require('../controllers/cotizacionesController');

router.use(verificarToken);

// Blindaje de ámbito por id (evita IDOR): un usuario de área no accede a una
// cotización de la otra área ni por URL, en ninguna de las rutas '/:id'.
async function cotizacionEnAmbito(req, res, next) {
  try {
    // Este middleware se monta como '/:id', así que también captura las rutas
    // de texto sin id ('/exportar', '/catalogos'). Ahí no hay cotización que
    // validar: se deja pasar en vez de buscar un id NaN.
    if (!Number.isInteger(Number(req.params.id))) return next();
    const tipos = tiposRegistroPermitidos(req.user);
    if (!tipos) return next(); // roles sin restricción de ámbito
    const cot = await prisma.tbl_cotizaciones.findUnique({
      where: { id: Number(req.params.id) },
      select: { tipo_servicio: { select: { categoria_funcional: true } } }
    });
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
    const cats = tipos.map(t => (t === 'proyecto' ? 'PROYECTOS' : 'SERVICIOS'));
    if (!cats.includes(cot.tipo_servicio?.categoria_funcional)) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    next();
  } catch (err) {
    console.error('[cotizaciones.cotizacionEnAmbito]', err);
    res.status(500).json({ error: 'Error de verificación de ámbito' });
  }
}
// Aplica el blindaje de ámbito a TODA ruta '/:id...' (get, put, versiones,
// aprobar, rechazar, reabrir, pdf, archivos). Las rutas sin id ('/', 'POST /')
// no se ven afectadas.
router.use('/:id', cotizacionEnAmbito);

// Acceso comercial: super_admin, admin, contabilidad pueden ver. Solo super_admin
// y admin pueden crear/editar/aprobar/rechazar. El middleware cotizacionEnAmbito
// (abajo) restringe además por ámbito a los usuarios acotados a un área.
router.get('/', permitirRoles('super_admin', 'admin', 'contabilidad'), c.listar);
// /exportar y /catalogos deben ir antes de /:id para que no los capture como id.
router.get('/exportar', permitirRoles('super_admin', 'admin', 'contabilidad'), c.exportar);
// Catálogos de estado que alimentan el filtro del listado.
router.get('/catalogos', permitirRoles('super_admin', 'admin', 'contabilidad'), c.catalogos);
// Prellenado de una cotización desde observaciones técnicas (?ids=1,2,3).
// Debe ir antes de /:id para que no lo capture como id. Solo lectura.
router.get('/desde-observaciones', permitirRoles('super_admin', 'admin'), c.desdeObservaciones);
router.get('/desde-emergencia', permitirRoles('super_admin', 'admin'), c.desdeEmergencia);
router.get('/:id', permitirRoles('super_admin', 'admin', 'contabilidad'), c.obtener);
router.get('/:id/historial', permitirRoles('super_admin', 'admin', 'contabilidad'), c.historial);

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

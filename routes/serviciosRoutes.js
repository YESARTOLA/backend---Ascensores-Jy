const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles } = require('../middleware/rbacMiddleware');
const c = require('../controllers/serviciosController');
const obs = require('../controllers/observacionesServicioController');

router.use(verificarToken);

router.get('/realizados', c.realizados);
router.get('/', c.listar);
router.get('/:id', c.obtener);
router.post('/', permitirRoles('super_admin', 'admin'), c.crear);
router.put('/:id', permitirRoles('super_admin', 'admin'), c.actualizar);
router.patch('/:id/duracion', permitirRoles('super_admin', 'admin'), c.cambiarDuracion);
router.patch('/:id/estado', permitirRoles('super_admin', 'admin'), c.cambiarEstado);
router.post('/:id/asignar', permitirRoles('super_admin', 'admin', 'coordinador'), c.asignarTecnicos);
router.post('/:id/iniciar', c.iniciarServicio);
router.post('/:id/finalizar', c.finalizarServicio);
router.post('/:id/cancelar', permitirRoles('super_admin', 'admin'), c.cancelar);
router.delete('/:id', permitirRoles('super_admin'), c.eliminar);
router.post('/:id/promover', permitirRoles('super_admin', 'admin', 'coordinador'), c.promoverBorrador);
router.post('/:id/revisar', permitirRoles('super_admin', 'admin', 'contabilidad'), c.revisarServicio);

// Checklist de finalización de servicio (progresivo: se llena durante "En curso")
const finCk = require('../controllers/checklistFinalizacionController');
router.get('/:idServicio/finalizacion', finCk.obtenerFinalizacion);
router.patch('/:idServicio/finalizacion/items/:idItem', finCk.guardarRespuestaItem);
router.post('/:idServicio/finalizacion/items/:idItem/fotos', finCk.agregarFotoItem);
router.delete('/:idServicio/finalizacion/fotos/:idFoto', finCk.eliminarFotoItem);
router.post('/:idServicio/finalizacion', finCk.generarInforme);

// Observaciones técnicas del servicio
router.get('/:idServicio/observaciones', obs.listar);
router.post('/:idServicio/observaciones', obs.crear);
router.patch('/observaciones/:id/atender', obs.atender);
router.delete('/observaciones/:id', permitirRoles('super_admin', 'admin'), obs.eliminar);

// Gestión de guías de salida. El handler aplica el permiso refinado para
// `tecnico` (solo responsable_documentacion o único técnico). Eliminar queda
// restringido a super_admin/admin.
router.post('/:id/guias', permitirRoles('super_admin', 'admin', 'coordinador', 'tecnico'), c.crearGuia);
router.put('/:id/guias/:guiaId', permitirRoles('super_admin', 'admin', 'coordinador', 'tecnico'), c.actualizarGuia);
router.delete('/:id/guias/:guiaId', permitirRoles('super_admin', 'admin'), c.eliminarGuia);

module.exports = router;

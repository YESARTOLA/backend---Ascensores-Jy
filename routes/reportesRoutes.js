const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const c = require('../controllers/reportesController');

router.use(verificarToken);

router.get('/operativos', c.operativos);
router.get('/cobros', c.cobros);
router.get('/tecnicos', c.tecnicos);
router.get('/leads', c.leads);
router.get('/ascensores', c.ascensores);

router.get('/mantenimientos-vencidos', c.mantenimientosVencidos);
router.get('/mantenimientos-cumplidos', c.mantenimientosCumplidos);
router.get('/mora-por-cliente', c.moraPorCliente);
router.get('/facturados', c.facturados);
router.get('/abonos-registrados', c.abonosRegistrados);
router.get('/emergencias-atendidas', c.emergenciasAtendidas);
router.get('/correctivos', c.correctivos);
router.get('/atenciones-rapidas', c.atencionesRapidas);
router.get('/servicios-finalizados', c.serviciosFinalizados);
router.get('/pendientes-de-cobro', c.pendientesDeCobro);
router.get('/cobros-vencidos', c.cobrosVencidos);
router.get('/historial-tecnico-ascensor', c.historialTecnicoAscensor);
router.get('/mantenimientos-por-cliente', c.mantenimientosPorCliente);
router.get('/mantenimientos-programados-sin-servicio', c.mantenimientosProgramadosSinServicio);
router.get('/ingresos-por-banco', c.ingresosPorBanco);

module.exports = router;

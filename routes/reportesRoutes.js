const express = require('express');
const router = express.Router();
const verificarToken = require('../middleware/authMiddleware');
const { permitirRoles, soloFinanzas } = require('../middleware/rbacMiddleware');
const c = require('../controllers/reportesController');

router.use(verificarToken);

// --- Reportes OPERATIVOS: accesibles a todo rol autenticado -----------------
// (las columnas de importe que puedan traer se sanean en el controlador).
router.get('/operativos', c.operativos);
router.get('/tecnicos', c.tecnicos);
// Leads: el Coordinador los gestiona en su módulo, pero no consulta su reporte.
// Cerrado también aquí y no solo oculto en la UI: esconder una pestaña no impide
// llamar al endpoint.
router.get('/leads', permitirRoles('super_admin', 'admin', 'contabilidad'), c.leads);
router.get('/ascensores', c.ascensores);

router.get('/mantenimientos-vencidos', c.mantenimientosVencidos);
router.get('/mantenimientos-cumplidos', c.mantenimientosCumplidos);
router.get('/emergencias-atendidas', c.emergenciasAtendidas);
router.get('/correctivos', c.correctivos);
router.get('/atenciones-rapidas', c.atencionesRapidas);
router.get('/servicios-finalizados', c.serviciosFinalizados);
router.get('/historial-tecnico-ascensor', c.historialTecnicoAscensor);
router.get('/mantenimientos-por-cliente', c.mantenimientosPorCliente);
router.get('/mantenimientos-programados-sin-servicio', c.mantenimientosProgramadosSinServicio);
router.get('/clientes-estado-edificios', c.clientesEstadoEdificios);

// --- Reportes FINANCIEROS: solo roles con visibilidad económica -------------
// Su contenido ES el dato financiero (cobranza, mora, facturación, ingresos):
// no se pueden sanear por columna, se cierra el endpoint completo. El
// Coordinador no los ve ni en la UI ni por llamada directa a la API.
router.get('/cobros', soloFinanzas, c.cobros);
router.get('/mora-por-cliente', soloFinanzas, c.moraPorCliente);
router.get('/facturados', soloFinanzas, c.facturados);
router.get('/abonos-registrados', soloFinanzas, c.abonosRegistrados);
router.get('/pendientes-de-cobro', soloFinanzas, c.pendientesDeCobro);
router.get('/cobros-vencidos', soloFinanzas, c.cobrosVencidos);
router.get('/ingresos-por-banco', soloFinanzas, c.ingresosPorBanco);

module.exports = router;

const prisma = require('../config/prisma');
const { sincronizarRecordatorioServicio } = require('./recordatoriosAuto');

// Estados nominados que se referencian explícitamente desde la lógica de negocio
// (transiciones de cierre, regularización de guías). Cualquier flujo que cambie
// estos textos debe pasar por aquí.
const ESTADO_SERVICIO_FINALIZADO_TECNICO = 'Finalizado por técnico';
const ESTADO_SERVICIO_FINALIZADO_OBSERVADO = 'Finalizado observado';

/**
 * Catálogo completo de estados que puede tener `tbl_servicios_proyectos.estado_servicio`.
 * Punto único de la verdad — usado por filtros, validaciones y selects.
 */
const ESTADOS_SERVICIO = [
  'Borrador',
  'Pendiente',
  'Asignado',
  'Checklist de salida pendiente',
  'Listo para salida',
  'En camino',
  'En curso',
  ESTADO_SERVICIO_FINALIZADO_TECNICO,
  ESTADO_SERVICIO_FINALIZADO_OBSERVADO,
  'En revisión administrativa',
  'A gestión de cobro',
  'En cobro',
  'Cobrado parcial',
  'Cobrado total',
  'Facturado',
  'Cerrado',
  'Cancelado'
];

/**
 * Estados previos a la salida a campo (pre-ejecución). Mientras un servicio
 * esté en cualquiera de estos estados se permite editar sus datos básicos
 * (cliente, ascensores, precio, fecha, etc.) sin riesgo de romper historial
 * operativo, evidencias, guías, cobros o facturación.
 */
const ESTADOS_SERVICIO_EDITABLES = [
  'Borrador',
  'Pendiente',
  'Asignado',
  'Checklist de salida pendiente',
  'Listo para salida'
];

/**
 * Estados en los que el servicio ya pasó de la fase de ejecución operativa
 * al circuito post-ejecución (administrativo, contable o terminal).
 *
 * Una vez que un servicio entra en cualquiera de estos estados — o en alguno
 * que comience con "Finalizado" — no se deben crear/modificar entregas,
 * evidencias ni guías sobre él (el servicio ya está "finalizado").
 *
 * Punto único de la regla, reutilizado por:
 *  - entregasController (crear / actualizar)
 *  - evidenciasGuiasController (subir / eliminar)
 *  - frontend (Entregas.jsx, ServicioDetalle.jsx) vía utils/estadoServicio.js
 */
const ESTADOS_POST_EJECUCION = [
  'En revisión administrativa',
  'A gestión de cobro',
  'En cobro',
  'Cobrado parcial',
  'Cobrado total',
  'Facturado',
  'Cerrado',
  'Cancelado'
];

function estaServicioFinalizado(estadoServicio) {
  if (!estadoServicio) return false;
  if (estadoServicio.startsWith('Finalizado')) return true;
  return ESTADOS_POST_EJECUCION.includes(estadoServicio);
}

function esServicioEditable(estadoServicio) {
  return ESTADOS_SERVICIO_EDITABLES.includes(estadoServicio);
}

/**
 * El servicio ya entró al flujo post-revisión (administrativa, cobro,
 * facturación, cerrado, cancelado). A partir de aquí no se deben crear,
 * editar ni eliminar guías de salida ni sus observaciones técnicas.
 * Más permisivo que `estaServicioFinalizado` porque deja pasar todavía
 * "Finalizado por técnico" y "Finalizado observado" (regularización).
 */
function esServicioPostRevision(estadoServicio) {
  return ESTADOS_POST_EJECUCION.includes(estadoServicio);
}

// Catálogos de estados de los registros asociados a un servicio.
const ESTADOS_EMERGENCIA = ['Reportada', 'En atención', 'Resuelto', 'Cerrada'];
const ESTADOS_CORRECTIVO = ['Reportado', 'En atención', 'Resuelto', 'Cerrado'];
const ESTADOS_ATENCION_RAPIDA = ['nueva', 'convertida', 'descartada'];

function esEmergenciaCerrada(estado) {
  return estado === 'Cerrada';
}

function esCorrectivoCerrado(estado) {
  return estado === 'Cerrado';
}

function esAtencionRapidaConvertida(estado) {
  return estado === 'convertida';
}

/**
 * Cambia estado_servicio dejando rastro en historial.
 *
 * Si el servicio nació de una cotización, también sincroniza el estado_global
 * de la cotización (Cotizado/Aceptado/Ejecución/Pendiente/Terminado). El
 * require es lazy para evitar ciclos con cotizacionesController.
 */
async function cambiarEstadoServicio(id_servicio, nuevoEstado, idUsuario, observaciones = null) {
  const previo = await prisma.tbl_servicios_proyectos.findUnique({ where: { id: id_servicio } });
  if (!previo || previo.estado_servicio === nuevoEstado) return previo;
  const actualizado = await prisma.tbl_servicios_proyectos.update({
    where: { id: id_servicio },
    data: { estado_servicio: nuevoEstado, user_id_modification: idUsuario, date_time_modification: new Date() }
  });
  await prisma.tbl_servicios_estados_historial.create({
    data: {
      id_servicio,
      estado_anterior: previo.estado_servicio,
      estado_nuevo: nuevoEstado,
      cambiado_por: idUsuario,
      observaciones
    }
  });
  // Sincroniza recordatorio (los estados terminales lo descartan)
  sincronizarRecordatorioServicio(id_servicio).catch(err => console.error('Error sync recordatorio servicio:', err));

  if (previo.id_cotizacion) {
    const { sincronizarEstadoGlobal } = require('../controllers/cotizacionesController');
    sincronizarEstadoGlobal(previo.id_cotizacion).catch(err =>
      console.error('Error sync estado_global cotización:', err));
  }

  return actualizado;
}

/**
 * Determina el estado del servicio según el estado del cobro y facturación.
 *
 * Las comparaciones usan centavos (enteros) en lugar de soles para evitar
 * que residuos de punto flotante (ej. saldo=0.0000000001) hagan que un cobro
 * totalmente pagado se clasifique como "Cobrado parcial".
 */
function estadoServicioDesdeCobro({ estado_cobro, total_abonado, saldo_pendiente, facturado }) {
  const abonadoCents = Math.round(Number(total_abonado || 0) * 100);
  const saldoCents = Math.round(Number(saldo_pendiente || 0) * 100);

  if (estado_cobro === 'Cerrado' && facturado) return 'Cerrado';
  if (facturado && saldoCents === 0) return 'Cerrado';
  if (facturado) return 'Facturado';
  if (saldoCents === 0 && abonadoCents > 0) return 'Cobrado total';
  if (abonadoCents > 0 && saldoCents > 0) return 'Cobrado parcial';
  if (abonadoCents === 0 && saldoCents > 0 && estado_cobro !== 'Pendiente de iniciar') return 'En cobro';
  return 'A gestión de cobro';
}

module.exports = {
  cambiarEstadoServicio,
  estadoServicioDesdeCobro,
  estaServicioFinalizado,
  esServicioEditable,
  esServicioPostRevision,
  esEmergenciaCerrada,
  esCorrectivoCerrado,
  esAtencionRapidaConvertida,
  ESTADO_SERVICIO_FINALIZADO_TECNICO,
  ESTADO_SERVICIO_FINALIZADO_OBSERVADO,
  ESTADOS_SERVICIO,
  ESTADOS_SERVICIO_EDITABLES,
  ESTADOS_POST_EJECUCION,
  ESTADOS_EMERGENCIA,
  ESTADOS_CORRECTIVO,
  ESTADOS_ATENCION_RAPIDA
};

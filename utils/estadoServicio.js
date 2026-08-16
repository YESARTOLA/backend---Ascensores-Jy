const prisma = require('../config/prisma');
const { sincronizarRecordatorioServicio } = require('./recordatoriosAuto');
// Tramos de ejecución en campo (arranque y cierre del trabajo del técnico). Se
// reutilizan aquí para derivar el estado de la emergencia sin repetir la lista.
const {
  ESTADOS_INICIO: ESTADOS_INICIO_EJECUCION,
  ESTADOS_FIN: ESTADOS_FIN_EJECUCION
} = require('./ejecucionFechas');

// Estados nominados que se referencian explícitamente desde la lógica de negocio
// (transiciones de cierre, regularización de guías). Cualquier flujo que cambie
// estos textos debe pasar por aquí.
const ESTADO_SERVICIO_FINALIZADO_TECNICO = 'Finalizado por técnico';
const ESTADO_SERVICIO_FINALIZADO_OBSERVADO = 'Finalizado observado';
const ESTADO_SERVICIO_CANCELADO = 'Cancelado';
// El paso a este estado marca el inicio real del trabajo en obra: su primera
// aparición en el historial es la "fecha de inicio del servicio".
const ESTADO_SERVICIO_EN_CURSO = 'En curso';

/**
 * Catálogo único de `tbl_servicios_realizados.estado_administrativo` — la etapa
 * del servicio dentro del circuito administrativo/contable. Punto único de la
 * verdad para revisión, elegibilidad contable, filtros y selects.
 *
 *  EN_EJECUCION      : servicio recién habilitado (origen cotización) o creado;
 *                      aún no enviado a revisión.
 *  PENDIENTE_REVISION: el técnico finalizó; espera revisión administrativa.
 *  REVISADO          : Administración APROBÓ → habilita gestión contable.
 *  OBSERVADO         : Administración devolvió para corrección (subsanable).
 *  RECHAZADO         : Administración rechazó (requiere rehacer / no procede).
 */
const ESTADO_ADMIN_EN_EJECUCION = 'En ejecución';
const ESTADO_ADMIN_PENDIENTE_REVISION = 'Pendiente revisión';
const ESTADO_ADMIN_REVISADO = 'Revisado';
const ESTADO_ADMIN_OBSERVADO = 'Observado';
const ESTADO_ADMIN_RECHAZADO = 'Rechazado';

const ESTADOS_ADMINISTRATIVOS = [
  ESTADO_ADMIN_EN_EJECUCION,
  ESTADO_ADMIN_PENDIENTE_REVISION,
  ESTADO_ADMIN_REVISADO,
  ESTADO_ADMIN_OBSERVADO,
  ESTADO_ADMIN_RECHAZADO
];

// Resultados posibles de una revisión administrativa (payload de revisarServicio).
const RESULTADO_REVISION = {
  APROBADO: 'aprobado',
  OBSERVADO: 'observado',
  RECHAZADO: 'rechazado'
};

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
/**
 * Estados "en gestión": el servicio está vivo en el flujo operativo, desde que
 * se crea hasta que el técnico lo finaliza (antes de revisión/cobro). Es el
 * universo que lista la pantalla de Asignaciones. Espejo del frontend.
 */
const ESTADOS_SERVICIO_EN_GESTION = [
  'Borrador',
  'Pendiente',
  'Asignado',
  'Checklist de salida pendiente',
  'Listo para salida',
  'En camino',
  'En curso'
];

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
// El estado de la emergencia NO se lleva a mano: lo deriva el servicio que la
// atiende (ver estadoEmergenciaDesdeServicio), así que la lista es también el
// recorrido posible de ese ciclo.
const ESTADOS_EMERGENCIA = ['Reportada', 'En atención', 'Atendida', 'Cerrada', 'Cancelada'];
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
  await registrarCambioEstado(previo, nuevoEstado, idUsuario, observaciones);
  return actualizado;
}

/**
 * Variante ATÓMICA de `cambiarEstadoServicio`: solo cambia el estado si el
 * servicio TODAVÍA está en uno de `estadosEsperados`. Devuelve el servicio
 * actualizado, o `null` si ya no estaba en ese estado (otra petición se
 * adelantó).
 *
 * Existe para cerrar la ventana de carrera de la finalización: leer el estado,
 * validar y después escribir deja pasar dos peticiones simultáneas (doble clic,
 * dos pestañas, reintento de red, dos usuarios a la vez) que finalizaban el
 * mismo servicio dos veces, duplicando guía, evidencias, historial y cobro. El
 * `updateMany` con el estado esperado en el WHERE hace que solo una gane.
 */
async function cambiarEstadoServicioSiEstaEn(id_servicio, estadosEsperados, nuevoEstado, idUsuario, observaciones = null) {
  const previo = await prisma.tbl_servicios_proyectos.findUnique({ where: { id: id_servicio } });
  if (!previo) return null;
  const { count } = await prisma.tbl_servicios_proyectos.updateMany({
    where: { id: id_servicio, estado_servicio: { in: estadosEsperados } },
    data: { estado_servicio: nuevoEstado, user_id_modification: idUsuario, date_time_modification: new Date() }
  });
  if (count === 0) return null;
  await registrarCambioEstado(previo, nuevoEstado, idUsuario, observaciones);
  return prisma.tbl_servicios_proyectos.findUnique({ where: { id: id_servicio } });
}

/**
 * Estado que le corresponde a una emergencia según el servicio que la atiende.
 *
 * La emergencia y su servicio son la misma realidad vista dos veces, así que el
 * estado de la emergencia se DERIVA y no se teclea: antes había que moverlo a
 * mano y se quedaba congelado en "Reportada" / "En atención" aunque el técnico
 * ya hubiera terminado.
 *
 * @param {object|null} servicio       Servicio asociado (null si aún no existe).
 * @param {boolean}     tieneTecnicos  Si ya hay técnicos asignados: distingue
 *                                     "Reportada" (sin nadie) de "En atención".
 */
function estadoEmergenciaDesdeServicio(servicio, { tieneTecnicos = false } = {}) {
  const estado = servicio?.estado_servicio;
  if (!estado) return tieneTecnicos ? 'En atención' : 'Reportada';
  if (estado === ESTADO_SERVICIO_CANCELADO) return 'Cancelada';
  if (estado === 'Cerrado') return 'Cerrada';
  // Todo lo que va de "finalizado por el técnico" en adelante (revisión, cobro,
  // facturación) es trabajo ya atendido en campo.
  if (ESTADOS_FIN_EJECUCION.includes(estado)) return 'Atendida';
  if (ESTADOS_INICIO_EJECUCION.includes(estado)) return 'En atención';
  return tieneTecnicos ? 'En atención' : 'Reportada';
}

/**
 * Alinea el estado de la emergencia de un servicio con su estado real. No hace
 * nada si el servicio no viene de una emergencia o si ya estaba al día.
 */
async function sincronizarEstadoEmergencia(idServicio) {
  const emergencia = await prisma.tbl_emergencias.findFirst({
    where: { id_servicio: idServicio, estado: 1 },
    select: { id: true, estado_emergencia: true }
  });
  if (!emergencia) return null;

  const servicio = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    select: { estado_servicio: true }
  });
  const tieneTecnicos = await prisma.tbl_servicios_asignaciones.count({
    where: { id_servicio: idServicio, estado: 1 }
  }) > 0;

  const nuevo = estadoEmergenciaDesdeServicio(servicio, { tieneTecnicos });
  if (nuevo === emergencia.estado_emergencia) return emergencia.estado_emergencia;

  await prisma.tbl_emergencias.update({
    where: { id: emergencia.id },
    data: { estado_emergencia: nuevo, date_time_modification: new Date() }
  });
  return nuevo;
}

// Historial + sincronizaciones que acompañan a todo cambio de estado.
async function registrarCambioEstado(previo, nuevoEstado, idUsuario, observaciones) {
  await prisma.tbl_servicios_estados_historial.create({
    data: {
      id_servicio: previo.id,
      estado_anterior: previo.estado_servicio,
      estado_nuevo: nuevoEstado,
      cambiado_por: idUsuario,
      observaciones
    }
  });
  // Sincroniza recordatorio (los estados terminales lo descartan)
  sincronizarRecordatorioServicio(previo.id).catch(err => console.error('Error sync recordatorio servicio:', err));

  // Si el servicio nació de una emergencia, su estado sigue al del servicio.
  sincronizarEstadoEmergencia(previo.id).catch(err =>
    console.error('Error sync estado_emergencia:', err));

  if (previo.id_cotizacion) {
    const { sincronizarEstadoGlobal } = require('../controllers/cotizacionesController');
    sincronizarEstadoGlobal(previo.id_cotizacion).catch(err =>
      console.error('Error sync estado_global cotización:', err));
  }
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
  cambiarEstadoServicioSiEstaEn,
  estadoServicioDesdeCobro,
  estaServicioFinalizado,
  esServicioEditable,
  esServicioPostRevision,
  esEmergenciaCerrada,
  estadoEmergenciaDesdeServicio,
  sincronizarEstadoEmergencia,
  esCorrectivoCerrado,
  esAtencionRapidaConvertida,
  ESTADO_SERVICIO_FINALIZADO_TECNICO,
  ESTADO_SERVICIO_FINALIZADO_OBSERVADO,
  ESTADO_SERVICIO_CANCELADO,
  ESTADO_SERVICIO_EN_CURSO,
  ESTADOS_SERVICIO,
  ESTADOS_SERVICIO_EDITABLES,
  ESTADOS_SERVICIO_EN_GESTION,
  ESTADOS_POST_EJECUCION,
  ESTADOS_EMERGENCIA,
  ESTADOS_CORRECTIVO,
  ESTADOS_ATENCION_RAPIDA,
  ESTADO_ADMIN_EN_EJECUCION,
  ESTADO_ADMIN_PENDIENTE_REVISION,
  ESTADO_ADMIN_REVISADO,
  ESTADO_ADMIN_OBSERVADO,
  ESTADO_ADMIN_RECHAZADO,
  ESTADOS_ADMINISTRATIVOS,
  RESULTADO_REVISION
};

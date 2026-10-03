const prisma = require('../config/prisma');
const { sincronizarRecordatorioServicio } = require('./recordatoriosAuto');
const { esFacturado } = require('./estadoFactura');
// Estados de atención de emergencias y correctivos (En atención / Atendida /
// Cancelada), derivados del servicio. Se reexportan para no mover los imports.
const {
  ESTADOS_EMERGENCIA,
  ESTADOS_CORRECTIVO,
  estadoEmergenciaDesdeServicio,
  estadoCorrectivoDesdeServicio,
  esEmergenciaCerrada,
  esCorrectivoCerrado
} = require('./estadoAtencion');

// Estados nominados que se referencian explícitamente desde la lógica de negocio
// (transiciones de cierre, regularización de guías). Cualquier flujo que cambie
// estos textos debe pasar por aquí.
const ESTADO_SERVICIO_PENDIENTE = 'Pendiente';
// Asignado = tiene técnico Y fecha programada. Las dos condiciones a la vez: un
// servicio con técnico pero sin fecha (o al revés) no está listo para ejecutarse
// y se queda en Pendiente.
const ESTADO_SERVICIO_ASIGNADO = 'Asignado';
// El paso a este estado marca el inicio real del trabajo en obra: su primera
// aparición en el historial es la "fecha de inicio del servicio". Ya no se
// teclea: lo dispara el primer registro que hace el técnico sobre el servicio
// (evidencia, guía, OT, observación o respuesta del checklist de finalización).
const ESTADO_SERVICIO_EN_CURSO = 'En curso';
// Cierre del trabajo de campo, siempre manual. Único: un cierre sin guía no es
// otro estado sino una guía en estado "Observada" — la deuda documental se lee
// de la guía, que es donde se resuelve.
const ESTADO_SERVICIO_FINALIZADO = 'Finalizado';
const ESTADO_SERVICIO_CANCELADO = 'Cancelado';

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
  ESTADO_SERVICIO_PENDIENTE,
  ESTADO_SERVICIO_ASIGNADO,
  ESTADO_SERVICIO_EN_CURSO,
  ESTADO_SERVICIO_FINALIZADO,
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
  ESTADO_SERVICIO_PENDIENTE,
  ESTADO_SERVICIO_ASIGNADO
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
  ESTADO_SERVICIO_PENDIENTE,
  ESTADO_SERVICIO_ASIGNADO,
  ESTADO_SERVICIO_EN_CURSO
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

/**
 * ¿El servicio cuenta como REALIZADO (trabajo ejecutado en campo)?
 *
 * Igual que `estaServicioFinalizado` pero excluye 'Cancelado': un servicio
 * cancelado está en post-ejecución para el candado operativo, pero el trabajo
 * NO se hizo. Es el criterio del avance de los planes de mantenimiento
 * (visitas realizadas del mes) — espejo de utils/ejecucionFechas.estadoEjecucion.
 */
function estaServicioRealizado(estadoServicio) {
  return estadoServicio !== ESTADO_SERVICIO_CANCELADO && estaServicioFinalizado(estadoServicio);
}

function esServicioEditable(estadoServicio) {
  return ESTADOS_SERVICIO_EDITABLES.includes(estadoServicio);
}

/**
 * El servicio ya entró al flujo post-revisión (administrativa, cobro,
 * facturación, cerrado, cancelado). A partir de aquí no se deben crear,
 * editar ni eliminar guías de salida ni sus observaciones técnicas.
 * Más permisivo que `estaServicioFinalizado` porque deja pasar todavía
 * "Finalizado" (ahí es donde se regulariza una guía que faltaba).
 */
function esServicioPostRevision(estadoServicio) {
  return ESTADOS_POST_EJECUCION.includes(estadoServicio);
}

// Catálogo de estados de la atención rápida. Los de emergencias y correctivos
// viven en utils/estadoAtencion.js.
const ESTADOS_ATENCION_RAPIDA = ['nueva', 'convertida', 'descartada'];

function esAtencionRapidaConvertida(estado) {
  return estado === 'convertida';
}

/**
 * Cambia estado_servicio dejando rastro en historial.
 *
 * Si el servicio nació de una cotización, también sincroniza el estado_global
 * de la cotización (Cotizado/Aceptado/Ejecución/Por cobrar/Terminado). El
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
 * Alinea el estado de la emergencia o del correctivo de un servicio con su
 * estado real (ver utils/estadoAtencion.js). La emergencia / el correctivo y su
 * servicio son la misma realidad vista dos veces, así que su estado se DERIVA y
 * no se teclea. No hace nada si el servicio no viene de esos módulos o si ya
 * estaba al día.
 */
async function sincronizarEstadoAtencion(idServicio) {
  const servicio = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    select: { estado_servicio: true }
  });
  if (!servicio) return;
  const emergencia = estadoEmergenciaDesdeServicio(servicio);
  const correctivo = estadoCorrectivoDesdeServicio(servicio);
  const ahora = new Date();
  await prisma.tbl_emergencias.updateMany({
    where: { id_servicio: idServicio, estado: 1, estado_emergencia: { not: emergencia } },
    data: { estado_emergencia: emergencia, date_time_modification: ahora }
  });
  await prisma.tbl_correctivos.updateMany({
    where: { id_servicio: idServicio, estado: 1, estado_correctivo: { not: correctivo } },
    data: { estado_correctivo: correctivo, date_time_modification: ahora }
  });
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

  // Si el servicio nació de una emergencia o de un correctivo, su estado sigue
  // al del servicio.
  sincronizarEstadoAtencion(previo.id).catch(err =>
    console.error('Error sync estado de emergencia/correctivo:', err));

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

/**
 * Estados del circuito de cobro: el servicio ya pasó la revisión administrativa
 * y su estado lo dicta el cobro (estadoServicioDesdeCobro). 'Cerrado' queda
 * fuera: es terminal.
 */
const ESTADOS_SERVICIO_EN_COBRO = [
  'A gestión de cobro',
  'En cobro',
  'Cobrado parcial',
  'Cobrado total',
  'Facturado'
];

/**
 * Estado que dicta el cobro de un servicio SI ese cobro ya tuvo movimiento
 * (algún abono o la facturación completa); null si no lo tuvo.
 *
 * Un servicio de cotización es cobrable desde que se aprueba, así que el
 * adelanto puede estar pagado y facturado antes de que el técnico termine. Al
 * aprobarse la revisión el servicio iba siempre a 'A gestión de cobro' y, como
 * ya no llegaba ningún abono que lo moviera, se quedaba ahí para siempre. Sin
 * movimiento, en cambio, quien llama decide (normalmente 'A gestión de cobro').
 */
function estadoServicioPorMovimientoDeCobro({ cobro, estadoFacturacion }) {
  if (!cobro || cobro.estado === 0) return null;
  const facturado = esFacturado(estadoFacturacion);
  const abonado = Math.round(Number(cobro.total_abonado || 0) * 100) > 0;
  if (!abonado && !facturado) return null;
  return estadoServicioDesdeCobro({
    estado_cobro: cobro.estado_cobro,
    total_abonado: cobro.total_abonado,
    saldo_pendiente: cobro.saldo_pendiente,
    facturado
  });
}

/**
 * Realinea un servicio que ya está en cobro con su cobro, cuando el saldo cambió
 * sin pasar por un abono ni una factura (p.ej. se reestructuró el plan de cuotas
 * o se ajustó el monto variable), y recalcula el estado_global de su
 * cotización, que depende del saldo. No toca servicios que aún no llegaron a
 * cobros: esos los mueve su flujo operativo.
 */
async function resincronizarServicioConCobro(idServicio, idUsuario, observaciones = null) {
  if (!idServicio) return;
  const servicio = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    select: {
      estado_servicio: true,
      id_cotizacion: true,
      cobro: { select: { estado: true, estado_cobro: true, total_abonado: true, saldo_pendiente: true } },
      servicio_realizado: { select: { estado_facturacion: true } }
    }
  });
  if (!servicio) return;
  if (ESTADOS_SERVICIO_EN_COBRO.includes(servicio.estado_servicio)) {
    const destino = estadoServicioPorMovimientoDeCobro({
      cobro: servicio.cobro,
      estadoFacturacion: servicio.servicio_realizado?.estado_facturacion
    });
    if (destino && destino !== servicio.estado_servicio) {
      await cambiarEstadoServicio(idServicio, destino, idUsuario, observaciones);
    }
  }
  if (servicio.id_cotizacion) {
    const { sincronizarEstadoGlobal } = require('../controllers/cotizacionesController');
    await sincronizarEstadoGlobal(servicio.id_cotizacion);
  }
}

module.exports = {
  cambiarEstadoServicio,
  cambiarEstadoServicioSiEstaEn,
  estadoServicioDesdeCobro,
  estadoServicioPorMovimientoDeCobro,
  resincronizarServicioConCobro,
  ESTADOS_SERVICIO_EN_COBRO,
  estaServicioFinalizado,
  estaServicioRealizado,
  esServicioEditable,
  esServicioPostRevision,
  esEmergenciaCerrada,
  estadoEmergenciaDesdeServicio,
  estadoCorrectivoDesdeServicio,
  sincronizarEstadoAtencion,
  esCorrectivoCerrado,
  esAtencionRapidaConvertida,
  ESTADO_SERVICIO_PENDIENTE,
  ESTADO_SERVICIO_ASIGNADO,
  ESTADO_SERVICIO_EN_CURSO,
  ESTADO_SERVICIO_FINALIZADO,
  ESTADO_SERVICIO_CANCELADO,
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

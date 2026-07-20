/**
 * Baja lógica de un ascensor y su cascada sobre los planes de mantenimiento.
 *
 * Igual que el resto del sistema, NO hay borrado físico: todo es estado = 0 y
 * por tanto recuperable. Este módulo centraliza qué le pasa a los planes cuando
 * un ascensor deja de estar activo (sea por desactivarlo directamente o porque
 * se desactivó su edificio).
 *
 * Reglas (acordadas con negocio):
 *  - El ascensor pasa a estado = 0.
 *  - Se quita el ascensor (fila puente) de cada plan activo que lo cubra. Las
 *    materializaciones futuras del plan ya lo excluyen porque leen la junction
 *    con estado = 1 (ver materializarSiguienteEventoDelPlan).
 *  - Si el plan aún cubre otro ascensor activo, SIGUE vigente para esos.
 *  - Si el plan se queda sin ningún ascensor activo, se elimina lógicamente:
 *      · servicios generados PENDIENTES (no ejecutados y sin abonos) → baja en
 *        cascada vía el motor de reversión.
 *      · servicios ya ejecutados o con abonos → se CONSERVAN como historial
 *        (no se tocan); el plan solo deja de estar activo.
 *      · eventos de calendario futuros (aún sin servicio) y recordatorios del
 *        plan → cancelados.
 *      · plan → estado = 0, estado_plan = 'cancelado'.
 *
 * No hace commit ni purga Wasabi: el llamador envuelve esto en su propio
 * $transaction y, tras el commit, invoca purgarObjetosWasabi(wasabiKeys) y
 * liberarTecnicos(tecnicoIds, -1).
 *
 * @returns {{ wasabiKeys: string[], tecnicoIds: number[], planesEliminados: number[] }}
 */

const { registrarAuditoria } = require('./auditoria');
const { ESTADO_EVENTO_CANCELADO } = require('./estadoEvento');
const { estaServicioFinalizado } = require('./estadoServicio');
const { ESTADO_PLAN_CANCELADO } = require('./estadoPlanMantenimiento');
const { bajaServicioCascadaEnTx } = require('./reversionEliminacion');

// Un servicio generado se preserva como historial (no se revierte) cuando ya
// fue ejecutado o tiene algún abono registrado.
function servicioEsHistorial(servicio) {
  if (estaServicioFinalizado(servicio.estado_servicio)) return true;
  const cobro = servicio.cobro;
  if (cobro && (Number(cobro.total_abonado) > 0 || (cobro.pagos || []).length > 0)) return true;
  return false;
}

// Include mínimo que necesita `desafectarAscensoresDeServicioEnTx` para decidir:
// el cobro (para saber si hay abonos) y las filas puente activas (para saber si
// el servicio se queda sin objetivo). Compartido por todos los llamadores para
// que la consulta y la regla no se desincronicen.
const INCLUDE_SERVICIO_DESAFECTACION = {
  cobro: { include: { pagos: { where: { estado: 1 } } } },
  ascensores: { where: { estado: 1 } }
};

/**
 * REGLA ÚNICA: qué le pasa a un servicio activo cuando uno o más de sus
 * ascensores dejan de estar activos. La aplican por igual la baja de un
 * ascensor (vía su plan) y la baja de un edificio completo.
 *
 *  - Servicio ejecutado o con abonos → intacto (historial), SALVO que el llamador
 *    pida `incluirHistorial`. Devuelve 'conservado'.
 *  - Ninguno de sus ascensores está en la baja → intacto. Devuelve 'sin_cambio'.
 *  - TODOS sus ascensores activos entran en la baja → el servicio queda sin
 *    objetivo y se revierte por completo, incluida su cadena de cobro y
 *    facturación. Devuelve 'baja'.
 *  - Quedan otros ascensores → se dan de baja solo esas filas puente y el precio
 *    se recalcula como la suma de los ascensores restantes (mismo criterio que la
 *    materialización de ocurrencias futuras del plan). Devuelve 'recalculado'.
 *
 * Un servicio pendiente aún no tiene cobro (se crea al finalizar), así que en el
 * recálculo no hay pagos que redistribuir. Por eso un servicio YA cobrado nunca
 * se recalcula aunque se pida `incluirHistorial`: recalcular su precio dejaría el
 * cobro descuadrado. Si sigue vivo es porque también cubre otro edificio.
 *
 * @param {object}   servicio  fila cargada con INCLUDE_SERVICIO_DESAFECTACION.
 * @param {number[]} idsAscensoresBaja  ascensores que se están dando de baja.
 * @param {object}   opciones  { incluirHistorial: arrastrar también los servicios
 *                   ejecutados o cobrados; lo usa la eliminación de un edificio,
 *                   donde no debe sobrevivir nada del edificio eliminado }.
 * @returns {'conservado'|'sin_cambio'|'baja'|'recalculado'}
 */
async function desafectarAscensoresDeServicioEnTx(
  tx, servicio, idsAscensoresBaja, userId, stamp, wasabiKeys, tecnicoIds, { incluirHistorial = false } = {}
) {
  const esHistorial = servicioEsHistorial(servicio);
  if (esHistorial && !incluirHistorial) return 'conservado';

  const enBaja = new Set(idsAscensoresBaja);
  const filas = servicio.ascensores.filter(a => enBaja.has(a.id_ascensor));
  if (filas.length === 0) return 'sin_cambio';

  if (filas.length === servicio.ascensores.length) {
    const r = await bajaServicioCascadaEnTx(tx, servicio.id, userId);
    wasabiKeys.push(...r.wasabiKeys);
    tecnicoIds.push(...r.tecnicoIds);
    return 'baja';
  }

  // Sobrevive porque también cubre ascensores de otro edificio.
  if (esHistorial) return 'conservado';

  const idsFilas = filas.map(f => f.id);
  await tx.tbl_servicios_ascensores.updateMany({
    where: { id: { in: idsFilas } }, data: { estado: 0, ...stamp }
  });
  const nuevoPrecio = servicio.ascensores
    .filter(a => !idsFilas.includes(a.id))
    .reduce((acc, a) => acc + Number(a.monto), 0);
  await tx.tbl_servicios_proyectos.update({
    where: { id: servicio.id },
    data: { precio_interno: nuevoPrecio, ...stamp }
  });
  return 'recalculado';
}

// Aplica la regla anterior a los servicios de un plan que sigue vigente para
// otros ascensores: solo hay que sacar al ascensor de los pendientes ya
// materializados.
async function quitarAscensorDeServiciosPendientes(tx, idPlan, idAscensor, userId, stamp, wasabiKeys, tecnicoIds) {
  const servicios = await tx.tbl_servicios_proyectos.findMany({
    where: { id_mantenimiento_plan: idPlan, estado: 1 },
    include: INCLUDE_SERVICIO_DESAFECTACION
  });
  for (const s of servicios) {
    await desafectarAscensoresDeServicioEnTx(tx, s, [idAscensor], userId, stamp, wasabiKeys, tecnicoIds);
  }
}

// Elimina lógicamente un plan que se quedó sin ascensores activos, preservando
// los servicios con historial (ejecutados / con abonos).
async function eliminarPlanSinAscensores(tx, idPlan, userId, ip, stamp, wasabiKeys, tecnicoIds) {
  const plan = await tx.tbl_mantenimientos_planes.findUnique({ where: { id: idPlan } });
  if (!plan || plan.estado === 0) return;

  const serviciosGenerados = await tx.tbl_servicios_proyectos.findMany({
    where: { id_mantenimiento_plan: idPlan, estado: 1 },
    include: { cobro: { include: { pagos: { where: { estado: 1 } } } } }
  });

  // Servicios pendientes (sin historial) → baja en cascada. Los ejecutados o
  // con abonos quedan intactos como historial.
  for (const s of serviciosGenerados) {
    if (servicioEsHistorial(s)) continue;
    const r = await bajaServicioCascadaEnTx(tx, s.id, userId);
    wasabiKeys.push(...r.wasabiKeys);
    tecnicoIds.push(...r.tecnicoIds);
  }

  // Eventos futuros aún sin servicio materializado + recordatorios del plan.
  // Los eventos ligados a servicios ejecutados NO se tocan (son historial).
  await tx.tbl_calendario_eventos.updateMany({
    where: { id_mantenimiento_plan: idPlan, id_servicio: null, estado: 1 },
    data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, ...stamp }
  });
  await tx.tbl_recordatorios.updateMany({
    where: { id_mantenimiento_plan: idPlan, estado: 1 },
    data: { estado: 0, ...stamp }
  });

  const planActualizado = await tx.tbl_mantenimientos_planes.update({
    where: { id: idPlan },
    data: { estado: 0, estado_plan: ESTADO_PLAN_CANCELADO, ...stamp }
  });
  await registrarAuditoria({
    id_usuario: userId, entidad: 'tbl_mantenimientos_planes', id_entidad: idPlan,
    accion: 'DELETE', valor_anterior: plan, valor_nuevo: planActualizado, ip
  });
}

async function bajaAscensorCascadaEnTx(tx, idAscensor, userId, ip) {
  const wasabiKeys = [];
  const tecnicoIds = [];
  const planesEliminados = [];
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };

  const ascensor = await tx.tbl_ascensores.findUnique({ where: { id: idAscensor } });
  if (!ascensor || ascensor.estado === 0) return { wasabiKeys, tecnicoIds, planesEliminados };

  // 1) Baja lógica del ascensor. `estado_operativo` pasa a 'Inactivo' para que
  //    ambos campos queden consistentes (la ficha del ascensor y la vista 360 lo
  //    muestran igual). Reactivar el edificio NO lo devuelve a operativo: al
  //    reabrirse no hay garantía de su estado real, así que debe verificarse y
  //    cambiarse manualmente desde 'Inactivo' al que corresponda.
  await tx.tbl_ascensores.update({ where: { id: idAscensor }, data: { estado: 0, estado_operativo: 'Inactivo', ...stamp } });

  // 2) Planes activos que cubren este ascensor (vía junction activa).
  const enlaces = await tx.tbl_mantenimientos_planes_ascensores.findMany({
    where: { id_ascensor: idAscensor, estado: 1, plan: { estado: 1 } },
    select: { id: true, id_plan: true }
  });

  for (const enlace of enlaces) {
    // Quitar el ascensor del plan.
    await tx.tbl_mantenimientos_planes_ascensores.update({
      where: { id: enlace.id }, data: { estado: 0, ...stamp }
    });
    // ¿El plan aún cubre otro ascensor activo?
    const restantes = await tx.tbl_mantenimientos_planes_ascensores.count({
      where: { id_plan: enlace.id_plan, estado: 1 }
    });
    if (restantes > 0) {
      // El plan sigue vigente para los demás: solo hay que sacar al ascensor de
      // los servicios pendientes ya materializados.
      await quitarAscensorDeServiciosPendientes(tx, enlace.id_plan, idAscensor, userId, stamp, wasabiKeys, tecnicoIds);
      continue;
    }
    // 3) Plan sin ascensores → eliminación lógica conservando historial.
    await eliminarPlanSinAscensores(tx, enlace.id_plan, userId, ip, stamp, wasabiKeys, tecnicoIds);
    planesEliminados.push(enlace.id_plan);
  }

  return { wasabiKeys, tecnicoIds, planesEliminados };
}

module.exports = {
  bajaAscensorCascadaEnTx,
  desafectarAscensoresDeServicioEnTx,
  servicioEsHistorial,
  INCLUDE_SERVICIO_DESAFECTACION
};

/**
 * TÉCNICO DEL PLAN DE MANTENIMIENTO
 *
 * El plan lleva un técnico (`tbl_mantenimientos_planes.id_tecnico`) que se
 * asigna a TODOS sus servicios:
 *   - a cada servicio que nace al materializar una visita del cronograma, y
 *   - a los ya creados que aún no empezaron, cuando se elige o cambia el técnico
 *     del plan.
 *
 * Cada servicio guarda su propia asignación (tbl_servicios_asignaciones), así
 * que se puede cambiar a mano desde el servicio. Esos cambios manuales se
 * respetan: al cambiar el técnico del plan solo se tocan los servicios sin
 * técnico o cuyo único técnico es el que tenía el plan.
 */
const prisma = require('../config/prisma');
const {
  ESTADO_SERVICIO_PENDIENTE,
  ESTADO_SERVICIO_ASIGNADO,
  cambiarEstadoServicio
} = require('./estadoServicio');

// Mismo rol que elige el formulario de asignación del servicio para el titular.
const ROL_TECNICO_PLAN = 'Responsable principal';

// Fase previa a la ejecución: lo único que el técnico del plan puede reasignar.
// Lo que ya salió a campo (o terminó) conserva a quien lo hizo.
const ESTADOS_REASIGNABLES = [ESTADO_SERVICIO_PENDIENTE, ESTADO_SERVICIO_ASIGNADO];

/**
 * Valida el técnico que llega por API para el plan.
 * @returns {Promise<{ ok: true, id: number|null } | { ok: false, error: string }>}
 */
async function resolverTecnicoPlan(db, valor) {
  if (valor === undefined || valor === null || valor === '') return { ok: true, id: null };
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Técnico del plan inválido' };
  const tecnico = await db.tbl_tecnicos.findUnique({ where: { id }, select: { estado: true } });
  if (!tecnico || tecnico.estado !== 1) return { ok: false, error: 'El técnico elegido para el plan no está disponible' };
  return { ok: true, id };
}

/**
 * Id del técnico del plan si sigue activo; null si el plan no tiene o el
 * técnico fue dado de baja (el servicio nace sin técnico, como antes).
 */
async function tecnicoActivoDelPlan(db, plan) {
  if (!plan?.id_tecnico) return null;
  const tecnico = await db.tbl_tecnicos.findUnique({ where: { id: plan.id_tecnico }, select: { estado: true } });
  return tecnico?.estado === 1 ? plan.id_tecnico : null;
}

/** Datos de la asignación del técnico del plan (sin `id_servicio`). */
function datosAsignacionTecnicoPlan(idTecnico, userId) {
  return {
    id_tecnico: idTecnico,
    rol_asignacion: ROL_TECNICO_PLAN,
    responsable_principal: 1,
    responsable_documentacion: 1,
    asignado_por: userId,
    user_id_registration: userId
  };
}

/**
 * Lleva el técnico del plan a sus servicios aún no iniciados. Un servicio:
 *   - sin técnico → recibe el del plan;
 *   - cuyo único técnico es el anterior del plan → pasa al nuevo;
 *   - con otro técnico o con varios → se respeta (se cambió a mano).
 * Si el servicio ya tiene fecha, pasa a «Asignado» (técnico + fecha).
 *
 * Se ejecuta DESPUÉS de guardar el plan: el cambio de estado deja rastro en el
 * historial con `cambiarEstadoServicio`, que trabaja fuera de transacción.
 *
 * @returns {Promise<number>} cuántos servicios recibieron el técnico
 */
async function propagarTecnicoDelPlan({ idPlan, idTecnicoAnterior, idTecnicoNuevo, userId }) {
  if (!idTecnicoNuevo) return 0;
  const servicios = await prisma.tbl_servicios_proyectos.findMany({
    where: { id_mantenimiento_plan: idPlan, estado: 1, estado_servicio: { in: ESTADOS_REASIGNABLES } },
    select: {
      id: true, estado_servicio: true, fecha_programada: true,
      asignaciones: { where: { estado: 1 }, select: { id_tecnico: true } }
    }
  });

  let actualizados = 0;
  for (const s of servicios) {
    const actuales = s.asignaciones.map(a => a.id_tecnico);
    const sinTecnico = actuales.length === 0;
    const delPlanAnterior = actuales.length === 1 && !!idTecnicoAnterior && actuales[0] === idTecnicoAnterior;
    if (!sinTecnico && !delPlanAnterior) continue;
    if (actuales.length === 1 && actuales[0] === idTecnicoNuevo) continue;

    const ahora = new Date();
    await prisma.$transaction(async (tx) => {
      if (delPlanAnterior) {
        await tx.tbl_servicios_asignaciones.updateMany({
          where: { id_servicio: s.id, id_tecnico: idTecnicoAnterior, estado: 1 },
          data: { estado: 0, user_id_modification: userId, date_time_modification: ahora }
        });
      }
      const { user_id_registration, ...datos } = datosAsignacionTecnicoPlan(idTecnicoNuevo, userId);
      await tx.tbl_servicios_asignaciones.upsert({
        where: { id_servicio_id_tecnico: { id_servicio: s.id, id_tecnico: idTecnicoNuevo } },
        update: { ...datos, estado: 1, estado_asignacion: 'activa', user_id_modification: userId, date_time_modification: ahora },
        create: { id_servicio: s.id, ...datos, user_id_registration }
      });
    });
    if (s.estado_servicio === ESTADO_SERVICIO_PENDIENTE && s.fecha_programada) {
      await cambiarEstadoServicio(s.id, ESTADO_SERVICIO_ASIGNADO, userId, 'Técnico del plan de mantenimiento');
    }
    actualizados++;
  }
  return actualizados;
}

module.exports = {
  ROL_TECNICO_PLAN,
  resolverTecnicoPlan,
  tecnicoActivoDelPlan,
  datosAsignacionTecnicoPlan,
  propagarTecnicoDelPlan
};

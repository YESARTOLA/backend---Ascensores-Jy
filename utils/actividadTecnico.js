/**
 * "En curso" no se teclea: lo enciende el trabajo real del técnico.
 *
 * Antes había que pulsar un botón para poner el servicio en curso, y el estado
 * se quedaba atrás cuando el técnico empezaba a registrar cosas sin acordarse de
 * marcarlo. Ahora el primer registro que hace sobre el servicio —una evidencia,
 * la guía de salida, la OT, una observación técnica o una respuesta del
 * checklist de finalización— es lo que lo mueve a "En curso".
 *
 * La promoción es de una sola dirección y solo desde la fase previa
 * (Pendiente / Asignado): un servicio ya finalizado o dentro del circuito
 * administrativo nunca retrocede porque alguien regularice un documento.
 *
 * Llamarla es "avisar de que hubo actividad"; si no corresponde promover, no
 * hace nada. Nunca lanza: un fallo aquí no debe tumbar la acción del técnico
 * que la disparó (subir una foto no puede fallar porque el estado no se movió).
 */

const prisma = require('../config/prisma');
const {
  cambiarEstadoServicio,
  ESTADO_SERVICIO_PENDIENTE,
  ESTADO_SERVICIO_ASIGNADO,
  ESTADO_SERVICIO_EN_CURSO
} = require('./estadoServicio');

// Estados desde los que un registro del técnico enciende la ejecución.
const ESTADOS_PROMOVIBLES = [ESTADO_SERVICIO_PENDIENTE, ESTADO_SERVICIO_ASIGNADO];

/**
 * @param {number} idServicio
 * @param {number} idUsuario  quien registró (queda en el historial de estados)
 * @param {string} motivo     qué lo disparó, p. ej. 'Evidencia cargada'
 * @returns {Promise<boolean>} true si el servicio pasó a "En curso"
 */
async function registrarActividadTecnico(idServicio, idUsuario, motivo = 'Registro del técnico') {
  try {
    const id = Number(idServicio);
    if (!Number.isFinite(id)) return false;

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id },
      select: {
        id: true, estado_servicio: true, tipo_registro: true, id_tipo_servicio: true,
        asignaciones: { where: { estado: 1 }, select: { id_tecnico: true } }
      }
    });
    if (!servicio || !ESTADOS_PROMOVIBLES.includes(servicio.estado_servicio)) return false;

    await cambiarEstadoServicio(id, ESTADO_SERVICIO_EN_CURSO, idUsuario, motivo);

    // El checklist de finalización acompaña la ejecución: se crea al arrancar
    // para que el técnico lo vaya completando. Si la plantilla de la categoría no
    // tiene ítems, no se crea y el panel avisa; no debe frenar nada.
    try {
      // Lazy: checklistFinalizacionController importa utilidades que a su vez
      // llegan hasta aquí, y el require en cabecera cerraría el ciclo.
      const { ensureChecklistFinalizacion } = require('../controllers/checklistFinalizacionController');
      await ensureChecklistFinalizacion(prisma, servicio, idUsuario);
    } catch (err) {
      console.error('[actividadTecnico] checklist de finalización:', err.message);
    }

    // Los técnicos asignados pasan a "En servicio" mientras dura la ejecución.
    for (const a of servicio.asignaciones) {
      await prisma.tbl_tecnicos.update({
        where: { id: a.id_tecnico },
        data: { estado_operativo: 'En servicio' }
      }).catch(err => console.error('[actividadTecnico] estado del técnico:', err.message));
    }
    return true;
  } catch (err) {
    console.error('[actividadTecnico] no se pudo poner el servicio en curso:', err.message);
    return false;
  }
}

module.exports = { registrarActividadTecnico, ESTADOS_PROMOVIBLES };

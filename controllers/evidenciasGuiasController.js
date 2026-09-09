const prisma = require('../config/prisma');
const { registrarActividadTecnico } = require('../utils/actividadTecnico');
const { registrarAuditoria } = require('../utils/auditoria');
const { estaServicioFinalizado } = require('../utils/estadoServicio');
const { esRolGestion, motivoBloqueo } = require('../utils/registrosTecnico');

/**
 * ¿Está este técnico asignado al servicio?
 *
 * Las evidencias son el expediente fotográfico de UN ascensor: en un plan de
 * mantenimiento cada ascensor tiene su propio servicio y su propio álbum, y el
 * técnico de un ascensor no tiene nada que hacer en el del otro. Sin esta
 * comprobación, cualquier técnico autenticado podía subir, editar o borrar
 * fotos del servicio de otro ascensor pasando su id por la URL (el listado se
 * las oculta, pero el endpoint no las protegía).
 *
 * Basta con estar asignado —no hace falta ser el responsable documental—:
 * cualquiera del equipo que está en obra toma fotos. Registrar la OT sí exige
 * ser responsable documental, y eso lo controla `guardarOt` con su propio
 * criterio.
 */
function tecnicoAsignado(user, asignaciones) {
  return (asignaciones || []).some(a => a.id_tecnico === user.id_tecnico && a.estado !== 0);
}

/**
 * SECCIONES del álbum de evidencias (columna `momento`).
 *
 *  - 'Antes' / 'Despues': el trabajo del técnico en obra. Los sube el técnico
 *    asignado y los corrigen los roles de gestión (ver registrosTecnico.js).
 *  - 'Coordinacion': registro propio de la Oficina Técnica, separado del
 *    expediente del técnico. TODOS los que acceden al servicio lo ven, pero
 *    solo Coordinador y Super Admin lo cargan, editan o eliminan.
 *
 * `momento` NULL = sin clasificar (legado, fotos de ítem del checklist o del
 * cierre); la UI las muestra junto a las de 'Despues'.
 */
const MOMENTO_COORDINACION = 'Coordinacion';
const MOMENTOS_VALIDOS = ['Antes', 'Despues', MOMENTO_COORDINACION];
const ERROR_MOMENTO = `Momento inválido (use ${MOMENTOS_VALIDOS.join(', ')})`;

// Quién puede escribir en la sección de Coordinación. El Super Admin entra
// porque es el rol que destraba cualquier caso; Admin y Contabilidad NO, aunque
// gestionen el resto del expediente: esta sección es del Coordinador.
const ROLES_EVIDENCIA_COORDINACION = ['coordinador', 'super_admin'];
const puedeEscribirCoordinacion = (user) =>
  ROLES_EVIDENCIA_COORDINACION.includes(user?.rol_codigo);

/**
 * Guardián de la sección de Coordinación: devuelve el mensaje de rechazo, o
 * null si la operación está permitida. Se consulta tanto por el momento que
 * llega en el payload como por el de la evidencia ya guardada, de modo que
 * ningún otro rol pueda crear, mover, editar ni borrar fotos de esa sección.
 */
function motivoBloqueoCoordinacion(user, momento, accion) {
  if (momento !== MOMENTO_COORDINACION) return null;
  if (puedeEscribirCoordinacion(user)) return null;
  return `La sección "Evidencias · Coordinación" es del Coordinador: no tiene permiso para ${accion} en ella`;
}

const subirEvidencia = async (req, res) => {
  try {
    const id_servicio = Number(req.params.id);
    const { id_archivo, tipo_evidencia, descripcion, id_dia, momento } = req.body;
    // Momento del trabajo al que pertenece la evidencia. Opcional; si viene debe
    // ser uno de los valores canónicos. NULL = sin clasificar.
    let momentoNorm = null;
    if (momento !== undefined && momento !== null && momento !== '') {
      if (!MOMENTOS_VALIDOS.includes(momento)) {
        return res.status(400).json({ error: ERROR_MOMENTO });
      }
      momentoNorm = momento;
    }
    // La sección de Coordinación se comprueba ANTES que nada: no depende de la
    // asignación al servicio ni del rol de gestión, sino del rol autorizado.
    const bloqueoSeccion = motivoBloqueoCoordinacion(req.user, momentoNorm, 'subir evidencias');
    if (bloqueoSeccion) return res.status(403).json({ error: bloqueoSeccion });
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: id_servicio }, include: { asignaciones: { where: { estado: 1 } } }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    // El técnico sube evidencias mientras ejecuta; los roles de gestión pueden
    // además completarlas después, hasta la revisión administrativa (ver
    // utils/registrosTecnico.js).
    if (esRolGestion(req.user)) {
      const bloqueo = motivoBloqueo(req.user, servicio, 'subir evidencias');
      if (bloqueo) return res.status(400).json({ error: bloqueo });
    } else if (req.user.rol_codigo !== 'tecnico' || !tecnicoAsignado(req.user, servicio.asignaciones)) {
      // El expediente de este ascensor solo lo carga quien trabaja en él.
      return res.status(404).json({ error: 'Servicio no encontrado' });
    } else if (estaServicioFinalizado(servicio.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${servicio.estado_servicio}: no se puede subir evidencias` });
    }
    // La evidencia se atribuye al técnico que la tomó. Si la carga un rol de
    // gestión, queda a nombre del técnico asignado (que es de quien es el trabajo).
    const id_tecnico = req.user.id_tecnico || servicio.asignaciones[0]?.id_tecnico;
    if (!id_tecnico) {
      return res.status(400).json({
        error: 'La evidencia se registra a nombre del técnico del servicio: asigne un técnico antes de subir fotos'
      });
    }

    // Día del servicio al que pertenece la evidencia (servicios multidía). Opcional;
    // si viene, debe ser un día activo de ESTE servicio.
    let idDia = null;
    if (id_dia !== undefined && id_dia !== null && id_dia !== '') {
      const dia = await prisma.tbl_servicios_dias.findFirst({
        where: { id: Number(id_dia), id_servicio, estado: 1 }
      });
      if (!dia) return res.status(400).json({ error: 'El día indicado no pertenece al servicio' });
      idDia = dia.id;
    }

    const evidencia = await prisma.tbl_servicios_evidencias.create({
      data: {
        id_servicio, id_tecnico,
        id_dia: idDia,
        id_archivo: id_archivo || null,
        tipo_evidencia: tipo_evidencia || 'Foto',
        descripcion: descripcion || null,
        momento: momentoNorm,
        user_id_registration: req.user.id
      }
    });
    // Subir evidencia es trabajo en obra: enciende "En curso" si el servicio
    // seguía en Pendiente/Asignado.
    await registrarActividadTecnico(id_servicio, req.user.id, 'Evidencia cargada');
    res.status(201).json({ data: evidencia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir evidencia' });
  }
};

const listarEvidencias = async (req, res) => {
  try {
    const id_servicio = Number(req.params.id);
    // Un técnico solo ve el álbum del ascensor que le tocó: mismo criterio que
    // el detalle del servicio (serviciosController.obtener).
    if (req.user.rol_codigo === 'tecnico') {
      const servicio = await prisma.tbl_servicios_proyectos.findUnique({
        where: { id: id_servicio },
        select: { id: true, asignaciones: { where: { estado: 1 }, select: { id_tecnico: true } } }
      });
      if (!servicio || !tecnicoAsignado(req.user, servicio.asignaciones)) {
        return res.status(404).json({ error: 'Servicio no encontrado' });
      }
    }
    const list = await prisma.tbl_servicios_evidencias.findMany({
      where: { id_servicio, estado: 1 },
      include: { archivo: true, tecnico: true },
      orderBy: { id: 'desc' }
    });
    res.json({ data: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar evidencias' });
  }
};

// Registra/edita el comentario (descripción) de una evidencia ya subida. Pensado
// para el flujo "adjuntar la foto primero, escribir el comentario después".
const actualizarEvidencia = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { descripcion, id_archivo, momento } = req.body;
    const previa = await prisma.tbl_servicios_evidencias.findUnique({
      where: { id },
      include: {
        servicio: {
          select: {
            estado_servicio: true,
            asignaciones: { where: { estado: 1 }, select: { id_tecnico: true } }
          }
        }
      }
    });
    if (!previa) return res.status(404).json({ error: 'Evidencia no encontrada' });
    if (previa.estado === 0) return res.status(400).json({ error: 'Evidencia eliminada' });
    // Sección de Coordinación: se protege la foto que YA está ahí (para que otro
    // rol no la edite ni la saque de la sección) y el destino al que se la
    // quiere mover (para que no la meta ahí quien no puede escribir en ella).
    const bloqueoOrigen = motivoBloqueoCoordinacion(req.user, previa.momento, 'editar evidencias');
    if (bloqueoOrigen) return res.status(403).json({ error: bloqueoOrigen });
    const bloqueoDestino = motivoBloqueoCoordinacion(req.user, momento, 'mover evidencias');
    if (bloqueoDestino) return res.status(403).json({ error: bloqueoDestino });
    if (esRolGestion(req.user)) {
      const bloqueo = motivoBloqueo(req.user, previa.servicio, 'editar evidencias');
      if (bloqueo) return res.status(400).json({ error: bloqueo });
    } else if (req.user.rol_codigo !== 'tecnico' || !tecnicoAsignado(req.user, previa.servicio?.asignaciones)) {
      // Foto del expediente de otro ascensor: ni se edita ni se confirma que exista.
      return res.status(404).json({ error: 'Evidencia no encontrada' });
    } else if (estaServicioFinalizado(previa.servicio?.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${previa.servicio.estado_servicio}: no se puede editar evidencias` });
    }
    // La sección es parte de lo que puede haberse cargado mal.
    let momentoNorm;
    if (momento !== undefined) {
      if (momento === null || momento === '') momentoNorm = null;
      else if (MOMENTOS_VALIDOS.includes(momento)) momentoNorm = momento;
      else return res.status(400).json({ error: ERROR_MOMENTO });
    }
    const evidencia = await prisma.tbl_servicios_evidencias.update({
      where: { id },
      data: {
        descripcion: (descripcion ?? '').trim() || null,
        // Reemplazo de la foto: solo si el payload lo trae, para que una
        // edición de comentario no borre el archivo por omitirlo.
        ...(id_archivo !== undefined ? { id_archivo: id_archivo ? Number(id_archivo) : null } : {}),
        ...(momento !== undefined ? { momento: momentoNorm } : {}),
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_evidencias', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previa, valor_nuevo: evidencia, ip: req.ip
    });
    res.json({ data: evidencia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar evidencia' });
  }
};

const eliminarEvidencia = async (req, res) => {
  try {
    // Coordinación revisa el material antes de pasarlo a Administración, así que
    // también retira una foto mal tomada o duplicada.
    if (!esRolGestion(req.user) && req.user.rol_codigo !== 'tecnico') {
      return res.status(403).json({ error: 'No tiene permiso para eliminar evidencias' });
    }
    const id = Number(req.params.id);
    const previa = await prisma.tbl_servicios_evidencias.findUnique({
      where: { id },
      include: {
        archivo: true,
        servicio: {
          select: {
            estado_servicio: true,
            asignaciones: { where: { estado: 1 }, select: { id_tecnico: true } }
          }
        }
      }
    });
    if (!previa) return res.status(404).json({ error: 'Evidencia no encontrada' });
    if (previa.estado === 0) return res.status(400).json({ error: 'Evidencia ya eliminada' });
    // Si otro rol pudiera borrarlas, el control de la sección sería aparente.
    const bloqueoSeccion = motivoBloqueoCoordinacion(req.user, previa.momento, 'eliminar evidencias');
    if (bloqueoSeccion) return res.status(403).json({ error: bloqueoSeccion });
    if (esRolGestion(req.user)) {
      const bloqueo = motivoBloqueo(req.user, previa.servicio, 'eliminar evidencias');
      if (bloqueo) return res.status(400).json({ error: bloqueo });
    } else if (!tecnicoAsignado(req.user, previa.servicio?.asignaciones)) {
      // Foto del expediente de otro ascensor.
      return res.status(404).json({ error: 'Evidencia no encontrada' });
    } else if (estaServicioFinalizado(previa.servicio?.estado_servicio)) {
      return res.status(400).json({ error: `El servicio está ${previa.servicio.estado_servicio}: no se puede eliminar evidencias` });
    }

    await prisma.tbl_servicios_evidencias.update({
      where: { id },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_evidencias', id_entidad: id,
      accion: 'DELETE', valor_anterior: previa, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar evidencia' });
  }
};

module.exports = { subirEvidencia, listarEvidencias, actualizarEvidencia, eliminarEvidencia };

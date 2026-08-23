/**
 * Checklist de finalización de servicio — PROGRESIVO.
 *
 * El checklist se llena DURANTE la ejecución (estado "En curso"), ítem por ítem:
 * el técnico marca cada ítem (Sí / No / N/A + nota) y, cuando marca "Sí", adjunta
 * al menos una foto. Cada foto se guarda como una evidencia ligada a la respuesta
 * (tbl_servicios_evidencias.id_respuesta) y puede llevar lat/long para verificar
 * la ubicación. Al cerrar el servicio se genera el PDF del informe con las fotos
 * junto a cada ítem.
 *
 * Endpoints:
 *  - GET    /checklist-plantillas                         → lista de plantillas activas
 *  - GET    /checklist-plantillas/:categoria              → plantilla + items por categoría
 *  - PUT    /checklist-plantillas/:categoria              → reemplazo de items (super_admin/admin)
 *  - GET    /servicios/:id/finalizacion                   → checklist + respuestas + fotos (panel)
 *  - PATCH  /servicios/:id/finalizacion/items/:idItem     → guarda/actualiza la respuesta de un ítem
 *  - POST   /servicios/:id/finalizacion/items/:idItem/fotos → adjunta una foto al ítem
 *  - DELETE /servicios/:id/finalizacion/fotos/:idFoto     → quita una foto del ítem
 *  - POST   /servicios/:id/finalizacion                   → genera el informe PDF (al cerrar)
 *
 * Reglas de categoría: el servicio pertenece a:
 *   'emergencia'   si está vinculado a tbl_emergencias
 *   'correctivo'   si está vinculado a tbl_correctivos
 *   'mantenimiento' (default) — incluye mantenimientos programados y servicios sueltos
 */
const prisma = require('../config/prisma');
const { registrarActividadTecnico } = require('../utils/actividadTecnico');
const { esRolGestion, motivoBloqueo } = require('../utils/registrosTecnico');
const { registrarAuditoria } = require('../utils/auditoria');
const { generarInformeFinalizacionPdf, descargarArchivoImagen } = require('../utils/informeServicioPdf');
const { subirObjeto, rutaDesdeKey, urlPresigned, keyDesdeRuta } = require('../utils/storage');
const { construirKey } = require('../middleware/uploadMiddleware');
const { derivarEjecucion } = require('../utils/ejecucionFechas');
const { estaServicioFinalizado } = require('../utils/estadoServicio');

const CATEGORIAS_VALIDAS = ['mantenimiento', 'correctivo', 'emergencia'];
const RESPUESTAS_VALIDAS = ['si', 'no', 'na'];
const ROLES_EDIT_PLANTILLA = ['super_admin', 'admin'];

function categoriaDeServicio(servicio) {
  if (servicio.emergencia) return 'emergencia';
  if (servicio.correctivo) return 'correctivo';
  return 'mantenimiento';
}

/**
 * ¿El usuario puede EDITAR el checklist de este servicio?
 * Técnico responsable de documentación (o único técnico asignado) y admin/super_admin.
 */
/**
 * Ventana temporal para tocar el checklist:
 *   · técnico  → solo mientras el servicio está "En curso" (lo llena en obra);
 *   · gestión  → también después, hasta la revisión administrativa, para
 *     corregir lo que quedó mal (ver utils/registrosTecnico.js).
 * Devuelve el motivo del bloqueo, o null si se puede.
 */
function motivoVentanaChecklist(user, servicio) {
  if (esRolGestion(user)) {
    return motivoBloqueo(user, servicio, 'editar el checklist');
  }
  return servicio.estado_servicio === 'En curso'
    ? null
    : 'El servicio debe estar en curso para editar el checklist';
}

function puedeEditarChecklist(user, servicio) {
  // Coordinación revisa y corrige el material del técnico antes de pasarlo a
  // Administración; el corte por estado lo aplica el llamador (más abajo).
  if (esRolGestion(user)) return true;
  if (user.rol_codigo !== 'tecnico') return false;
  const asignaciones = servicio.asignaciones || [];
  const asig = asignaciones.find(a => a.id_tecnico === user.id_tecnico);
  if (!asig) return false;
  return asig.responsable_documentacion === 1 || asignaciones.length === 1;
}

/**
 * Garantiza que exista la instancia de checklist de finalización del servicio,
 * usando la plantilla activa de su categoría. Idempotente.
 * @returns {Promise<{ checklist:object, plantilla:object, categoria:string }|null>}
 *          null si la plantilla de la categoría no tiene ítems configurados.
 */
async function ensureChecklistFinalizacion(db, servicio, userId) {
  const categoria = categoriaDeServicio(servicio);
  const plantilla = await db.tbl_checklist_plantillas.findUnique({
    where: { categoria },
    include: { items: { where: { estado: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] } }
  });
  if (!plantilla || plantilla.items.length === 0) return null;

  let checklist = await db.tbl_servicios_finalizacion_checklist.findUnique({
    where: { id_servicio: servicio.id }
  });
  if (!checklist) {
    checklist = await db.tbl_servicios_finalizacion_checklist.create({
      data: {
        id_servicio: servicio.id,
        id_plantilla: plantilla.id,
        user_id_registration: userId
      }
    });
  }
  return { checklist, plantilla, categoria };
}

const SELECT_ARCHIVO = { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true };

const listarPlantillas = async (_req, res) => {
  try {
    const plantillas = await prisma.tbl_checklist_plantillas.findMany({
      where: { estado: 1 },
      orderBy: { categoria: 'asc' },
      include: {
        _count: { select: { items: { where: { estado: 1 } } } }
      }
    });
    res.json({ data: plantillas });
  } catch (err) {
    console.error('[checklistFinalizacion.listarPlantillas]', err);
    res.status(500).json({ error: 'Error al listar plantillas' });
  }
};

const obtenerPlantilla = async (req, res) => {
  try {
    const categoria = String(req.params.categoria || '').toLowerCase();
    if (!CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ error: 'Categoría inválida' });
    }
    const plantilla = await prisma.tbl_checklist_plantillas.findUnique({
      where: { categoria },
      include: {
        items: { where: { estado: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] }
      }
    });
    if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json({ data: plantilla });
  } catch (err) {
    console.error('[checklistFinalizacion.obtenerPlantilla]', err);
    res.status(500).json({ error: 'Error al obtener plantilla' });
  }
};

const actualizarPlantilla = async (req, res) => {
  try {
    if (!ROLES_EDIT_PLANTILLA.includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const categoria = String(req.params.categoria || '').toLowerCase();
    if (!CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ error: 'Categoría inválida' });
    }
    const { titulo, descripcion, items, activa } = req.body || {};
    const itemsLimpios = Array.isArray(items) ? items
      .map((it, i) => ({
        grupo: it?.grupo ? String(it.grupo).trim().substring(0, 80) || null : null,
        texto: String(it?.texto || '').trim(),
        orden: Number.isFinite(Number(it?.orden)) ? Number(it.orden) : (i + 1)
      }))
      .filter(it => it.texto.length > 0)
      : [];

    const plantilla = await prisma.$transaction(async (tx) => {
      const existente = await tx.tbl_checklist_plantillas.findUnique({ where: { categoria } });
      const data = {
        titulo: typeof titulo === 'string' && titulo.trim() ? titulo.trim() : (existente?.titulo || `Checklist · ${categoria}`),
        descripcion: typeof descripcion === 'string' ? (descripcion.trim() || null) : (existente?.descripcion || null),
        activa: activa === undefined ? (existente?.activa ?? 1) : (activa ? 1 : 0)
      };
      const cabecera = existente
        ? await tx.tbl_checklist_plantillas.update({
            where: { categoria },
            data: { ...data, user_id_modification: req.user.id, date_time_modification: new Date() }
          })
        : await tx.tbl_checklist_plantillas.create({
            data: { ...data, categoria, user_id_registration: req.user.id }
          });

      // Reemplazo del set ACTIVO de ítems. No se borran físicamente: las
      // respuestas de checklists ya finalizados (tbl_servicios_finalizacion_respuestas)
      // referencian estos ítems por id; un DELETE viola la FK (P2003) e impediría
      // editar la plantilla en cuanto algún servicio la haya usado —y además
      // perdería el histórico de lo que respondió el técnico. En su lugar se
      // desactivan (estado 0) los ítems vigentes y se crean los nuevos activos.
      await tx.tbl_checklist_plantilla_items.updateMany({
        where: { id_plantilla: cabecera.id, estado: 1 },
        data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
      });
      for (const it of itemsLimpios) {
        await tx.tbl_checklist_plantilla_items.create({
          data: {
            id_plantilla: cabecera.id,
            grupo: it.grupo,
            texto: it.texto,
            orden: it.orden,
            user_id_registration: req.user.id
          }
        });
      }
      return tx.tbl_checklist_plantillas.findUnique({
        where: { id: cabecera.id },
        include: { items: { where: { estado: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] } }
      });
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_checklist_plantillas', id_entidad: plantilla.id,
      accion: 'UPDATE', valor_nuevo: { categoria, items: itemsLimpios.length }, ip: req.ip
    });
    res.json({ data: plantilla });
  } catch (err) {
    console.error('[checklistFinalizacion.actualizarPlantilla]', err);
    res.status(500).json({ error: 'Error al guardar plantilla' });
  }
};

const SERVICIO_INCLUDE_PERMISO = {
  asignaciones: { where: { estado: 1 } },
  emergencia: { select: { id: true } },
  correctivo: { select: { id: true } }
};

/**
 * Carga el checklist de finalización completo para el panel del frontend:
 * plantilla (items ordenados/agrupados), respuestas por ítem y sus fotos
 * (con archivo, lat/long y día). En estado "En curso" lo crea si no existe.
 */
const obtenerFinalizacion = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio },
      include: SERVICIO_INCLUDE_PERMISO
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });

    const categoria = categoriaDeServicio(servicio);
    const plantilla = await prisma.tbl_checklist_plantillas.findUnique({
      where: { categoria },
      include: { items: { where: { estado: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] } }
    });

    const puedeEditar = puedeEditarChecklist(req.user, servicio)
      && !motivoVentanaChecklist(req.user, servicio);

    // Crear el checklist al vuelo si el servicio está en curso y hay plantilla.
    if (!plantilla || plantilla.items.length === 0) {
      return res.json({ data: { categoria, plantilla_vacia: true, plantilla: null, checklist: null, respuestas: {}, puede_editar: puedeEditar } });
    }
    if (servicio.estado_servicio === 'En curso') {
      const existe = await prisma.tbl_servicios_finalizacion_checklist.findUnique({ where: { id_servicio: idServicio } });
      if (!existe && (puedeEditar || ['super_admin', 'admin'].includes(req.user.rol_codigo))) {
        await ensureChecklistFinalizacion(prisma, servicio, req.user.id);
      }
    }

    const checklist = await prisma.tbl_servicios_finalizacion_checklist.findUnique({
      where: { id_servicio: idServicio },
      include: {
        archivo_pdf: { select: SELECT_ARCHIVO },
        respuestas: {
          where: { estado: 1 },
          include: {
            fotos: {
              where: { estado: 1 },
              orderBy: { id: 'asc' },
              include: { archivo: { select: SELECT_ARCHIVO } }
            }
          }
        }
      }
    });

    // Mapa id_item → respuesta (con fotos) para consumo directo del panel.
    const respuestas = {};
    for (const r of (checklist?.respuestas || [])) {
      respuestas[r.id_item] = {
        id: r.id,
        respuesta: r.respuesta,
        nota: r.nota || '',
        fotos: r.fotos.map(f => ({
          id: f.id,
          id_archivo: f.id_archivo,
          archivo: f.archivo,
          latitud: f.latitud,
          longitud: f.longitud,
          id_dia: f.id_dia
        }))
      };
    }

    res.json({
      data: {
        categoria,
        plantilla: { id: plantilla.id, titulo: plantilla.titulo, items: plantilla.items },
        checklist: checklist
          ? { id: checklist.id, id_archivo_pdf: checklist.id_archivo_pdf, archivo_pdf: checklist.archivo_pdf }
          : null,
        respuestas,
        puede_editar: puedeEditar
      }
    });
  } catch (err) {
    console.error('[checklistFinalizacion.obtenerFinalizacion]', err);
    res.status(500).json({ error: 'Error al obtener checklist de finalización' });
  }
};

/** Guarda/actualiza la respuesta (si/no/na + nota) de un ítem. Upsert. */
const guardarRespuestaItem = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const idItem = Number(req.params.idItem);
    const respuesta = String(req.body?.respuesta || '').toLowerCase();
    const nota = req.body?.nota ? String(req.body.nota).trim().substring(0, 1000) : null;
    if (!RESPUESTAS_VALIDAS.includes(respuesta)) {
      return res.status(400).json({ error: 'Respuesta inválida (esperado: si | no | na)' });
    }

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio }, include: SERVICIO_INCLUDE_PERMISO
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (!puedeEditarChecklist(req.user, servicio)) {
      return res.status(403).json({ error: 'Solo el técnico responsable puede completar el checklist' });
    }
    const bloqueoVentana = motivoVentanaChecklist(req.user, servicio);
    if (bloqueoVentana) return res.status(400).json({ error: bloqueoVentana });

    const ctx = await ensureChecklistFinalizacion(prisma, servicio, req.user.id);
    if (!ctx) return res.status(400).json({ error: 'La plantilla de checklist no tiene ítems. Pídale a un administrador que la configure.' });

    const item = ctx.plantilla.items.find(it => it.id === idItem);
    if (!item) return res.status(400).json({ error: 'El ítem no pertenece al checklist de este servicio' });

    const respuestaGuardada = await prisma.tbl_servicios_finalizacion_respuestas.upsert({
      where: { id_checklist_id_item: { id_checklist: ctx.checklist.id, id_item: idItem } },
      update: { respuesta, nota, estado: 1, user_id_modification: req.user.id, date_time_modification: new Date() },
      create: { id_checklist: ctx.checklist.id, id_item: idItem, respuesta, nota, user_id_registration: req.user.id },
      include: { fotos: { where: { estado: 1 }, include: { archivo: { select: SELECT_ARCHIVO } } } }
    });

    await registrarActividadTecnico(idServicio, req.user.id, 'Checklist de finalización actualizado');
    res.json({ data: respuestaGuardada });
  } catch (err) {
    console.error('[checklistFinalizacion.guardarRespuestaItem]', err);
    res.status(500).json({ error: 'Error al guardar la respuesta del ítem' });
  }
};

/** Adjunta una foto (evidencia ligada a la respuesta) a un ítem. */
const agregarFotoItem = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const idItem = Number(req.params.idItem);
    const { id_archivo, id_dia, latitud, longitud } = req.body || {};

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio }, include: SERVICIO_INCLUDE_PERMISO
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (!puedeEditarChecklist(req.user, servicio)) {
      return res.status(403).json({ error: 'Solo el técnico responsable puede completar el checklist' });
    }
    const bloqueoVentana = motivoVentanaChecklist(req.user, servicio);
    if (bloqueoVentana) return res.status(400).json({ error: bloqueoVentana });

    const idArchivo = Number(id_archivo);
    if (!Number.isFinite(idArchivo) || idArchivo <= 0) {
      return res.status(400).json({ error: 'Debe adjuntar un archivo válido' });
    }
    const archivo = await prisma.tbl_archivos.findUnique({ where: { id: idArchivo }, select: { id: true, mime_type: true } });
    if (!archivo) return res.status(400).json({ error: 'Archivo no encontrado' });
    if (!String(archivo.mime_type || '').startsWith('image/')) {
      return res.status(400).json({ error: 'La evidencia del ítem debe ser una imagen' });
    }

    const ctx = await ensureChecklistFinalizacion(prisma, servicio, req.user.id);
    if (!ctx) return res.status(400).json({ error: 'La plantilla de checklist no tiene ítems.' });
    if (!ctx.plantilla.items.some(it => it.id === idItem)) {
      return res.status(400).json({ error: 'El ítem no pertenece al checklist de este servicio' });
    }

    const respuesta = await prisma.tbl_servicios_finalizacion_respuestas.findUnique({
      where: { id_checklist_id_item: { id_checklist: ctx.checklist.id, id_item: idItem } }
    });
    if (!respuesta) {
      return res.status(400).json({ error: 'Marque el ítem antes de adjuntar una foto' });
    }

    // Día del servicio (multidía). Opcional; si viene, debe pertenecer al servicio.
    let idDia = null;
    if (id_dia !== undefined && id_dia !== null && id_dia !== '') {
      const dia = await prisma.tbl_servicios_dias.findFirst({
        where: { id: Number(id_dia), id_servicio: idServicio, estado: 1 }
      });
      if (!dia) return res.status(400).json({ error: 'El día indicado no pertenece al servicio' });
      idDia = dia.id;
    }

    const lat = latitud === undefined || latitud === null || latitud === '' ? null : Number(latitud);
    const lng = longitud === undefined || longitud === null || longitud === '' ? null : Number(longitud);
    const latOk = lat !== null && Number.isFinite(lat) && lat >= -90 && lat <= 90;
    const lngOk = lng !== null && Number.isFinite(lng) && lng >= -180 && lng <= 180;

    const idTecnico = req.user.id_tecnico || servicio.asignaciones[0]?.id_tecnico;
    if (!idTecnico) return res.status(400).json({ error: 'No hay técnico asignado' });

    const foto = await prisma.tbl_servicios_evidencias.create({
      data: {
        id_servicio: idServicio,
        id_tecnico: idTecnico,
        id_dia: idDia,
        id_respuesta: respuesta.id,
        id_archivo: idArchivo,
        tipo_evidencia: 'Foto',
        latitud: latOk && lngOk ? lat : null,
        longitud: latOk && lngOk ? lng : null,
        user_id_registration: req.user.id
      },
      include: { archivo: { select: SELECT_ARCHIVO } }
    });

    res.status(201).json({ data: foto });
  } catch (err) {
    console.error('[checklistFinalizacion.agregarFotoItem]', err);
    res.status(500).json({ error: 'Error al adjuntar la foto del ítem' });
  }
};

/** Quita (baja lógica) una foto de un ítem del checklist. */
const eliminarFotoItem = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const idFoto = Number(req.params.idFoto);

    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio }, include: SERVICIO_INCLUDE_PERMISO
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (!puedeEditarChecklist(req.user, servicio)) {
      return res.status(403).json({ error: 'Solo el técnico responsable puede completar el checklist' });
    }
    const bloqueoVentana = motivoVentanaChecklist(req.user, servicio);
    if (bloqueoVentana) return res.status(400).json({ error: bloqueoVentana });

    const foto = await prisma.tbl_servicios_evidencias.findFirst({
      where: { id: idFoto, id_servicio: idServicio, estado: 1, id_respuesta: { not: null } }
    });
    if (!foto) return res.status(404).json({ error: 'Foto no encontrada' });

    await prisma.tbl_servicios_evidencias.update({
      where: { id: idFoto },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[checklistFinalizacion.eliminarFotoItem]', err);
    res.status(500).json({ error: 'Error al quitar la foto del ítem' });
  }
};

/**
 * Genera el informe PDF del servicio a partir del checklist ya completado
 * progresivamente. Valida completitud (todos respondidos + cada "Sí" con ≥1 foto)
 * y enlaza el PDF al checklist. Se invoca al cerrar el servicio.
 */
/**
 * Pie de una foto en el informe: SOLO el comentario y la fecha en que se
 * registró. El nombre del archivo se omite a propósito — es un dato del
 * almacenamiento, no del trabajo, y no aporta nada a quien lee el informe.
 */
function pieDeFoto(foto) {
  const fecha = foto.fecha
    ? new Date(foto.fecha).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Lima' })
    : null;
  const comentario = (foto.comentario || '').trim();
  if (comentario && fecha) return `${comentario} · ${fecha}`;
  return comentario || fecha || '';
}

// Lo que necesita el informe del servicio: cabecera, ascensores/edificio,
// técnicos, días (para numerar las fotos) e historial (para derivar ejecución).
const INCLUDE_SERVICIO_INFORME = {
  cliente: true,
  tipo_servicio: true,
  ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: true } } } },
  asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
  dias: { where: { estado: 1 }, orderBy: { orden: 'asc' } },
  emergencia: { select: { id: true } },
  correctivo: { select: { id: true } },
  historial_estados: { where: { estado: 1 }, orderBy: { fecha_cambio: 'asc' } }
};

/**
 * Reúne TODO lo que va al informe de finalización, en el mismo orden en que se
 * imprime. Lo comparten la previsualización (que lo devuelve como datos, para
 * que el técnico revise y corrija los textos antes de emitir) y la generación
 * del PDF, de modo que lo que se ve en pantalla es exactamente lo que se emite.
 *
 * Fotografías: entran TODAS las evidencias activas del servicio, no solo las
 * "generales". Antes se filtraban las que cuelgan de un ítem del checklist y el
 * técnico echaba de menos fotos que sí había subido. Se deduplica por archivo
 * para que una misma imagen no salga dos veces.
 *
 * Pie de cada foto: SOLO el comentario y la fecha en que se registró. Nunca el
 * nombre del archivo — es un dato del almacenamiento ("IMG_20260823.jpg"), no
 * información del trabajo, y ensucia el informe que ve el cliente.
 */
async function recopilarDatosInforme(idServicio, plantilla, servicio) {
  const checklist = await prisma.tbl_servicios_finalizacion_checklist.findUnique({
    where: { id_servicio: idServicio },
    include: {
      respuestas: {
        where: { estado: 1 },
        include: { fotos: { where: { estado: 1 }, include: { archivo: { select: SELECT_ARCHIVO } } } }
      }
    }
  });
  const respuestasPorItemId = new Map((checklist?.respuestas || []).map(r => [r.id_item, r]));

  const observaciones = await prisma.tbl_servicios_observaciones.findMany({
    where: { id_servicio: idServicio, estado: 1 },
    orderBy: { id: 'asc' },
    include: { archivo: { select: SELECT_ARCHIVO } }
  });

  // TODAS las evidencias del servicio (generales y de ítem).
  const evidencias = await prisma.tbl_servicios_evidencias.findMany({
    where: { id_servicio: idServicio, estado: 1 },
    orderBy: { fecha_carga: 'asc' },
    include: { archivo: { select: SELECT_ARCHIVO }, tecnico: { select: { nombre: true } } }
  });

  const diasPorId = new Map((servicio.dias || []).map(d => [d.id, d]));

  const items = (plantilla.items || []).map(it => {
    const r = respuestasPorItemId.get(it.id);
    return {
      id_item: it.id,
      grupo: it.grupo || null,
      texto: it.texto,
      respuesta: r?.respuesta || null,
      nota: r?.nota || '',
      fotos: (r?.fotos || []).map(f => ({
        id: f.id,
        id_archivo: f.id_archivo,
        archivo: f.archivo,
        dia: f.id_dia ? (diasPorId.get(f.id_dia)?.orden ?? null) : null,
        latitud: f.latitud != null ? Number(f.latitud) : null,
        longitud: f.longitud != null ? Number(f.longitud) : null
      }))
    };
  });

  // Registro fotográfico: evidencias + imágenes de observaciones, sin repetir
  // archivo. La evidencia manda sobre la observación si comparten imagen.
  const vistos = new Set();
  const fotos = [];
  for (const e of evidencias) {
    if (!e.archivo || vistos.has(e.id_archivo)) continue;
    vistos.add(e.id_archivo);
    fotos.push({
      origen: 'evidencia',
      id: e.id,
      archivo: e.archivo,
      comentario: e.descripcion || '',
      fecha: e.fecha_carga,
      dia: e.id_dia ? (diasPorId.get(e.id_dia)?.orden ?? null) : null
    });
  }
  for (const o of observaciones) {
    if (!o.archivo || vistos.has(o.id_archivo)) continue;
    vistos.add(o.id_archivo);
    fotos.push({
      origen: 'observacion',
      id: o.id,
      archivo: o.archivo,
      comentario: o.texto || '',
      fecha: o.date_time_registration
    });
  }

  return {
    items,
    observaciones: observaciones.map(o => ({
      id: o.id,
      texto: o.texto || '',
      fecha: o.date_time_registration,
      tiene_foto: !!o.archivo
    })),
    fotos,
    ejecucion: derivarEjecucion(servicio)
  };
}

/**
 * Guarda las correcciones que el técnico hizo en la previsualización.
 *
 * Se persisten en su tabla de origen —la nota en su respuesta, el comentario en
 * su evidencia, el texto en su observación— y no como una copia dentro del
 * informe: el PDF y la ficha del servicio tienen que contar lo mismo. Solo se
 * escribe lo que cambió.
 */
async function aplicarTextosEditados(idServicio, textos, idUsuario) {
  if (!textos || typeof textos !== 'object') return 0;
  const stamp = { user_id_modification: idUsuario, date_time_modification: new Date() };
  let cambios = 0;
  const limpiar = (v) => (typeof v === 'string' ? v.trim() : '');

  for (const [idItem, nota] of Object.entries(textos.items || {})) {
    const { count } = await prisma.tbl_servicios_finalizacion_respuestas.updateMany({
      where: { id_item: Number(idItem), estado: 1, checklist: { id_servicio: idServicio } },
      data: { nota: limpiar(nota) || null, ...stamp }
    });
    cambios += count;
  }
  for (const [idEvidencia, comentario] of Object.entries(textos.evidencias || {})) {
    const { count } = await prisma.tbl_servicios_evidencias.updateMany({
      where: { id: Number(idEvidencia), id_servicio: idServicio, estado: 1 },
      data: { descripcion: limpiar(comentario) || null, ...stamp }
    });
    cambios += count;
  }
  for (const [idObs, texto] of Object.entries(textos.observaciones || {})) {
    const limpio = limpiar(texto);
    // Una observación sin texto perdería su sentido (y su alerta al coordinador).
    if (!limpio) continue;
    const { count } = await prisma.tbl_servicios_observaciones.updateMany({
      where: { id: Number(idObs), id_servicio: idServicio, estado: 1 },
      data: { texto: limpio, ...stamp }
    });
    cambios += count;
  }
  return cambios;
}

/**
 * Previsualización del informe: devuelve exactamente los datos que se van a
 * imprimir, para que el técnico los revise y corrija antes de emitir el PDF.
 */
const previsualizarInforme = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio },
      include: INCLUDE_SERVICIO_INFORME
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (!puedeEditarChecklist(req.user, servicio)) {
      return res.status(403).json({ error: 'Solo el técnico responsable puede ver el informe' });
    }
    const ctx = await ensureChecklistFinalizacion(prisma, servicio, req.user.id);
    if (!ctx) return res.json({ data: { sin_checklist: true } });

    const datos = await recopilarDatosInforme(idServicio, ctx.plantilla, servicio);
    res.json({
      data: {
        // Solo se puede corregir mientras el servicio siga abierto: una vez
        // finalizado, el PDF ya quedó adjunto al cierre.
        editable: !estaServicioFinalizado(servicio.estado_servicio),
        servicio: {
          id: servicio.id,
          codigo: servicio.codigo,
          titulo: servicio.titulo,
          cliente: servicio.cliente?.nombre || null,
          tipo_servicio: servicio.tipo_servicio?.nombre || null,
          fecha_programada: servicio.fecha_programada,
          ascensores: (servicio.ascensores || []).map(a => a.ascensor?.codigo).filter(Boolean),
          edificio: (servicio.ascensores || []).map(a => a.ascensor?.edificio?.nombre).find(Boolean) || null,
          tecnicos: (servicio.asignaciones || []).map(a => a.tecnico?.nombre).filter(Boolean)
        },
        plantilla: { titulo: ctx.plantilla.titulo, categoria: ctx.plantilla.categoria },
        ...datos
      }
    });
  } catch (err) {
    console.error('[checklistFinalizacion.previsualizarInforme]', err);
    res.status(500).json({ error: 'Error al preparar la previsualización: ' + err.message });
  }
};

const generarInforme = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio },
      include: INCLUDE_SERVICIO_INFORME
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (!puedeEditarChecklist(req.user, servicio)) {
      return res.status(403).json({ error: 'Solo el técnico responsable puede generar el informe' });
    }
    // El informe se genera al cerrar el servicio. Si ya fue finalizado, no se
    // regenera: sobrescribiría el PDF que quedó adjunto al cierre.
    if (estaServicioFinalizado(servicio.estado_servicio)) {
      return res.status(409).json({
        error: `El servicio ya fue finalizado (${servicio.estado_servicio}): el informe no se regenera`,
        estado: servicio.estado_servicio
      });
    }

    // El checklist de finalización es OPCIONAL. Si la categoría no tiene plantilla
    // configurada no hay checklist ni informe que generar: se responde OK para que
    // la finalización pueda continuar sin bloquear al técnico.
    const ctx = await ensureChecklistFinalizacion(prisma, servicio, req.user.id);
    if (!ctx) return res.json({ data: { sin_checklist: true } });
    const { plantilla } = ctx;

    // Correcciones que el técnico hizo en la previsualización: se guardan ANTES
    // de recopilar, para que el PDF salga con los textos ya corregidos.
    await aplicarTextosEditados(idServicio, req.body?.textos, req.user.id);

    const datos = await recopilarDatosInforme(idServicio, plantilla, servicio);

    // Binarios de las fotos por ítem (van incrustadas junto a su ítem).
    const respuestasPdf = new Map();
    for (const it of datos.items) {
      if (!it.respuesta && !it.nota && it.fotos.length === 0) continue;
      const fotos = [];
      for (const f of it.fotos) {
        fotos.push({
          buffer: await descargarArchivoImagen(f.archivo),
          latitud: f.latitud,
          longitud: f.longitud,
          dia: f.dia
        });
      }
      respuestasPdf.set(it.id_item, { respuesta: it.respuesta, nota: it.nota, fotos });
    }

    // Registro fotográfico: el pie lleva SOLO el comentario y la fecha.
    const fotosGenerales = [];
    for (const f of datos.fotos) {
      const buffer = await descargarArchivoImagen(f.archivo);
      if (!buffer) continue;
      fotosGenerales.push({ buffer, caption: pieDeFoto(f) });
    }

    const observacionesTecnicas = await prisma.tbl_servicios_observaciones.findMany({
      where: { id_servicio: idServicio, estado: 1 },
      orderBy: { id: 'asc' },
      include: { archivo: { select: SELECT_ARCHIVO } }
    });

    const buffer = await generarInformeFinalizacionPdf({
      servicio,
      plantilla,
      respuestasPorItem: respuestasPdf,
      observacionesTecnicas,
      ejecucion: datos.ejecucion,
      fotos: fotosGenerales
    });
    const nombre = `${servicio.codigo}-informe.pdf`;
    const key = construirKey('informes-servicio', nombre);
    await subirObjeto({ key, body: buffer, contentType: 'application/pdf' });
    const archivo = await prisma.tbl_archivos.create({
      data: {
        nombre_original: nombre,
        ruta_almacenamiento: rutaDesdeKey(key),
        mime_type: 'application/pdf',
        tamano_bytes: buffer.length,
        subido_por: req.user.id,
        user_id_registration: req.user.id
      }
    });
    const checklistFinal = await prisma.tbl_servicios_finalizacion_checklist.update({
      where: { id: ctx.checklist.id },
      data: {
        id_archivo_pdf: archivo.id,
        completado_por: req.user.id,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      },
      include: { archivo_pdf: { select: SELECT_ARCHIVO } }
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_finalizacion_checklist', id_entidad: checklistFinal.id,
      accion: 'UPDATE', valor_nuevo: { id_servicio: idServicio, items: plantilla.items.length, informe: true }, ip: req.ip
    });

    // La alerta de "cotización urgente" NO se genera aquí: se crea únicamente al
    // registrar una observación técnica (observacionesServicioController). Las
    // alertas de "servicio finalizado" se sincronizan al cerrar el servicio.

    let urlPdf = null;
    try { urlPdf = await urlPresigned(keyDesdeRuta(archivo.ruta_almacenamiento)); } catch { /* no crítica */ }

    res.status(201).json({ data: { ...checklistFinal, url_pdf: urlPdf } });
  } catch (err) {
    console.error('[checklistFinalizacion.generarInforme]', err);
    res.status(500).json({ error: 'Error al generar el informe de finalización: ' + err.message });
  }
};

module.exports = {
  ensureChecklistFinalizacion,
  listarPlantillas,
  obtenerPlantilla,
  actualizarPlantilla,
  obtenerFinalizacion,
  previsualizarInforme,
  guardarRespuestaItem,
  agregarFotoItem,
  eliminarFotoItem,
  generarInforme
};

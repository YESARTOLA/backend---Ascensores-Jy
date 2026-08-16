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
function puedeEditarChecklist(user, servicio) {
  if (['super_admin', 'admin'].includes(user.rol_codigo)) return true;
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

    const puedeEditar = puedeEditarChecklist(req.user, servicio) && servicio.estado_servicio === 'En curso';

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
    if (servicio.estado_servicio !== 'En curso') {
      return res.status(400).json({ error: 'El servicio debe estar en curso para editar el checklist' });
    }
    if (!puedeEditarChecklist(req.user, servicio)) {
      return res.status(403).json({ error: 'Solo el técnico responsable puede completar el checklist' });
    }

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
    if (servicio.estado_servicio !== 'En curso') {
      return res.status(400).json({ error: 'El servicio debe estar en curso para editar el checklist' });
    }
    if (!puedeEditarChecklist(req.user, servicio)) {
      return res.status(403).json({ error: 'Solo el técnico responsable puede completar el checklist' });
    }

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
    if (servicio.estado_servicio !== 'En curso') {
      return res.status(400).json({ error: 'El servicio debe estar en curso para editar el checklist' });
    }
    if (!puedeEditarChecklist(req.user, servicio)) {
      return res.status(403).json({ error: 'Solo el técnico responsable puede completar el checklist' });
    }

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
const generarInforme = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio },
      include: {
        cliente: true,
        tipo_servicio: true,
        ascensores: { where: { estado: 1 }, include: { ascensor: { include: { edificio: true } } } },
        asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
        dias: { where: { estado: 1 }, orderBy: { orden: 'asc' } },
        emergencia: { select: { id: true } },
        correctivo: { select: { id: true } },
        historial_estados: { where: { estado: 1 }, orderBy: { fecha_cambio: 'asc' } }
      }
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

    // Respuestas persistidas + fotos por ítem.
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

    // El checklist NO bloquea la finalización: el informe se genera con lo que
    // haya respondido el técnico (los ítems sin responder o sin foto simplemente
    // no se completan en el PDF).

    // Observaciones técnicas (para el PDF).
    const observacionesTecnicas = await prisma.tbl_servicios_observaciones.findMany({
      where: { id_servicio: idServicio, estado: 1 },
      orderBy: { id: 'asc' },
      include: { archivo: { select: SELECT_ARCHIVO } }
    });

    // Evidencias GENERALES (id_respuesta NULL) → sección fotográfica general del PDF.
    const evidenciasGenerales = await prisma.tbl_servicios_evidencias.findMany({
      where: { id_servicio: idServicio, estado: 1, id_respuesta: null },
      orderBy: { fecha_carga: 'asc' },
      include: { archivo: { select: SELECT_ARCHIVO }, tecnico: { select: { nombre: true } } }
    });

    const diasPorId = new Map((servicio.dias || []).map(d => [d.id, d]));

    // Descargar binarios de las fotos por ítem (para incrustarlas junto al ítem).
    const respuestasPdf = new Map();
    for (const it of plantilla.items) {
      const r = respuestasPorItemId.get(it.id);
      if (!r) continue;
      const fotos = [];
      for (const f of (r.fotos || [])) {
        const buffer = await descargarArchivoImagen(f.archivo);
        const dia = f.id_dia ? diasPorId.get(f.id_dia) : null;
        fotos.push({
          buffer,
          latitud: f.latitud != null ? Number(f.latitud) : null,
          longitud: f.longitud != null ? Number(f.longitud) : null,
          dia: dia ? dia.orden : null
        });
      }
      respuestasPdf.set(it.id, { respuesta: r.respuesta, nota: r.nota, fotos });
    }

    // Sección general: evidencias generales + observaciones con imagen.
    const fuentesGenerales = [
      ...evidenciasGenerales.map(e => ({
        archivo: e.archivo,
        caption: [e.tipo_evidencia || 'Foto', e.tecnico?.nombre, e.descripcion].filter(Boolean).join(' · ')
      })),
      ...observacionesTecnicas.filter(o => o.archivo).map(o => ({
        archivo: o.archivo,
        caption: `Observación: ${(o.texto || '').slice(0, 90)}${(o.texto || '').length > 90 ? '…' : ''}`
      }))
    ];
    const fotosGenerales = [];
    for (const f of fuentesGenerales) {
      const buffer = await descargarArchivoImagen(f.archivo);
      if (buffer) fotosGenerales.push({ buffer, caption: f.caption });
    }

    const ejecucion = derivarEjecucion(servicio);

    const buffer = await generarInformeFinalizacionPdf({
      servicio,
      plantilla,
      respuestasPorItem: respuestasPdf,
      observacionesTecnicas,
      ejecucion,
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
  guardarRespuestaItem,
  agregarFotoItem,
  eliminarFotoItem,
  generarInforme
};

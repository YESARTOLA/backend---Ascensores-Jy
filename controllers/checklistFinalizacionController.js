/**
 * Checklist de finalización de servicio.
 *
 * Endpoints:
 *  - GET    /checklist-plantillas               → lista de plantillas activas
 *  - GET    /checklist-plantillas/:categoria    → plantilla + items por categoría
 *  - PUT    /checklist-plantillas/:categoria    → reemplazo de items (super_admin/admin)
 *  - GET    /servicios/:id/finalizacion         → checklist existente (si ya se completó)
 *  - GET    /servicios/:id/finalizacion/plantilla → plantilla aplicable al servicio
 *  - POST   /servicios/:id/finalizacion         → guarda respuestas + genera PDF
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
const { sincronizarRecordatorioCotizacionUrgente } = require('../utils/recordatoriosAuto');

const CATEGORIAS_VALIDAS = ['mantenimiento', 'correctivo', 'emergencia'];
const RESPUESTAS_VALIDAS = ['si', 'no', 'na'];
const ROLES_EDIT_PLANTILLA = ['super_admin', 'admin'];

async function resolverCategoriaParaServicio(idServicio) {
  const s = await prisma.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    select: { emergencia: { select: { id: true } }, correctivo: { select: { id: true } } }
  });
  if (!s) return null;
  if (s.emergencia) return 'emergencia';
  if (s.correctivo) return 'correctivo';
  return 'mantenimiento';
}

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

      // Reemplazo total de items
      await tx.tbl_checklist_plantilla_items.deleteMany({ where: { id_plantilla: cabecera.id } });
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

const obtenerPlantillaParaServicio = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const categoria = await resolverCategoriaParaServicio(idServicio);
    if (!categoria) return res.status(404).json({ error: 'Servicio no encontrado' });
    const plantilla = await prisma.tbl_checklist_plantillas.findUnique({
      where: { categoria },
      include: { items: { where: { estado: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] } }
    });
    if (!plantilla || plantilla.items.length === 0) {
      return res.status(400).json({
        error: `La plantilla "${categoria}" no tiene ítems. Pídale a un administrador que la configure en /configuracion.`
      });
    }
    res.json({ data: { categoria, plantilla } });
  } catch (err) {
    console.error('[checklistFinalizacion.obtenerPlantillaParaServicio]', err);
    res.status(500).json({ error: 'Error al resolver plantilla' });
  }
};

const obtenerFinalizacion = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const checklist = await prisma.tbl_servicios_finalizacion_checklist.findUnique({
      where: { id_servicio: idServicio },
      include: {
        plantilla: { include: { items: { where: { estado: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] } } },
        respuestas: { where: { estado: 1 } },
        archivo_pdf: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } }
      }
    });
    res.json({ data: checklist || null });
  } catch (err) {
    console.error('[checklistFinalizacion.obtenerFinalizacion]', err);
    res.status(500).json({ error: 'Error al obtener checklist de finalización' });
  }
};

const crearFinalizacion = async (req, res) => {
  try {
    const idServicio = Number(req.params.idServicio);
    const servicio = await prisma.tbl_servicios_proyectos.findUnique({
      where: { id: idServicio },
      include: {
        cliente: true,
        tipo_servicio: true,
        ascensores: { where: { estado: 1 }, include: { ascensor: true } },
        asignaciones: { where: { estado: 1 }, include: { tecnico: true } },
        emergencia: { select: { id: true } },
        correctivo: { select: { id: true } },
        historial_estados: { where: { estado: 1 }, orderBy: { fecha_cambio: 'asc' } }
      }
    });
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });

    // Permiso: técnico asignado responsable de documentación, o admin/super_admin
    const esAdmin = ['super_admin', 'admin'].includes(req.user.rol_codigo);
    if (!esAdmin) {
      if (req.user.rol_codigo !== 'tecnico') {
        return res.status(403).json({ error: 'No autorizado' });
      }
      const asig = servicio.asignaciones.find(a => a.id_tecnico === req.user.id_tecnico);
      const esResponsable = asig && (asig.responsable_documentacion === 1 || servicio.asignaciones.length === 1);
      if (!esResponsable) {
        return res.status(403).json({ error: 'Solo el técnico responsable puede completar el checklist de finalización' });
      }
    }

    const categoria = servicio.emergencia ? 'emergencia' : servicio.correctivo ? 'correctivo' : 'mantenimiento';
    const plantilla = await prisma.tbl_checklist_plantillas.findUnique({
      where: { categoria },
      include: { items: { where: { estado: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] } }
    });
    if (!plantilla || plantilla.items.length === 0) {
      return res.status(400).json({ error: `La plantilla "${categoria}" no tiene ítems. Pídale a un administrador que la configure.` });
    }

    const respuestasBody = Array.isArray(req.body?.respuestas) ? req.body.respuestas : [];
    const indicePorId = new Map(plantilla.items.map(it => [it.id, it]));
    const respuestasLimpias = [];
    for (const r of respuestasBody) {
      const idItem = Number(r?.id_item);
      const respuesta = String(r?.respuesta || '').toLowerCase();
      if (!indicePorId.has(idItem)) continue;
      if (!RESPUESTAS_VALIDAS.includes(respuesta)) {
        return res.status(400).json({ error: `Respuesta inválida para el ítem ${idItem} (esperado: si | no | na)` });
      }
      const nota = r?.nota ? String(r.nota).trim().substring(0, 1000) : null;
      respuestasLimpias.push({ id_item: idItem, respuesta, nota });
    }
    // Validar que todos los ítems tengan respuesta
    if (respuestasLimpias.length !== plantilla.items.length) {
      return res.status(400).json({ error: 'Debe responder todos los ítems del checklist' });
    }

    // Cargar observaciones técnicas (incluyendo archivo adjunto si tiene)
    // para incluirlas en el PDF y para alimentar la sección fotográfica.
    const observacionesTecnicas = await prisma.tbl_servicios_observaciones.findMany({
      where: { id_servicio: idServicio, estado: 1 },
      orderBy: { id: 'asc' },
      include: {
        archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } }
      }
    });

    // Cargar evidencias fotográficas activas del servicio (tbl_servicios_evidencias).
    const evidencias = await prisma.tbl_servicios_evidencias.findMany({
      where: { id_servicio: idServicio, estado: 1 },
      orderBy: { fecha_carga: 'asc' },
      include: {
        archivo: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } },
        tecnico: { select: { nombre: true } }
      }
    });

    // Construir lista unificada de fotos (evidencias + observaciones con
    // imagen adjunta) descargando el binario desde Wasabi. Errores
    // individuales no abortan la generación: se omiten silenciosamente.
    const fuentesFoto = [
      ...evidencias.map(e => ({
        archivo: e.archivo,
        caption: [
          e.tipo_evidencia || 'Foto',
          e.tecnico?.nombre,
          e.descripcion
        ].filter(Boolean).join(' · ')
      })),
      ...observacionesTecnicas.filter(o => o.archivo).map(o => ({
        archivo: o.archivo,
        caption: `Observación: ${(o.texto || '').slice(0, 90)}${(o.texto || '').length > 90 ? '…' : ''}`
      }))
    ];
    const fotos = [];
    for (const f of fuentesFoto) {
      const buffer = await descargarArchivoImagen(f.archivo);
      if (buffer) fotos.push({ buffer, caption: f.caption });
    }

    const ejecucion = derivarEjecucion(servicio);

    // Persistencia transaccional: checklist + respuestas; el PDF se genera después
    // de la transacción (operación I/O) y se asigna mediante un UPDATE final.
    const checklistGuardado = await prisma.$transaction(async (tx) => {
      const existente = await tx.tbl_servicios_finalizacion_checklist.findUnique({ where: { id_servicio: idServicio } });
      const cabecera = existente
        ? await tx.tbl_servicios_finalizacion_checklist.update({
            where: { id: existente.id },
            data: {
              id_plantilla: plantilla.id,
              completado_por: req.user.id,
              user_id_modification: req.user.id,
              date_time_modification: new Date()
            }
          })
        : await tx.tbl_servicios_finalizacion_checklist.create({
            data: {
              id_servicio: idServicio,
              id_plantilla: plantilla.id,
              completado_por: req.user.id,
              user_id_registration: req.user.id
            }
          });

      await tx.tbl_servicios_finalizacion_respuestas.deleteMany({ where: { id_checklist: cabecera.id } });
      for (const r of respuestasLimpias) {
        await tx.tbl_servicios_finalizacion_respuestas.create({
          data: {
            id_checklist: cabecera.id,
            id_item: r.id_item,
            respuesta: r.respuesta,
            nota: r.nota,
            user_id_registration: req.user.id
          }
        });
      }
      return cabecera;
    });

    // Generar PDF y subirlo a Wasabi
    const respuestasPorItem = new Map(respuestasLimpias.map(r => [r.id_item, r]));
    const buffer = await generarInformeFinalizacionPdf({
      servicio,
      plantilla,
      respuestasPorItem,
      observacionesTecnicas,
      ejecucion,
      fotos
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
      where: { id: checklistGuardado.id },
      data: { id_archivo_pdf: archivo.id, user_id_modification: req.user.id, date_time_modification: new Date() },
      include: {
        plantilla: { include: { items: { where: { estado: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] } } },
        respuestas: { where: { estado: 1 } },
        archivo_pdf: { select: { id: true, nombre_original: true, ruta_almacenamiento: true, mime_type: true } }
      }
    });

    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_servicios_finalizacion_checklist', id_entidad: checklistFinal.id,
      accion: 'CREATE', valor_nuevo: { id_servicio: idServicio, items: respuestasLimpias.length }, ip: req.ip
    });

    // Alerta de cotización urgente tras generar el informe. Las alertas de
    // "servicio finalizado" (revisar / facturar / aviso) NO se sincronizan aquí:
    // este checklist se completa mientras el servicio aún está pre-finalización,
    // y el gate de estado las descartaría. Se sincronizan al cerrar el servicio
    // (serviciosController.finalizar), cuando ya está en estado post-finalización.
    sincronizarRecordatorioCotizacionUrgente(idServicio).catch(err => {
      console.error('Sync cotización urgente:', err);
    });

    let urlPdf = null;
    try { urlPdf = await urlPresigned(keyDesdeRuta(archivo.ruta_almacenamiento)); } catch { /* no crítica */ }

    res.status(201).json({ data: { ...checklistFinal, url_pdf: urlPdf } });
  } catch (err) {
    console.error('[checklistFinalizacion.crearFinalizacion]', err);
    res.status(500).json({ error: 'Error al guardar checklist de finalización: ' + err.message });
  }
};

module.exports = {
  resolverCategoriaParaServicio,
  listarPlantillas,
  obtenerPlantilla,
  actualizarPlantilla,
  obtenerPlantillaParaServicio,
  obtenerFinalizacion,
  crearFinalizacion
};

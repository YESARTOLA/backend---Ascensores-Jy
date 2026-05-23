/**
 * Genera el informe de finalización de servicio en PDF.
 *
 * Incluye: datos de empresa (de tbl_configuracion), datos del cliente y
 * edificio, ascensores, técnicos asignados, observaciones técnicas
 * registradas durante el servicio, las respuestas del checklist de
 * finalización (Sí / No / N/A + nota) renderizadas bajo el título
 * "Actividades realizadas", y un bloque "Registros fotográficos" con todas
 * las imágenes adjuntas al servicio (evidencias y observaciones).
 */
const PDFDocument = require('pdfkit');
const configuracion = require('./configuracion');
const { obtenerStream, keyDesdeRuta } = require('./storage');

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function descargarArchivoImagen(archivo) {
  if (!archivo?.ruta_almacenamiento) return null;
  if (!archivo.mime_type || !archivo.mime_type.startsWith('image/')) return null;
  const key = keyDesdeRuta(archivo.ruta_almacenamiento);
  try {
    const r = await obtenerStream(key);
    return await streamToBuffer(r.Body);
  } catch (err) {
    console.error('[informeServicioPdf] No se pudo descargar imagen', archivo.id, err.message);
    return null;
  }
}

const PALETA = {
  acento: '#e8853a',
  texto: '#1f2937',
  gris: '#6b7280',
  grisClaro: '#e5e7eb',
  fondoCabecera: '#fff7ed'
};

const LABEL_RESPUESTA = { si: 'Sí', no: 'No', na: 'N/A' };

function fechaFmt(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('es-PE', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Lima' });
  } catch { return String(d); }
}

async function generarInformeFinalizacionPdf(ctx) {
  const { servicio, plantilla, respuestasPorItem, observacionesTecnicas, ejecucion, fotos } = ctx;
  const empresa = await configuracion.obtenerVarios([
    'EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC', 'EMPRESA_DIRECCION',
    'EMPRESA_TELEFONO', 'EMPRESA_CORREO'
  ]);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const cerrado = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x0 = doc.page.margins.left;
  let y = doc.page.margins.top;

  // Cabecera empresa
  doc.rect(x0, y, ancho, 70).fill(PALETA.fondoCabecera);
  doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(16).text(empresa.EMPRESA_RAZON_SOCIAL || '—', x0 + 12, y + 12);
  doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris);
  doc.text(`RUC: ${empresa.EMPRESA_RUC || '—'}`, x0 + 12, y + 32);
  if (empresa.EMPRESA_DIRECCION) doc.text(empresa.EMPRESA_DIRECCION, x0 + 12, y + 44);
  const lineaContacto = [empresa.EMPRESA_TELEFONO, empresa.EMPRESA_CORREO].filter(Boolean).join('  •  ');
  if (lineaContacto) doc.text(lineaContacto, x0 + 12, y + 56);

  doc.fillColor(PALETA.acento).font('Helvetica-Bold').fontSize(13).text('INFORME DE SERVICIO', x0, y + 12, { align: 'right', width: ancho - 12 });
  doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(11).text(servicio.codigo, x0, y + 32, { align: 'right', width: ancho - 12 });
  doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris).text(plantilla?.titulo || '', x0, y + 48, { align: 'right', width: ancho - 12 });
  y += 90;

  // Cliente / Edificio
  doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(10).text('CLIENTE', x0, y);
  y += 14;
  doc.font('Helvetica').fontSize(10).fillColor(PALETA.texto);
  doc.text(servicio.cliente?.nombre || '—', x0, y); y += 12;
  if (servicio.cliente?.nombre_edificio) {
    doc.fillColor(PALETA.gris).text(`Edificio: ${servicio.cliente.nombre_edificio}`, x0, y); y += 12;
  }
  if (servicio.cliente?.numero_documento) {
    doc.fillColor(PALETA.gris).text(`${servicio.cliente.tipo_documento || 'Doc'}: ${servicio.cliente.numero_documento}`, x0, y); y += 12;
  }
  if (servicio.cliente?.direccion) {
    doc.fillColor(PALETA.gris).text(`Dirección: ${servicio.cliente.direccion}${servicio.cliente.distrito ? ' · ' + servicio.cliente.distrito : ''}`, x0, y, { width: ancho }); y += 12;
  }

  y += 6;

  // Datos del servicio
  doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(10).text('SERVICIO', x0, y); y += 14;
  doc.font('Helvetica').fontSize(10).fillColor(PALETA.texto);
  doc.text(servicio.titulo || '—', x0, y, { width: ancho }); y += 12;
  if (servicio.tipo_servicio?.nombre) {
    doc.fillColor(PALETA.gris).text(`Tipo de servicio: ${servicio.tipo_servicio.nombre}`, x0, y); y += 12;
  }
  doc.fillColor(PALETA.gris).text(`Fecha programada: ${fechaFmt(servicio.fecha_programada)}${servicio.hora_programada ? ' ' + servicio.hora_programada : ''}`, x0, y); y += 12;
  if (ejecucion?.fecha_inicio_real) {
    doc.text(`Inicio real: ${fechaFmt(ejecucion.fecha_inicio_real)}`, x0, y); y += 12;
  }
  if (ejecucion?.fecha_fin_real) {
    doc.text(`Cierre real: ${fechaFmt(ejecucion.fecha_fin_real)}`, x0, y); y += 12;
  }
  y += 4;

  // Ascensores
  const ascs = (servicio.ascensores || []).map(a => a.ascensor).filter(Boolean);
  if (ascs.length > 0) {
    doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(10).text(`ASCENSOR${ascs.length > 1 ? 'ES' : ''}`, x0, y); y += 14;
    doc.font('Helvetica').fontSize(10).fillColor(PALETA.gris);
    ascs.forEach((a, idx) => {
      const partes = [a.codigo, a.tipo, a.ubicacion, a.marca, a.modelo].filter(Boolean).join(' · ');
      doc.text(`${idx + 1}. ${partes}`, x0, y, { width: ancho }); y += 12;
    });
    y += 4;
  }

  // Técnicos
  const tecs = (servicio.asignaciones || []).filter(a => a.estado === 1 && a.tecnico);
  if (tecs.length > 0) {
    doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(10).text('TÉCNICOS ASIGNADOS', x0, y); y += 14;
    doc.font('Helvetica').fontSize(10).fillColor(PALETA.gris);
    tecs.forEach(a => {
      const roles = [
        a.responsable_principal === 1 ? 'Resp. principal' : null,
        a.responsable_documentacion === 1 ? 'Resp. documentación' : null,
        a.responsable_checklist === 1 ? 'Resp. checklist' : null
      ].filter(Boolean).join(', ');
      doc.text(`• ${a.tecnico.nombre || '—'}${roles ? ` (${roles})` : ''}`, x0, y, { width: ancho }); y += 12;
    });
    y += 4;
  }

  // Observaciones técnicas
  if (Array.isArray(observacionesTecnicas) && observacionesTecnicas.length > 0) {
    doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(10).text('OBSERVACIONES TÉCNICAS / ACTIVIDADES', x0, y); y += 14;
    doc.font('Helvetica').fontSize(10).fillColor(PALETA.gris);
    observacionesTecnicas.forEach((o, idx) => {
      if (y > doc.page.height - doc.page.margins.bottom - 80) { doc.addPage(); y = doc.page.margins.top; }
      const linea = `${idx + 1}. ${fechaFmt(o.date_time_registration)} — ${o.atendida ? 'Atendida' : 'Pendiente'}`;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(PALETA.texto).text(linea, x0, y, { width: ancho });
      y += doc.heightOfString(linea, { width: ancho });
      doc.font('Helvetica').fontSize(10).fillColor(PALETA.gris).text(o.texto, x0 + 12, y, { width: ancho - 12 });
      y += doc.heightOfString(o.texto, { width: ancho - 12 }) + 4;
    });
    y += 4;
  }

  // Checklist de finalización
  if (plantilla?.items?.length > 0) {
    if (y > doc.page.height - doc.page.margins.bottom - 60) { doc.addPage(); y = doc.page.margins.top; }
    doc.fillColor(PALETA.acento).font('Helvetica-Bold').fontSize(12).text('ACTIVIDADES REALIZADAS', x0, y); y += 18;
    let grupoActual = null;
    plantilla.items.forEach((it) => {
      if (y > doc.page.height - doc.page.margins.bottom - 50) { doc.addPage(); y = doc.page.margins.top; }
      if (it.grupo && it.grupo !== grupoActual) {
        grupoActual = it.grupo;
        doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETA.texto).text(grupoActual, x0, y); y += 14;
      }
      const r = respuestasPorItem.get(it.id);
      const etiq = r ? LABEL_RESPUESTA[r.respuesta] || r.respuesta : '—';
      const bullet = `• ${it.texto}`;
      doc.font('Helvetica').fontSize(10).fillColor(PALETA.texto).text(bullet, x0, y, { width: ancho - 60 });
      const alturaTexto = doc.heightOfString(bullet, { width: ancho - 60 });
      doc.font('Helvetica-Bold').fontSize(10)
        .fillColor(r?.respuesta === 'si' ? '#15803d' : r?.respuesta === 'no' ? '#b91c1c' : PALETA.gris)
        .text(etiq, x0 + ancho - 55, y, { width: 55, align: 'right' });
      y += alturaTexto;
      if (r?.nota) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(PALETA.gris)
          .text(`Nota: ${r.nota}`, x0 + 12, y, { width: ancho - 12 });
        y += doc.heightOfString(`Nota: ${r.nota}`, { width: ancho - 12 });
      }
      y += 4;
    });
  }

  // Registros fotográficos
  if (Array.isArray(fotos) && fotos.length > 0) {
    if (y > doc.page.height - doc.page.margins.bottom - 100) { doc.addPage(); y = doc.page.margins.top; }
    y += 8;
    doc.fillColor(PALETA.acento).font('Helvetica-Bold').fontSize(12).text('REGISTROS FOTOGRÁFICOS', x0, y); y += 18;

    const columnas = 2;
    const gap = 12;
    const anchoFoto = (ancho - gap * (columnas - 1)) / columnas;
    const altoFoto = 160;
    const alturaCaption = 28;

    for (let i = 0; i < fotos.length; i += columnas) {
      const fila = fotos.slice(i, i + columnas);
      const alturaFila = altoFoto + alturaCaption + 8;
      if (y + alturaFila > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      fila.forEach((foto, j) => {
        const xCol = x0 + j * (anchoFoto + gap);
        try {
          doc.image(foto.buffer, xCol, y, { fit: [anchoFoto, altoFoto], align: 'center', valign: 'center' });
        } catch (err) {
          doc.rect(xCol, y, anchoFoto, altoFoto).strokeColor(PALETA.grisClaro).lineWidth(0.5).stroke();
          doc.fillColor(PALETA.gris).font('Helvetica').fontSize(8).text('(imagen no disponible)', xCol, y + altoFoto / 2 - 4, { width: anchoFoto, align: 'center' });
        }
        const caption = foto.caption || '';
        doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
          .text(caption, xCol, y + altoFoto + 4, { width: anchoFoto, align: 'left', height: alturaCaption, ellipsis: true });
      });
      y += alturaFila;
    }
  }

  // Pie
  if (y > doc.page.height - doc.page.margins.bottom - 80) { doc.addPage(); y = doc.page.margins.top; }
  y += 20;
  doc.moveTo(x0, y).lineTo(x0 + ancho, y).strokeColor(PALETA.grisClaro).lineWidth(0.5).stroke();
  y += 8;
  doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
    .text(`Informe generado el ${fechaFmt(new Date())}`, x0, y, { width: ancho });

  doc.end();
  return cerrado;
}

module.exports = { generarInformeFinalizacionPdf, descargarArchivoImagen };

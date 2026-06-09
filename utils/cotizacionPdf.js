/**
 * Generación del PDF de una versión de cotización.
 *
 * Usa pdfkit (server-side, sin Chromium). Devuelve un Buffer con el PDF
 * para que el caller lo suba a Wasabi vía utils/storage.js.
 *
 * No referencia datos hardcodeados de la empresa: todo lo lee de
 * tbl_configuracion (utils/configuracion.js).
 */

const PDFDocument = require('pdfkit');
const configuracion = require('./configuracion');
const prisma = require('../config/prisma');

const PALETA = {
  acento: '#e8853a',
  texto: '#1f2937',
  gris: '#6b7280',
  grisClaro: '#e5e7eb',
  fondoCabecera: '#fff7ed'
};

async function obtenerCuentasBancariasActivas() {
  try {
    return await prisma.tbl_cuentas_bancarias.findMany({
      where: { estado: 1 },
      orderBy: [{ orden: 'asc' }, { id: 'asc' }]
    });
  } catch (_err) {
    // Si la tabla aún no existe (antes del primer db push), no rompe el PDF.
    return [];
  }
}

function formatearMonto(n, moneda = 'PEN') {
  const num = Number(n) || 0;
  const simbolo = moneda === 'PEN' ? 'S/' : moneda === 'USD' ? '$' : moneda;
  return `${simbolo} ${num.toFixed(2)}`;
}

function formatearFecha(d) {
  if (!d) return '';
  const fecha = new Date(d);
  return fecha.toISOString().slice(0, 10);
}

/**
 * @param {object} ctx
 * @param {object} ctx.cotizacion    Cabecera con cliente, ascensor, tipo_servicio incluidos
 * @param {object} ctx.version       Versión con totales y moneda
 * @param {Array}  ctx.items         Items de la versión
 * @returns {Promise<Buffer>}
 */
async function generarPdfCotizacion(ctx) {
  const empresa = await configuracion.obtenerVarios([
    'EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC', 'EMPRESA_DIRECCION',
    'EMPRESA_TELEFONO', 'EMPRESA_CORREO'
  ]);
  const terminos = ctx.version.terminos || (await configuracion.obtener('COTIZACION_TERMINOS'));
  const cuentasBancarias = await obtenerCuentasBancariasActivas();

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const cerrado = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x0 = doc.page.margins.left;
  let y = doc.page.margins.top;

  // Cabecera con fondo color
  doc.rect(x0, y, ancho, 70).fill(PALETA.fondoCabecera);
  doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(16).text(empresa.EMPRESA_RAZON_SOCIAL, x0 + 12, y + 12);
  doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris);
  doc.text(`RUC: ${empresa.EMPRESA_RUC}`, x0 + 12, y + 32);
  if (empresa.EMPRESA_DIRECCION) doc.text(empresa.EMPRESA_DIRECCION, x0 + 12, y + 44);
  const lineaContacto = [empresa.EMPRESA_TELEFONO, empresa.EMPRESA_CORREO].filter(Boolean).join('  •  ');
  if (lineaContacto) doc.text(lineaContacto, x0 + 12, y + 56);

  // Bloque derecho: COTIZACIÓN + código + versión
  doc.fillColor(PALETA.acento).font('Helvetica-Bold').fontSize(13).text('COTIZACIÓN', x0, y + 12, { align: 'right', width: ancho - 12 });
  doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(11).text(ctx.cotizacion.codigo, x0, y + 32, { align: 'right', width: ancho - 12 });
  doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris).text(`Versión: ${ctx.version.numero_version}`, x0, y + 48, { align: 'right', width: ancho - 12 });

  y += 90;

  // Datos del cliente
  doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETA.texto).text('CLIENTE', x0, y);
  y += 14;
  doc.font('Helvetica').fontSize(10).fillColor(PALETA.texto);
  doc.text(ctx.cotizacion.cliente?.nombre || '—', x0, y);
  y += 12;
  if (ctx.cotizacion.cliente?.numero_documento) {
    doc.fillColor(PALETA.gris).text(`${ctx.cotizacion.cliente.tipo_documento || 'Doc'}: ${ctx.cotizacion.cliente.numero_documento}`, x0, y);
    y += 12;
  }
  // La ubicación física vive ahora en el edificio de los ascensores cotizados
  // (todos del mismo edificio).
  const ascensoresCotPdf = Array.isArray(ctx.cotizacion.ascensores) ? ctx.cotizacion.ascensores : [];
  const edificioCot = ascensoresCotPdf.map(a => a.ascensor?.edificio).find(Boolean) || null;
  if (edificioCot?.direccion) {
    doc.fillColor(PALETA.gris).text(`${edificioCot.direccion}${edificioCot.distrito ? ' · ' + edificioCot.distrito : ''}`, x0, y);
    y += 12;
  }

  y += 6;
  // Ascensor / objeto de la cotización: nombre del edificio u obra, luego tipo
  // de servicio y la lista de ascensores.
  doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETA.texto).text('OBJETO DE LA COTIZACIÓN', x0, y);
  y += 14;
  const edificioUObra = edificioCot?.nombre || ctx.cotizacion.cliente?.nombre || '—';
  doc.font('Helvetica').fontSize(10).fillColor(PALETA.texto).text(edificioUObra, x0, y);
  y += 12;
  if (ctx.cotizacion.tipo_servicio?.nombre) {
    doc.fillColor(PALETA.gris).text(`Tipo de servicio: ${ctx.cotizacion.tipo_servicio.nombre}`, x0, y);
    y += 12;
  }
  const ascensoresCot = Array.isArray(ctx.cotizacion.ascensores) ? ctx.cotizacion.ascensores : [];
  if (ascensoresCot.length > 0) {
    const etiquetaLista = ascensoresCot.length > 1 ? 'Ascensores' : 'Ascensor';
    doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(10).text(`${etiquetaLista}:`, x0, y);
    y += 12;
    doc.font('Helvetica').fontSize(10).fillColor(PALETA.gris);
    ascensoresCot.forEach((fila, idx) => {
      const prefijo = ascensoresCot.length > 1 ? `${idx + 1}. ` : '• ';
      if (fila.ascensor) {
        const ubic = fila.ascensor.ubicacion ? ` — ${fila.ascensor.ubicacion}` : '';
        doc.text(`${prefijo}${fila.ascensor.codigo}${ubic}`, x0, y, { width: ancho });
        y += doc.heightOfString(`${prefijo}${fila.ascensor.codigo}${ubic}`, { width: ancho });
      } else if (fila.ascensor_nuevo) {
        const a = fila.ascensor_nuevo;
        const partes = [a.ubicacion, a.pisos ? `${a.pisos} pisos` : null, a.capacidad, a.marca, a.modelo].filter(Boolean).join(' • ');
        const linea = `${prefijo}Ascensor a instalar — ${partes || 'Ver descripción'}`;
        doc.text(linea, x0, y, { width: ancho });
        y += doc.heightOfString(linea, { width: ancho });
        if (a.descripcion) {
          doc.text(a.descripcion, x0 + 12, y, { width: ancho - 12 });
          y += doc.heightOfString(a.descripcion, { width: ancho - 12 });
        }
      }
    });
  }
  if (ctx.cotizacion.descripcion) {
    y += 4;
    doc.fillColor(PALETA.texto).text(ctx.cotizacion.descripcion, x0, y, { width: ancho });
    y += doc.heightOfString(ctx.cotizacion.descripcion, { width: ancho }) + 4;
  }

  y += 10;

  // Fechas y validez
  doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris);
  doc.text(`Fecha de emisión: ${formatearFecha(ctx.version.fecha_envio || new Date())}    Validez: ${formatearFecha(ctx.version.fecha_validez)}`, x0, y);
  y += 16;

  // Tabla de items
  const cols = [
    { titulo: '#', x: x0, w: 25, align: 'left' },
    { titulo: 'Descripción', x: x0 + 25, w: ancho - 25 - 55 - 75 - 50 - 75, align: 'left' },
    { titulo: 'Cant.', x: 0, w: 55, align: 'right' },
    { titulo: 'P. Unit.', x: 0, w: 75, align: 'right' },
    { titulo: '% Dscto', x: 0, w: 50, align: 'right' },
    { titulo: 'Importe', x: 0, w: 75, align: 'right' }
  ];
  // calcular xs
  let xAcc = x0;
  for (const c of cols) { c.x = xAcc; xAcc += c.w; }

  doc.rect(x0, y, ancho, 18).fill(PALETA.acento);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
  for (const c of cols) {
    doc.text(c.titulo, c.x + 4, y + 5, { width: c.w - 8, align: c.align });
  }
  y += 20;

  doc.font('Helvetica').fontSize(9).fillColor(PALETA.texto);
  let alterna = false;
  for (let i = 0; i < ctx.items.length; i++) {
    const it = ctx.items[i];
    const descAltura = doc.heightOfString(it.descripcion, { width: cols[1].w - 8 });
    const altura = Math.max(18, descAltura + 8);
    if (y + altura > doc.page.height - doc.page.margins.bottom - 140) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (alterna) {
      doc.rect(x0, y - 2, ancho, altura).fill('#fafafa');
      doc.fillColor(PALETA.texto);
    }
    alterna = !alterna;
    const dsctoPct = Number(it.descuento_porcentaje) || 0;
    doc.text(String(i + 1), cols[0].x + 4, y + 2, { width: cols[0].w - 8, align: cols[0].align });
    doc.text(it.descripcion, cols[1].x + 4, y + 2, { width: cols[1].w - 8 });
    doc.text(`${Number(it.cantidad).toFixed(2)} ${it.unidad || ''}`, cols[2].x + 4, y + 2, { width: cols[2].w - 8, align: cols[2].align });
    doc.text(formatearMonto(it.precio_unitario, ctx.version.moneda), cols[3].x + 4, y + 2, { width: cols[3].w - 8, align: cols[3].align });
    doc.text(dsctoPct > 0 ? `${dsctoPct.toFixed(2)}%` : '—', cols[4].x + 4, y + 2, { width: cols[4].w - 8, align: cols[4].align });
    doc.text(formatearMonto(it.importe, ctx.version.moneda), cols[5].x + 4, y + 2, { width: cols[5].w - 8, align: cols[5].align });
    y += altura;
    doc.moveTo(x0, y).lineTo(x0 + ancho, y).strokeColor(PALETA.grisClaro).lineWidth(0.5).stroke();
  }

  // Totales
  y += 10;
  const labelX = x0 + ancho - 200;
  const valueX = x0 + ancho - 90;
  const tasaPct = (Number(ctx.version.igv_tasa || 0) * 100).toFixed(0);
  doc.font('Helvetica').fontSize(10).fillColor(PALETA.texto);
  doc.text('Subtotal', labelX, y, { width: 100, align: 'right' });
  doc.text(formatearMonto(ctx.version.subtotal, ctx.version.moneda), valueX, y, { width: 80, align: 'right' });
  y += 14;
  doc.text(`IGV (${tasaPct}%)`, labelX, y, { width: 100, align: 'right' });
  doc.text(formatearMonto(ctx.version.igv, ctx.version.moneda), valueX, y, { width: 80, align: 'right' });
  y += 18;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(PALETA.acento);
  doc.text('TOTAL', labelX, y, { width: 100, align: 'right' });
  doc.text(formatearMonto(ctx.version.monto_total, ctx.version.moneda), valueX, y, { width: 80, align: 'right' });

  // Plan de cuotas (si aplica)
  const planCuotas = Array.isArray(ctx.version.plan_cuotas) ? ctx.version.plan_cuotas : [];
  if (ctx.version.tiene_cuotas && planCuotas.length > 0) {
    y += 30;
    if (y > doc.page.height - doc.page.margins.bottom - (40 + planCuotas.length * 16)) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETA.texto).text('PLAN DE PAGOS', x0, y);
    y += 14;

    const cuotaCols = [
      { titulo: 'Cuota', w: 60, align: 'left' },
      { titulo: 'Vencimiento', w: 90, align: 'left' },
      { titulo: 'Observación', w: ancho - 240, align: 'left' },
      { titulo: 'Monto', w: 90, align: 'right' }
    ];
    let cAcc = x0;
    for (const c of cuotaCols) { c.x = cAcc; cAcc += c.w; }

    doc.rect(x0, y, ancho, 18).fill(PALETA.acento);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
    for (const c of cuotaCols) {
      doc.text(c.titulo, c.x + 4, y + 5, { width: c.w - 8, align: c.align });
    }
    y += 20;

    doc.font('Helvetica').fontSize(9).fillColor(PALETA.texto);
    let altCuota = false;
    for (const c of planCuotas) {
      if (y + 18 > doc.page.height - doc.page.margins.bottom - 60) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      if (altCuota) doc.rect(x0, y - 2, ancho, 18).fill('#fafafa').fillColor(PALETA.texto);
      altCuota = !altCuota;
      doc.text(`Cuota ${c.numero_cuota}`, cuotaCols[0].x + 4, y + 2, { width: cuotaCols[0].w - 8, align: cuotaCols[0].align });
      doc.text(formatearFecha(c.fecha_vencimiento), cuotaCols[1].x + 4, y + 2, { width: cuotaCols[1].w - 8, align: cuotaCols[1].align });
      doc.text(c.observacion || '—', cuotaCols[2].x + 4, y + 2, { width: cuotaCols[2].w - 8, align: cuotaCols[2].align, lineBreak: false, ellipsis: true });
      doc.text(formatearMonto(c.monto, ctx.version.moneda), cuotaCols[3].x + 4, y + 2, { width: cuotaCols[3].w - 8, align: cuotaCols[3].align });
      y += 18;
      doc.moveTo(x0, y).lineTo(x0 + ancho, y).strokeColor(PALETA.grisClaro).lineWidth(0.5).stroke();
    }
    y += 4;
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(PALETA.gris)
      .text('* El plan de pagos es referencial y se confirma al momento de la aprobación de la cotización.', x0, y, { width: ancho });
    y += 14;
  }

  // Términos
  y += 30;
  if (y > doc.page.height - doc.page.margins.bottom - 80) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PALETA.texto).text('Términos y condiciones', x0, y);
  y += 12;
  doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris).text(terminos, x0, y, { width: ancho });

  // Datos para pago en última página
  if (cuentasBancarias.length > 0) {
    doc.addPage();
    y = doc.page.margins.top;

    doc.fillColor(PALETA.acento).font('Helvetica-Bold').fontSize(16).text('DATOS PARA PAGO', x0, y);
    y += 22;
    doc.fillColor(PALETA.gris).font('Helvetica').fontSize(9)
      .text(`Realice su depósito o transferencia a cualquiera de las siguientes cuentas a nombre de ${empresa.EMPRESA_RAZON_SOCIAL}.`, x0, y, { width: ancho });
    y += 24;

    for (const cuenta of cuentasBancarias) {
      const alto = 96;
      if (y + alto > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      doc.rect(x0, y, ancho, alto).fillColor(PALETA.fondoCabecera).fill();
      doc.strokeColor(PALETA.grisClaro).lineWidth(0.5).rect(x0, y, ancho, alto).stroke();

      doc.fillColor(PALETA.acento).font('Helvetica-Bold').fontSize(12)
        .text(cuenta.banco, x0 + 14, y + 12);
      doc.fillColor(PALETA.gris).font('Helvetica').fontSize(9)
        .text(`${cuenta.tipo_cuenta} · ${cuenta.moneda}`, x0 + 14, y + 30);

      doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(9)
        .text('Número de cuenta', x0 + 14, y + 50);
      doc.font('Helvetica').fontSize(11).fillColor(PALETA.texto)
        .text(cuenta.numero_cuenta, x0 + 14, y + 62);

      if (cuenta.cci) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(PALETA.texto)
          .text('CCI', x0 + ancho / 2, y + 50);
        doc.font('Helvetica').fontSize(11).fillColor(PALETA.texto)
          .text(cuenta.cci, x0 + ancho / 2, y + 62);
      }

      doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
        .text(`Titular: ${cuenta.titular}`, x0 + 14, y + 80, { width: ancho - 28 });

      y += alto + 10;
    }
  }

  doc.end();
  return cerrado;
}

module.exports = { generarPdfCotizacion };

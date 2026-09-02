/**
 * Generación de reportes del listado de cotizaciones en Excel (XLSX) y PDF
 * (A4 horizontal). Devuelven Buffer para que el controller los streamee en la
 * respuesta HTTP. Datos de cabecera (razón social, RUC, etc.) salen de
 * tbl_configuracion — sin hardcodeo. Espejo del patrón de `clientesExport.js`.
 */

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const configuracion = require('./configuracion');
const { ymdLima } = require('./tiempo');
const { etiquetaMoneda } = require('./catalogosBancarios');

const PALETA = {
  acento: '#e8853a',
  texto: '#1f2937',
  gris: '#6b7280',
  grisClaro: '#e5e7eb',
  fondoCabecera: '#fff7ed'
};

function fechaISO(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

function fmtMonto(n) {
  if (n == null || n === '') return '';
  return Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const COLUMNAS = [
  { header: 'Código',            key: 'codigo',            width: 17 },
  { header: 'Cliente',           key: 'cliente',           width: 32 },
  { header: 'Teléfono',          key: 'telefono',          width: 14 },
  { header: 'Edificio / Obra',   key: 'edificios',         width: 28 },
  { header: 'Tipo de servicio',  key: 'tipo',              width: 26 },
  { header: 'Categoría',         key: 'categoria',         width: 13 },
  { header: 'Estado',            key: 'estado_global',     width: 13 },
  { header: 'Versión',           key: 'version',           width: 9 },
  { header: 'Estado versión',    key: 'estado_version',    width: 15 },
  { header: 'Moneda',            key: 'moneda',            width: 9 },
  { header: 'Monto total',       key: 'monto_total',       width: 15, numFmt: '#,##0.00' },
  { header: 'Servicio generado', key: 'servicio_generado', width: 18 },
  { header: 'Creado por',        key: 'creado_por',        width: 22 },
  { header: 'Registrado',        key: 'registrado',        width: 12 }
];

function mapearFila(cot) {
  const v = Array.isArray(cot.versiones) ? cot.versiones[0] : null;
  const asc = Array.isArray(cot.ascensores) ? cot.ascensores : [];
  const edificios = [...new Set(asc.map(a => a.ascensor?.edificio?.nombre).filter(Boolean))].join(', ');
  const servicios = (Array.isArray(cot.servicios) ? cot.servicios : [])
    .map(s => s.codigo).filter(Boolean).join(', ');
  const monto = v && v.monto_total != null ? Number(v.monto_total) : null;
  return {
    codigo: cot.codigo || '',
    cliente: cot.cliente?.nombre || '',
    telefono: cot.cliente?.telefono || '',
    edificios,
    tipo: cot.subtipo_servicio?.nombre || cot.tipo_servicio?.nombre || '',
    categoria: cot.tipo_servicio?.categoria_funcional || '',
    estado_global: cot.estado_global || '',
    version: v ? `v${v.numero_version}` : '',
    estado_version: v?.estado_version || '',
    moneda: etiquetaMoneda(v?.moneda),
    monto_total: monto,
    // Forma lista para el PDF: "PEN 1,200.00" (en Excel el monto va numérico).
    monto_fmt: monto != null ? `${v?.moneda || ''} ${fmtMonto(monto)}`.trim() : '',
    servicio_generado: servicios,
    creado_por: cot.creado_por?.nombres || '',
    registrado: fechaISO(cot.date_time_registration)
  };
}

async function generarExcelCotizaciones(cotizaciones) {
  const empresa = await configuracion.obtenerVarios(['EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC']);
  const hoy = ymdLima();

  const wb = new ExcelJS.Workbook();
  wb.creator = empresa.EMPRESA_RAZON_SOCIAL || 'ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet('Cotizaciones', {
    views: [{ state: 'frozen', ySplit: 4 }]
  });

  // Cabecera de empresa
  ws.mergeCells('A1', String.fromCharCode(64 + COLUMNAS.length) + '1');
  ws.getCell('A1').value = empresa.EMPRESA_RAZON_SOCIAL || '';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F2937' } };
  ws.getCell('A1').alignment = { vertical: 'middle' };

  ws.mergeCells('A2', String.fromCharCode(64 + COLUMNAS.length) + '2');
  const subtitulo = [`RUC: ${empresa.EMPRESA_RUC || '—'}`, `Exportado: ${hoy}`, `${cotizaciones.length} cotización(es)`].join('   •   ');
  ws.getCell('A2').value = subtitulo;
  ws.getCell('A2').font = { size: 9, color: { argb: 'FF6B7280' } };

  // Encabezados de tabla en fila 4
  ws.columns = COLUMNAS.map(c => ({ key: c.key, width: c.width, style: c.numFmt ? { numFmt: c.numFmt } : undefined }));
  const headerRow = ws.getRow(4);
  COLUMNAS.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8853A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = {
      top:    { style: 'thin', color: { argb: 'FFE5E7EB' } },
      bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      left:   { style: 'thin', color: { argb: 'FFE5E7EB' } },
      right:  { style: 'thin', color: { argb: 'FFE5E7EB' } }
    };
  });
  headerRow.height = 22;

  // Filas
  cotizaciones.forEach((cot, idx) => {
    const fila = ws.addRow(mapearFila(cot));
    fila.alignment = { vertical: 'middle', wrapText: true };
    fila.font = { size: 10 };
    if (idx % 2 === 1) {
      fila.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } };
      });
    }
  });

  // Autofilter en la cabecera de tabla
  ws.autoFilter = {
    from: { row: 4, column: 1 },
    to:   { row: 4, column: COLUMNAS.length }
  };

  return wb.xlsx.writeBuffer().then(b => Buffer.from(b));
}

async function generarPdfCotizaciones(cotizaciones) {
  const empresa = await configuracion.obtenerVarios([
    'EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC', 'EMPRESA_DIRECCION', 'EMPRESA_TELEFONO', 'EMPRESA_CORREO'
  ]);
  const hoy = ymdLima();

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const cerrado = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x0 = doc.page.margins.left;

  function dibujarCabeceraPagina() {
    let y = doc.page.margins.top;
    doc.rect(x0, y, ancho, 55).fill(PALETA.fondoCabecera);
    doc.fillColor(PALETA.texto).font('Helvetica-Bold').fontSize(13).text(empresa.EMPRESA_RAZON_SOCIAL || '', x0 + 10, y + 8);
    doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris);
    doc.text(`RUC: ${empresa.EMPRESA_RUC || '—'}`, x0 + 10, y + 26);
    if (empresa.EMPRESA_DIRECCION) doc.text(empresa.EMPRESA_DIRECCION, x0 + 10, y + 38);

    doc.fillColor(PALETA.acento).font('Helvetica-Bold').fontSize(12)
      .text('LISTADO DE COTIZACIONES', x0, y + 8, { align: 'right', width: ancho - 10 });
    doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
      .text(`Exportado: ${hoy}   •   ${cotizaciones.length} cotización(es)`, x0, y + 28, { align: 'right', width: ancho - 10 });
    return y + 65;
  }

  // Columnas a renderizar en PDF (subset orientado a impresión)
  const cols = [
    { titulo: 'Código',        key: 'codigo',           w: 70 },
    { titulo: 'Cliente',       key: 'cliente',          w: 110 },
    { titulo: 'Edificio / Obra',key: 'edificios',       w: 90 },
    { titulo: 'Tipo',          key: 'tipo',             w: 90 },
    { titulo: 'Estado',        key: 'estado_global',    w: 55 },
    { titulo: 'Ver.',          key: 'version',          w: 28 },
    { titulo: 'Estado ver.',   key: 'estado_version',   w: 60 },
    { titulo: 'Monto total',   key: 'monto_fmt',        w: 75, align: 'right' },
    { titulo: 'Servicio',      key: 'servicio_generado',w: 70 }
  ];
  // Distribuye el ancho remanente al primer item flexible (cliente) para llenar la página
  const usado = cols.reduce((a, c) => a + c.w, 0);
  if (usado < ancho) cols[1].w += (ancho - usado);
  let acc = x0;
  for (const c of cols) { c.x = acc; acc += c.w; }

  let y = dibujarCabeceraPagina();

  function dibujarHeaderTabla() {
    doc.rect(x0, y, ancho, 18).fill(PALETA.acento);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
    for (const c of cols) {
      doc.text(c.titulo, c.x + 4, y + 5, { width: c.w - 8, align: c.align || 'left' });
    }
    y += 20;
  }
  dibujarHeaderTabla();

  doc.font('Helvetica').fontSize(8).fillColor(PALETA.texto);
  let alterna = false;
  for (const cot of cotizaciones) {
    const fila = mapearFila(cot);
    const alturas = cols.map(c => doc.heightOfString(String(fila[c.key] ?? ''), { width: c.w - 8 }));
    const altura = Math.max(14, Math.max(...alturas) + 6);

    if (y + altura > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = dibujarCabeceraPagina();
      dibujarHeaderTabla();
      doc.font('Helvetica').fontSize(8).fillColor(PALETA.texto);
    }
    if (alterna) {
      doc.rect(x0, y - 2, ancho, altura).fill('#fafafa').fillColor(PALETA.texto);
    }
    alterna = !alterna;
    for (const c of cols) {
      doc.text(String(fila[c.key] ?? ''), c.x + 4, y + 2, { width: c.w - 8, align: c.align || 'left' });
    }
    y += altura;
    doc.moveTo(x0, y).lineTo(x0 + ancho, y).strokeColor(PALETA.grisClaro).lineWidth(0.4).stroke();
  }

  doc.end();
  return cerrado;
}

module.exports = { generarExcelCotizaciones, generarPdfCotizaciones };

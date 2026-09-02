/**
 * Generación de reportes de listado de ascensores en Excel (XLSX) y PDF (A4 horizontal).
 *
 * Devuelven Buffer para que el controller los streamee en la respuesta HTTP.
 * Datos de cabecera (razón social, RUC, etc.) salen de tbl_configuracion — sin hardcodeo.
 *
 * El controller ya aplicó los filtros de pantalla y el ámbito del usuario: aquí
 * solo se formatea lo que llega.
 */

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const configuracion = require('./configuracion');
const { ymdLima } = require('./tiempo');
const { CLASIFICACIONES } = require('./catalogosClientes');
const { etiquetaMoneda } = require('./catalogosBancarios');

// Máscara del año: sin separador de miles (2026, no "2,026").
const FMT_ANIO = '0';
const FMT_ENTERO = '#,##0';

const CLASIFICACION_MAP = Object.fromEntries(CLASIFICACIONES.map(c => [c.codigo, c.etiqueta]));

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

const COLUMNAS = [
  { header: 'Código',              key: 'codigo',                width: 16 },
  { header: 'Edificio / Obra',     key: 'edificio',              width: 30 },
  { header: 'Cliente',             key: 'cliente',               width: 32 },
  { header: 'Distrito',            key: 'distrito',              width: 16 },
  { header: 'Tipo',                key: 'tipo',                  width: 16 },
  { header: 'Clasificación',       key: 'clasificacion',         width: 14 },
  { header: 'Marca',               key: 'marca',                 width: 16 },
  { header: 'Modelo',              key: 'modelo',                width: 16 },
  { header: 'Capacidad',           key: 'capacidad',             width: 16 },
  { header: 'Pisos',               key: 'pisos',                 width: 8,  numFmt: FMT_ENTERO },
  { header: 'Año aprox.',          key: 'anio_aproximado',       width: 11, numFmt: FMT_ANIO },
  { header: 'Ubicación',           key: 'ubicacion',             width: 24 },
  { header: 'Estado operativo',    key: 'estado_operativo',      width: 18 },
  { header: 'Registro',            key: 'registro',              width: 11 },
  { header: 'Instalación',         key: 'fecha_instalacion',     width: 13 },
  { header: 'Próx. mantenimiento', key: 'proximo_mantenimiento', width: 17 },
  { header: 'Moneda',              key: 'moneda',                width: 10 },
  { header: 'Precios por servicio',key: 'precios',               width: 40 },
  { header: 'Observaciones',       key: 'observaciones',         width: 30 },
  { header: 'Registrado',          key: 'registrado',            width: 12 }
];

function mapearFila(a) {
  const precios = Array.isArray(a.precios) ? a.precios : [];
  return {
    codigo: a.codigo || '',
    edificio: a.edificio?.nombre || '',
    cliente: a.edificio?.cliente?.nombre || '',
    distrito: a.edificio?.distrito || '',
    tipo: a.tipo || '',
    clasificacion: a.clasificacion ? (CLASIFICACION_MAP[a.clasificacion] || a.clasificacion) : '',
    marca: a.marca || '',
    modelo: a.modelo || '',
    capacidad: a.capacidad || '',
    pisos: a.pisos ?? '',
    anio_aproximado: a.anio_aproximado ?? '',
    ubicacion: a.ubicacion || '',
    estado_operativo: a.estado_operativo || '',
    // `estado` es la baja lógica; el listado permite exportar activos e inactivos.
    registro: a.estado === 0 ? 'Inactivo' : 'Activo',
    fecha_instalacion: fechaISO(a.fecha_instalacion),
    proximo_mantenimiento: fechaISO(a.proximo_mantenimiento),
    // Un ascensor tiene un precio por subtipo de servicio: el detalle va como
    // texto y esta columna resume la(s) divisa(s) para poder filtrar por ella.
    moneda: [...new Set(precios.map(p => etiquetaMoneda(p.moneda)).filter(Boolean))].join(', '),
    precios: precios
      .map(p => `${p.tipo_servicio?.nombre || `Subtipo #${p.id_tipo_servicio}`}: ${p.moneda} ${Number(p.precio).toFixed(2)}`)
      .join(' · '),
    observaciones: a.observaciones || '',
    registrado: fechaISO(a.date_time_registration)
  };
}

async function generarExcelAscensores(ascensores) {
  const empresa = await configuracion.obtenerVarios(['EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC']);
  const hoy = ymdLima();

  const wb = new ExcelJS.Workbook();
  wb.creator = empresa.EMPRESA_RAZON_SOCIAL || 'ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet('Ascensores', {
    views: [{ state: 'frozen', ySplit: 4 }]
  });

  // Cabecera de empresa
  ws.mergeCells('A1', String.fromCharCode(64 + COLUMNAS.length) + '1');
  ws.getCell('A1').value = empresa.EMPRESA_RAZON_SOCIAL || '';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F2937' } };
  ws.getCell('A1').alignment = { vertical: 'middle' };

  ws.mergeCells('A2', String.fromCharCode(64 + COLUMNAS.length) + '2');
  const subtitulo = [`RUC: ${empresa.EMPRESA_RUC || '—'}`, `Exportado: ${hoy}`, `${ascensores.length} ascensor(es)`].join('   •   ');
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
  ascensores.forEach((a, idx) => {
    const fila = ws.addRow(mapearFila(a));
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

async function generarPdfAscensores(ascensores) {
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
      .text('LISTADO DE ASCENSORES', x0, y + 8, { align: 'right', width: ancho - 10 });
    doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
      .text(`Exportado: ${hoy}   •   ${ascensores.length} ascensor(es)`, x0, y + 28, { align: 'right', width: ancho - 10 });
    return y + 65;
  }

  // Columnas a renderizar en PDF (subset orientado a impresión)
  const cols = [
    { titulo: 'Código',        key: 'codigo',                w: 75 },
    { titulo: 'Edificio / Obra', key: 'edificio',            w: 95 },
    { titulo: 'Cliente',       key: 'cliente',               w: 100 },
    { titulo: 'Distrito',      key: 'distrito',              w: 55 },
    { titulo: 'Tipo',          key: 'tipo',                  w: 60 },
    { titulo: 'Clasif.',       key: 'clasificacion',         w: 55 },
    { titulo: 'Marca',         key: 'marca',                 w: 55 },
    { titulo: 'Ubicación',     key: 'ubicacion',             w: 70 },
    { titulo: 'Estado oper.',  key: 'estado_operativo',      w: 65 },
    { titulo: 'Registro',      key: 'registro',              w: 45 },
    { titulo: 'Próx. mant.',   key: 'proximo_mantenimiento', w: 55 }
  ];
  // Distribuye el ancho remanente al primer item flexible (cliente) para llenar la página
  const usado = cols.reduce((a, c) => a + c.w, 0);
  if (usado < ancho) cols[2].w += (ancho - usado);
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
  for (const ascensor of ascensores) {
    const fila = mapearFila(ascensor);
    // calcular altura por el texto más largo de la fila
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

module.exports = { generarExcelAscensores, generarPdfAscensores };

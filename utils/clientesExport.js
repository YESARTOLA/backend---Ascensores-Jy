/**
 * Generación de reportes de listado de clientes en Excel (XLSX) y PDF (A4 horizontal).
 *
 * Devuelven Buffer para que el controller los stremee en la respuesta HTTP.
 * Datos de cabecera (razón social, RUC, etc.) salen de tbl_configuracion — sin hardcodeo.
 */

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const configuracion = require('./configuracion');
const { ymdLima } = require('./tiempo');
const { CLASIFICACIONES } = require('./catalogosClientes');

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

function estadoContrato(c, hoyISO) {
  if (!c.contrato_inicio || !c.contrato_fin) return 'Sin contrato';
  const fin = String(c.contrato_fin).slice(0, 10);
  const inicio = String(c.contrato_inicio).slice(0, 10);
  if (fin < hoyISO) return 'Vencido';
  if (inicio > hoyISO) return 'Pendiente';
  return 'Vigente';
}

const COLUMNAS = [
  { header: 'Nombre',                 key: 'nombre',                 width: 36 },
  { header: 'Tipo',                   key: 'tipo',                   width: 12 },
  { header: 'Edificio',               key: 'nombre_edificio',        width: 28 },
  { header: 'Clasificación',          key: 'clasificacion',          width: 14 },
  { header: 'Tipo doc.',              key: 'tipo_documento',         width: 10 },
  { header: 'Número doc.',            key: 'numero_documento',       width: 15 },
  { header: 'Teléfono',               key: 'telefono',               width: 14 },
  { header: 'WhatsApp',               key: 'whatsapp',               width: 14 },
  { header: 'Correo',                 key: 'correo',                 width: 26 },
  { header: 'Dirección',              key: 'direccion',              width: 32 },
  { header: 'Distrito',               key: 'distrito',               width: 16 },
  { header: 'Contacto principal',     key: 'contacto_principal',     width: 30 },
  { header: 'Contacto cobranzas',     key: 'contacto_cobranzas',     width: 30 },
  { header: 'Contacto administrativo',key: 'contacto_admin',         width: 30 },
  { header: 'Inicio contrato',        key: 'contrato_inicio',        width: 13 },
  { header: 'Fin contrato',           key: 'contrato_fin',           width: 13 },
  { header: 'Estado contrato',        key: 'estado_contrato',        width: 14 },
  { header: 'Contrato adjunto',       key: 'contrato_adjunto',       width: 18 },
  { header: 'Adjuntos',               key: 'adjuntos',               width: 10 },
  { header: 'Ascensores',             key: 'ascensores',             width: 11 },
  { header: 'Servicios',              key: 'servicios',              width: 10 },
  { header: 'Observaciones',          key: 'observaciones',          width: 30 },
  { header: 'Registrado',             key: 'registrado',             width: 12 }
];

function formateaContacto(nombre, correo, telefono) {
  const partes = [nombre, correo, telefono].filter(Boolean);
  return partes.join(' · ');
}

function mapearFila(c, hoyISO) {
  return {
    nombre: c.nombre || '',
    tipo: c.tipo || '',
    nombre_edificio: c.nombre_edificio || '',
    clasificacion: c.clasificacion ? (CLASIFICACION_MAP[c.clasificacion] || c.clasificacion) : '',
    tipo_documento: c.tipo_documento || '',
    numero_documento: c.numero_documento || '',
    telefono: c.telefono || '',
    whatsapp: c.whatsapp || '',
    correo: c.correo || '',
    direccion: c.direccion || '',
    distrito: c.distrito || '',
    contacto_principal: formateaContacto(c.contacto_principal_nombre, c.contacto_principal_correo, c.contacto_principal_telefono),
    contacto_cobranzas: formateaContacto(c.contacto_cobranzas_nombre, c.contacto_cobranzas_correo, c.contacto_cobranzas_telefono),
    contacto_admin: formateaContacto(c.contacto_admin_nombre, c.contacto_admin_correo, c.contacto_admin_telefono),
    contrato_inicio: fechaISO(c.contrato_inicio),
    contrato_fin: fechaISO(c.contrato_fin),
    estado_contrato: estadoContrato(c, hoyISO),
    contrato_adjunto: c.archivo_contrato?.nombre_original || '',
    adjuntos: c._count?.archivos ?? (Array.isArray(c.archivos) ? c.archivos.length : 0),
    ascensores: c._count?.ascensores ?? 0,
    servicios: c._count?.servicios ?? 0,
    observaciones: c.observaciones || '',
    registrado: fechaISO(c.date_time_registration)
  };
}

async function generarExcelClientes(clientes) {
  const empresa = await configuracion.obtenerVarios(['EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC']);
  const hoy = ymdLima();

  const wb = new ExcelJS.Workbook();
  wb.creator = empresa.EMPRESA_RAZON_SOCIAL || 'ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet('Clientes', {
    views: [{ state: 'frozen', ySplit: 4 }]
  });

  // Cabecera de empresa
  ws.mergeCells('A1', String.fromCharCode(64 + COLUMNAS.length) + '1');
  ws.getCell('A1').value = empresa.EMPRESA_RAZON_SOCIAL || '';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F2937' } };
  ws.getCell('A1').alignment = { vertical: 'middle' };

  ws.mergeCells('A2', String.fromCharCode(64 + COLUMNAS.length) + '2');
  const subtitulo = [`RUC: ${empresa.EMPRESA_RUC || '—'}`, `Exportado: ${hoy}`, `${clientes.length} cliente(s)`].join('   •   ');
  ws.getCell('A2').value = subtitulo;
  ws.getCell('A2').font = { size: 9, color: { argb: 'FF6B7280' } };

  // Encabezados de tabla en fila 4
  ws.columns = COLUMNAS.map(c => ({ key: c.key, width: c.width }));
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
  clientes.forEach((c, idx) => {
    const fila = ws.addRow(mapearFila(c, hoy));
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

async function generarPdfClientes(clientes) {
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
      .text('LISTADO DE CLIENTES', x0, y + 8, { align: 'right', width: ancho - 10 });
    doc.font('Helvetica').fontSize(8).fillColor(PALETA.gris)
      .text(`Exportado: ${hoy}   •   ${clientes.length} cliente(s)`, x0, y + 28, { align: 'right', width: ancho - 10 });
    return y + 65;
  }

  // Columnas a renderizar en PDF (subset orientado a impresión)
  const cols = [
    { titulo: 'Cliente',          key: 'nombre',                 w: 100 },
    { titulo: 'Edificio',         key: 'nombre_edificio',        w: 80 },
    { titulo: 'Clasif.',          key: 'clasificacion',          w: 60 },
    { titulo: 'Doc.',             key: 'numero_documento',       w: 55 },
    { titulo: 'Teléfono',         key: 'telefono',               w: 60 },
    { titulo: 'Distrito',         key: 'distrito',               w: 55 },
    { titulo: 'Contacto princ.',  key: 'contacto_principal',     w: 100 },
    { titulo: 'Inicio',           key: 'contrato_inicio',        w: 50 },
    { titulo: 'Fin',              key: 'contrato_fin',           w: 50 },
    { titulo: 'Estado',           key: 'estado_contrato',        w: 55 },
    { titulo: 'Asc.',             key: 'ascensores',             w: 30, align: 'right' },
    { titulo: 'Svc.',             key: 'servicios',              w: 30, align: 'right' }
  ];
  // Distribuye el ancho remanente al primer item flexible (nombre) para llenar la página
  const usado = cols.reduce((a, c) => a + c.w, 0);
  if (usado < ancho) cols[0].w += (ancho - usado);
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
  for (const cliente of clientes) {
    const fila = mapearFila(cliente, hoy);
    // calcular altura por descripción más larga
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

module.exports = { generarExcelClientes, generarPdfClientes };

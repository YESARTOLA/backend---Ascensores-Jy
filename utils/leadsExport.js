/**
 * Generación del listado de leads en Excel (XLSX). Devuelve un Buffer para que
 * el controller lo streamee en la respuesta HTTP. Datos de cabecera (razón
 * social, RUC) salen de la empresa emisora predeterminada
 * (utils/empresaEmisora.js) — sin hardcodeo. Espejo del patrón de
 * `cotizacionesExport.js`.
 */

const ExcelJS = require('exceljs');
const { obtenerDatosEmpresa } = require('./empresaEmisora');
const { ymdLima, hmLima } = require('./tiempo');
const { BUEN_PAGADOR_SIN_CALIFICAR } = require('./datosLead');

// Máscara de los conteos: enteros, para que sumen y filtren como números.
const FMT_ENTERO = '#,##0';

// Fecha y hora de Lima en texto ordenable ("2026-11-05 10:30"), igual que la
// columna «Registrado» de la tabla.
function fechaHoraLima(d) {
  if (!d) return '';
  const fecha = new Date(d);
  return `${ymdLima(fecha)} ${hmLima(fecha)}`;
}

const COLUMNAS = [
  { header: 'Contacto',             key: 'contacto',          width: 28 },
  { header: 'Teléfono',             key: 'telefono',          width: 14 },
  { header: 'Correo',               key: 'correo',            width: 26 },
  { header: 'Razón social',         key: 'razon_social',      width: 30 },
  { header: 'Tipo doc.',            key: 'tipo_documento',    width: 10 },
  { header: 'Número doc.',          key: 'numero_documento',  width: 14 },
  { header: 'Proyecto',             key: 'proyecto',          width: 28 },
  { header: 'Tipo de ascensor',     key: 'tipo_ascensor',     width: 18 },
  { header: 'Distrito',             key: 'distrito',          width: 18 },
  { header: 'Provincia',            key: 'provincia',         width: 16 },
  { header: 'Departamento',         key: 'departamento',      width: 16 },
  { header: 'Canal',                key: 'canal',             width: 14 },
  { header: 'Tipo de servicio',     key: 'tipo_servicio',     width: 18 },
  { header: 'Servicio solicitado',  key: 'servicio',          width: 24 },
  { header: 'Cliente',              key: 'cliente',           width: 30 },
  { header: 'Vendedora',            key: 'vendedor',          width: 22 },
  { header: 'Ref. de pago',         key: 'buen_pagador',      width: 18 },
  { header: 'Estado',               key: 'estado',            width: 13 },
  { header: 'Motivo de descarte',   key: 'motivo_descarte',   width: 30 },
  { header: 'Observaciones',        key: 'observaciones',     width: 36 },
  { header: 'Documentos',           key: 'documentos',        width: 12, numFmt: FMT_ENTERO },
  { header: 'Registrado',           key: 'registrado',        width: 17 },
  { header: 'Registrado por',       key: 'registrado_por',    width: 22 },
  { header: 'Rol',                  key: 'rol',               width: 18 }
];

function mapearFila(l) {
  return {
    contacto: l.nombre_contacto || '',
    telefono: l.telefono || '',
    correo: l.correo || '',
    razon_social: l.razon_social || '',
    tipo_documento: l.ruc ? (l.tipo_documento || '') : '',
    numero_documento: l.ruc || '',
    proyecto: l.nombre_proyecto || '',
    tipo_ascensor: l.tipo_ascensor?.nombre || '',
    distrito: l.ubigeo?.distrito || '',
    provincia: l.ubigeo?.provincia || '',
    departamento: l.ubigeo?.departamento || '',
    canal: l.canal || '',
    // Tipo padre del servicio solicitado: es la pestaña en la que aparece el lead.
    tipo_servicio: l.tipo_servicio?.padre?.nombre || '',
    servicio: l.tipo_servicio?.nombre || '',
    cliente: l.cliente?.nombre || '',
    vendedor: l.vendedor?.nombres || '',
    buen_pagador: l.buen_pagador || BUEN_PAGADOR_SIN_CALIFICAR,
    estado: l.estado_lead || '',
    motivo_descarte: l.motivo_descarte || '',
    observaciones: l.observaciones || '',
    documentos: l._count?.documentos ?? 0,
    registrado: fechaHoraLima(l.date_time_registration),
    registrado_por: l.usuario_registrador?.nombres || '',
    rol: l.rol_nombre_registrador || ''
  };
}

/**
 * @param {Array} leads - filas ya filtradas (mismo where y alcance que el listado)
 * @param {object} [opts]
 * @param {string[]} [opts.filtros] - filtros activos en palabras; van en la
 *   fila 3 para que el archivo diga qué recorte del listado contiene.
 */
async function generarExcelLeads(leads, { filtros = [] } = {}) {
  const empresa = await obtenerDatosEmpresa();
  const hoy = ymdLima();

  const wb = new ExcelJS.Workbook();
  wb.creator = empresa.EMPRESA_RAZON_SOCIAL || 'ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet('Leads', {
    views: [{ state: 'frozen', ySplit: 4 }]
  });
  // Última columna de las filas combinadas de cabecera.
  const fin = ws.getColumn(COLUMNAS.length).letter;

  // Cabecera de empresa
  ws.mergeCells(`A1:${fin}1`);
  ws.getCell('A1').value = empresa.EMPRESA_RAZON_SOCIAL || '';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F2937' } };
  ws.getCell('A1').alignment = { vertical: 'middle' };

  ws.mergeCells(`A2:${fin}2`);
  const subtitulo = [`RUC: ${empresa.EMPRESA_RUC || '—'}`, `Exportado: ${hoy}`, `${leads.length} lead(s)`].join('   •   ');
  ws.getCell('A2').value = subtitulo;
  ws.getCell('A2').font = { size: 9, color: { argb: 'FF6B7280' } };

  ws.mergeCells(`A3:${fin}3`);
  ws.getCell('A3').value = filtros.length
    ? `Filtros: ${filtros.join('   •   ')}`
    : 'Filtros: ninguno (todos los leads)';
  ws.getCell('A3').font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };

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
  leads.forEach((lead, idx) => {
    const fila = ws.addRow(mapearFila(lead));
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

module.exports = { generarExcelLeads };

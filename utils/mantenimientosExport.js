/**
 * Generación del reporte de programaciones de mantenimiento agrupado por
 * cliente en formato Excel.
 *
 * El PDF se genera ahora en el frontend usando utils/pdfReport.js para
 * reutilizar la portada/header/footer corporativa de Ascensores Jy. Aquí
 * dejamos un generador PDF mínimo solo como fallback del endpoint
 * `/exportar?formato=pdf` (por si se consume desde un cliente que no quiere
 * generar el PDF localmente).
 *
 * Cabecera empresa se obtiene de tbl_configuracion — sin hardcodeo.
 */

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const configuracion = require('./configuracion');
const { ymdLima } = require('./tiempo');
const { obtenerFrecuencia } = require('./frecuenciaMantenimiento');
const { totalesDelPlan } = require('./planMantenimientoMensual');

// Paleta corporativa (espejada con frontend/src/utils/pdfReport.js)
const BRAND = {
  teal:       'FF4D8093',
  tealDark:   'FF283E49',
  tealMid:    'FF365867',
  ember:      'FFE8853A',
  emberDark:  'FFAD5826',
  ivory:      'FFFDFAF5',
  ivoryMid:   'FFF9F3E8',
  carbon:     'FF1A1812',
  carbonMid:  'FF564F3F',
  carbonLow:  'FF928773',
  hairline:   'FFECE8DF',
  paper:      'FFFFFFFF'
};

function fechaISO(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

function fechaHoraISO(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${dt.toISOString().slice(0, 10)} ${dt.toISOString().slice(11, 16)}`;
}

/**
 * Frecuencia del plan para el reporte. Cada ascensor tiene la suya, así que
 * se listan las distintas ("Mensual, Trimestral"); si el plan no las tiene
 * por ascensor (creado antes del modelo por-ascensor) cae a la del plan.
 */
function labelFrecuencia(plan) {
  if (!plan) return '';
  if (plan.tipo_plan === 'eventual') return 'Eventual';
  const etiquetaDe = (cod, dias) => {
    const fr = obtenerFrecuencia(cod);
    let e = fr ? fr.etiqueta : cod;
    if (cod === 'custom' && dias) e += ` (${dias} días)`;
    return e;
  };
  const propias = [...new Set(
    (plan.ascensores || [])
      .filter(a => a.frecuencia)
      .map(a => etiquetaDe(a.frecuencia, a.frecuencia_dias_custom))
  )];
  if (propias.length > 0) return propias.join(', ');
  return etiquetaDe(plan.frecuencia, plan.frecuencia_dias_custom);
}

function formatMonto(monto, moneda) {
  if (monto == null) return '';
  const simbolo = moneda === 'USD' ? '$' : 'S/';
  return `${simbolo} ${Number(monto).toFixed(2)}`;
}

function _descripcionFiltros(filtros) {
  const partes = [];
  if (filtros.ids_cliente?.length > 0) partes.push(`Clientes seleccionados: ${filtros.ids_cliente.length}`);
  else partes.push('Todos los clientes');
  if (filtros.ids_ascensor?.length > 0) partes.push(`Ascensores: ${filtros.ids_ascensor.length}`);
  if (filtros.estado_ejecucion) partes.push(`Estado: ${filtros.estado_ejecucion}`);
  if (filtros.desde || filtros.hasta) partes.push(`Periodo: ${filtros.desde || '—'} → ${filtros.hasta || '—'}`);
  return partes.join('   •   ');
}

function _nombreHojaExcel(nombre, fallback) {
  const limpio = String(nombre || '').replace(/[\\/?*[\]:]/g, '').trim();
  const truncado = limpio.length > 31 ? limpio.slice(0, 31) : limpio;
  return truncado || fallback;
}

// Columnas del bloque "Programaciones" del reporte (mismas para Excel y PDF).
const COLUMNAS_PROG = [
  { header: 'Fecha programada', key: 'fecha_programada', width: 18 },
  { header: 'Ascensor',         key: 'ascensor',          width: 14 },
  { header: 'Ubicación',        key: 'ubicacion',         width: 22 },
  { header: 'Tipo servicio',    key: 'tipo_servicio',     width: 22 },
  { header: 'Origen',           key: 'origen',            width: 14 },
  { header: 'Estado',           key: 'estado',            width: 14 },
  { header: 'Inicio real',      key: 'inicio_real',       width: 18 },
  { header: 'Fin real',         key: 'fin_real',          width: 18 },
  { header: 'Días',             key: 'dias',              width: 6 },
  { header: 'Gratis',           key: 'gratis',            width: 7 },
  { header: 'Servicio',         key: 'codigo_servicio',   width: 14 }
];

const COLUMNAS_PLAN = [
  { header: 'Ascensor',          key: 'ascensor',         width: 14 },
  { header: 'Ubicación',         key: 'ubicacion',        width: 24 },
  { header: 'Tipo servicio',     key: 'tipo_servicio',    width: 22 },
  { header: 'Modalidad',         key: 'modalidad',        width: 12 },
  { header: 'Frecuencia',        key: 'frecuencia',       width: 26 },
  { header: 'Duración (meses)',  key: 'duracion_meses',   width: 15 },
  { header: 'Mantenimientos',    key: 'cantidad',         width: 15 },
  { header: 'Ejecutados',        key: 'ejecutados',       width: 12 },
  { header: 'Gratuitos',         key: 'gratuitos',        width: 12 },
  { header: 'Inicio',            key: 'inicio',           width: 14 },
  { header: 'Meses facturables', key: 'meses_facturables', width: 16 },
  { header: 'Monto mensual',     key: 'monto_mensual',    width: 14 },
  { header: 'Total del plan',    key: 'precio',           width: 14 },
  { header: 'Estado plan',       key: 'estado_plan',      width: 12 }
];

function _origenInstancia(i) {
  if (i.tipo_instancia === 'servicio') return 'Servicio';
  if (i.tipo_instancia === 'evento_futuro') return 'Evento';
  if (i.tipo_instancia === 'proyeccion') return 'Proyectado';
  return '—';
}

function _mapearFilaPrograma(i) {
  return {
    fecha_programada: fechaISO(i.fecha_programada),
    ascensor: i.ascensor_codigo || '',
    ubicacion: i.ascensor_ubicacion || '',
    tipo_servicio: i.tipo_servicio || '',
    origen: _origenInstancia(i),
    estado: i.estado_ejecucion || '',
    inicio_real: fechaHoraISO(i.fecha_inicio_real),
    fin_real: fechaHoraISO(i.fecha_fin_real),
    dias: i.dias_ejecucion ?? '',
    gratis: i.es_mantenimiento_gratuito ? 'Sí' : '',
    codigo_servicio: i.codigo_servicio || ''
  };
}

function _mapearFilaPlan(p) {
  // Un plan cubre N ascensores; el precio total es la suma de sus montos.
  const ascs = (p.ascensores || []).map(a => a.ascensor).filter(Boolean);
  // El importe del plan es el monto MENSUAL global; el total descuenta los
  // meses gratuitos (SSoT: utils/planMantenimientoMensual.totalesDelPlan).
  const tot = totalesDelPlan(p);
  const mensual = tot.monto_mensual;
  const meses = tot.meses;
  const moneda = p.moneda || (p.ascensores || [])[0]?.moneda || 'PEN';
  return {
    ascensor: ascs.map(a => a.codigo).filter(Boolean).join(', '),
    ubicacion: ascs.map(a => a.ubicacion).filter(Boolean).join(', '),
    tipo_servicio: p.tipo_servicio?.nombre || '',
    modalidad: p.tipo_plan ? p.tipo_plan.charAt(0).toUpperCase() + p.tipo_plan.slice(1) : '',
    frecuencia: labelFrecuencia(p),
    duracion_meses: meses || 'Indef.',
    cantidad: p.cantidad_mantenimientos ?? 'Indef.',
    ejecutados: p.mantenimientos_ejecutados_total ?? 0,
    gratuitos: `${p.mantenimientos_gratuitos_ejecutados || 0} / ${p.cantidad_mantenimientos_gratuitos || 0}`,
    inicio: fechaISO(p.fecha_inicio),
    monto_mensual: formatMonto(mensual, moneda),
    meses_facturables: tot.meses_facturables,
    precio: formatMonto(tot.total, moneda),
    estado_plan: p.estado_plan || ''
  };
}

function _aplicarEstilosCabecera(cell, fillArgb = BRAND.tealDark, color = 'FFFFFFFF') {
  cell.font = { bold: true, color: { argb: color }, size: 10 };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  cell.border = {
    top:    { style: 'thin', color: { argb: BRAND.hairline } },
    bottom: { style: 'thin', color: { argb: BRAND.hairline } },
    left:   { style: 'thin', color: { argb: BRAND.hairline } },
    right:  { style: 'thin', color: { argb: BRAND.hairline } }
  };
}

function _dibujarPortadaResumen(ws, empresa, hoy, dataset, filtros) {
  // Carátula del libro: cabecera empresa, título, filtros y tabla resumen.
  ws.mergeCells('A1', 'F1');
  ws.getCell('A1').value = empresa.EMPRESA_RAZON_SOCIAL || 'Ascensores Jy S.A.C.';
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: BRAND.tealDark } };
  ws.getCell('A1').alignment = { vertical: 'middle' };

  ws.mergeCells('A2', 'F2');
  ws.getCell('A2').value = `RUC ${empresa.EMPRESA_RUC || '—'}   •   ${empresa.EMPRESA_DIRECCION || ''}`.trim();
  ws.getCell('A2').font = { size: 9, color: { argb: BRAND.carbonMid } };

  ws.mergeCells('A4', 'F4');
  ws.getCell('A4').value = 'REPORTE · PROGRAMACIONES DE MANTENIMIENTO';
  ws.getCell('A4').font = { bold: true, size: 12, color: { argb: BRAND.emberDark } };

  ws.mergeCells('A5', 'F5');
  ws.getCell('A5').value = `Generado: ${hoy}   •   ${dataset.length} cliente(s)`;
  ws.getCell('A5').font = { size: 9, color: { argb: BRAND.carbonMid } };

  ws.mergeCells('A6', 'F6');
  ws.getCell('A6').value = `Filtros aplicados: ${_descripcionFiltros(filtros)}`;
  ws.getCell('A6').font = { size: 9, italic: true, color: { argb: BRAND.carbonLow } };

  const resumenCols = [
    { header: 'Cliente',              key: 'cliente',     width: 38 },
    { header: 'Planes activos',       key: 'planes',      width: 14 },
    { header: 'Programaciones',       key: 'total',       width: 16 },
    { header: 'Pendientes',           key: 'pendientes',  width: 12 },
    { header: 'Realizados',           key: 'realizados',  width: 12 },
    { header: 'En curso / Proy.',     key: 'otros',       width: 18 }
  ];
  resumenCols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  const headRow = ws.getRow(8);
  resumenCols.forEach((c, i) => {
    headRow.getCell(i + 1).value = c.header;
    _aplicarEstilosCabecera(headRow.getCell(i + 1));
  });
  headRow.height = 22;

  let r = 9;
  for (const g of dataset) {
    const totalProg = g.programaciones.length;
    const pendientes = g.programaciones.filter(p => p.estado_ejecucion === 'Pendiente').length;
    const realizados = g.programaciones.filter(p => p.estado_ejecucion === 'Realizado').length;
    const enCurso = g.programaciones.filter(p => p.estado_ejecucion === 'En curso').length;
    const proyectados = g.programaciones.filter(p => p.estado_ejecucion === 'Proyectado').length;
    const row = ws.getRow(r);
    row.getCell(1).value = g.cliente?.nombre || '';
    row.getCell(2).value = g.planes.length;
    row.getCell(3).value = totalProg;
    row.getCell(4).value = pendientes;
    row.getCell(5).value = realizados;
    row.getCell(6).value = enCurso + proyectados;
    row.font = { size: 10, color: { argb: BRAND.carbon } };
    if ((r - 9) % 2 === 1) {
      row.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.ivoryMid } }; });
    }
    r += 1;
  }

  ws.views = [{ state: 'frozen', ySplit: 8 }];
}

function _dibujarHojaCliente(ws, empresa, hoy, grupo) {
  ws.mergeCells('A1', String.fromCharCode(64 + COLUMNAS_PROG.length) + '1');
  ws.getCell('A1').value = grupo.cliente?.nombre || '';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: BRAND.tealDark } };

  const docCliente = [grupo.cliente?.tipo_documento, grupo.cliente?.numero_documento].filter(Boolean).join(' ');
  // La ubicación (edificio/distrito) ahora vive a nivel de ascensor; el detalle
  // por edificio se ve en cada fila de programación.
  const subPartes = [docCliente].filter(Boolean);
  subPartes.push(`Exportado: ${hoy}`);
  ws.mergeCells('A2', String.fromCharCode(64 + COLUMNAS_PROG.length) + '2');
  ws.getCell('A2').value = subPartes.join('   •   ');
  ws.getCell('A2').font = { size: 9, color: { argb: BRAND.carbonMid } };

  let cursor = 4;

  // Bloque planes
  ws.getCell(`A${cursor}`).value = 'PLANES ACTIVOS POR ASCENSOR';
  ws.getCell(`A${cursor}`).font = { bold: true, size: 10, color: { argb: BRAND.emberDark } };
  cursor += 1;

  const headPlan = ws.getRow(cursor);
  COLUMNAS_PLAN.forEach((c, i) => {
    headPlan.getCell(i + 1).value = c.header;
    _aplicarEstilosCabecera(headPlan.getCell(i + 1));
    ws.getColumn(i + 1).width = Math.max(ws.getColumn(i + 1).width || 0, c.width);
  });
  headPlan.height = 20;
  cursor += 1;

  if (grupo.planes.length === 0) {
    ws.getCell(`A${cursor}`).value = 'Sin planes activos para los filtros seleccionados.';
    ws.getCell(`A${cursor}`).font = { italic: true, size: 10, color: { argb: BRAND.carbonLow } };
    cursor += 1;
  } else {
    grupo.planes.forEach((p, idx) => {
      const fila = ws.getRow(cursor);
      const datos = _mapearFilaPlan(p);
      COLUMNAS_PLAN.forEach((c, i) => { fila.getCell(i + 1).value = datos[c.key]; });
      fila.font = { size: 10, color: { argb: BRAND.carbon } };
      if (idx % 2 === 1) {
        fila.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.ivoryMid } }; });
      }
      cursor += 1;
    });
  }
  cursor += 1;

  // Bloque programaciones
  ws.getCell(`A${cursor}`).value = 'PROGRAMACIONES';
  ws.getCell(`A${cursor}`).font = { bold: true, size: 10, color: { argb: BRAND.emberDark } };
  cursor += 1;

  const headProg = ws.getRow(cursor);
  COLUMNAS_PROG.forEach((c, i) => {
    headProg.getCell(i + 1).value = c.header;
    _aplicarEstilosCabecera(headProg.getCell(i + 1));
    ws.getColumn(i + 1).width = Math.max(ws.getColumn(i + 1).width || 0, c.width);
  });
  headProg.height = 20;
  const filaInicioTabla = cursor;
  cursor += 1;

  if (grupo.programaciones.length === 0) {
    ws.getCell(`A${cursor}`).value = 'Sin programaciones para los filtros seleccionados.';
    ws.getCell(`A${cursor}`).font = { italic: true, size: 10, color: { argb: BRAND.carbonLow } };
  } else {
    grupo.programaciones.forEach((i, idx) => {
      const fila = ws.getRow(cursor);
      const datos = _mapearFilaPrograma(i);
      COLUMNAS_PROG.forEach((c, k) => { fila.getCell(k + 1).value = datos[c.key]; });
      fila.font = { size: 10, color: { argb: BRAND.carbon } };
      if (idx % 2 === 1) {
        fila.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.ivoryMid } }; });
      }
      cursor += 1;
    });
    ws.autoFilter = {
      from: { row: filaInicioTabla, column: 1 },
      to:   { row: filaInicioTabla, column: COLUMNAS_PROG.length }
    };
  }

  ws.views = [{ state: 'frozen', ySplit: 4 }];
}

async function generarExcelMantenimientos({ dataset, filtros }) {
  const empresa = await configuracion.obtenerVarios([
    'EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC', 'EMPRESA_DIRECCION'
  ]);
  const hoy = ymdLima();

  const wb = new ExcelJS.Workbook();
  wb.creator = empresa.EMPRESA_RAZON_SOCIAL || 'Ascensores Jy S.A.C.';
  wb.created = new Date();

  // Hoja-carátula con resumen ejecutivo (siempre presente)
  const wsResumen = wb.addWorksheet('Resumen');
  _dibujarPortadaResumen(wsResumen, empresa, hoy, dataset, filtros);

  // Una hoja por cliente
  const usados = new Map();
  dataset.forEach((g, idx) => {
    let nombre = _nombreHojaExcel(g.cliente?.nombre, `Cliente ${idx + 1}`);
    const base = nombre;
    let n = 1;
    while (usados.has(nombre)) {
      n += 1;
      const sufijo = ` (${n})`;
      nombre = base.slice(0, 31 - sufijo.length) + sufijo;
    }
    usados.set(nombre, true);
    const ws = wb.addWorksheet(nombre);
    _dibujarHojaCliente(ws, empresa, hoy, g);
  });

  return wb.xlsx.writeBuffer().then(b => Buffer.from(b));
}

/**
 * PDF mínimo (fallback) — el frontend usa generarReportePDF para producir
 * el PDF con carátula corporativa rica. Este generador queda como fallback
 * para clientes que consuman el endpoint sin pasar por el navegador.
 */
async function generarPdfMantenimientos({ dataset, filtros }) {
  const empresa = await configuracion.obtenerVarios([
    'EMPRESA_RAZON_SOCIAL', 'EMPRESA_RUC', 'EMPRESA_DIRECCION'
  ]);
  const hoy = ymdLima();
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const cerrado = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#283e49')
    .text(empresa.EMPRESA_RAZON_SOCIAL || 'Ascensores Jy S.A.C.');
  doc.font('Helvetica').fontSize(9).fillColor('#564f3f')
    .text(`RUC ${empresa.EMPRESA_RUC || '—'}   •   Generado ${hoy}   •   ${dataset.length} cliente(s)`);
  doc.moveDown(0.5);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#928773')
    .text(`Filtros: ${_descripcionFiltros(filtros)}`);
  doc.moveDown(1);

  if (dataset.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor('#564f3f')
      .text('Sin clientes que reportar para los filtros seleccionados.');
  }

  dataset.forEach((g, idx) => {
    if (idx > 0) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#283e49').text(g.cliente?.nombre || '');
    doc.font('Helvetica').fontSize(9).fillColor('#564f3f')
      .text(`${g.planes.length} plan(es)   •   ${g.programaciones.length} programación(es)`);
    doc.moveDown(0.6);
    g.programaciones.slice(0, 30).forEach(p => {
      doc.font('Helvetica').fontSize(9).fillColor('#1a1812')
        .text(`${fechaISO(p.fecha_programada)}  ·  ${p.ascensor_codigo}  ·  ${p.tipo_servicio || '—'}  ·  ${p.estado_ejecucion}`);
    });
    if (g.programaciones.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#928773')
        .text('Sin programaciones para los filtros.');
    }
  });

  doc.end();
  return cerrado;
}

module.exports = { generarExcelMantenimientos, generarPdfMantenimientos };

/**
 * Clasificaciones de cliente (tbl_clasificaciones_cliente): catálogo gestionable
 * desde la aplicación. Etiqueta informativa para filtrar y agrupar; no afecta el
 * flujo operativo. La comparten clientes y ascensores (ambos guardan el CÓDIGO).
 *
 * Cada clasificación aplica a un ÁREA del cliente — las mismas claves que
 * utils/catalogosClientes.js (AREAS_CLIENTE + AREA_AMBAS):
 *   'servicio' → solo clientes del área de Servicios
 *   'proyecto' → solo clientes del área de Proyectos
 *   'ambos'    → cualquiera
 *
 * Espejo de la paleta y de `aplicaAAreas` en
 * frontend/src/utils/clasificacionesCliente.js — mantener en sincronía.
 */
const { AREAS_CLIENTE, AREA_AMBAS, ETIQUETA_AREA } = require('./catalogosClientes');

/** Áreas válidas de una clasificación. */
const AREAS_CLASIFICACION = [...AREAS_CLIENTE, AREA_AMBAS];

/**
 * Paleta de colores del badge. Se guarda la CLAVE; la API devuelve además las
 * clases. Las clases llegan como strings desde la API y el escáner de Tailwind
 * no las ve: mantener en sync con el safelist de frontend/tailwind.config.js.
 */
const COLORES_CLASIFICACION = {
  violeta: 'bg-violet-100 text-violet-800 ring-violet-200',
  celeste: 'bg-sky-100 text-sky-800 ring-sky-200',
  naranja: 'bg-ember-100 text-ember-800 ring-ember-200',
  verde:   'bg-emerald-100 text-emerald-800 ring-emerald-200',
  ambar:   'bg-amber-100 text-amber-800 ring-amber-200',
  rosa:    'bg-rose-100 text-rose-800 ring-rose-200',
  indigo:  'bg-indigo-100 text-indigo-800 ring-indigo-200',
  gris:    'bg-slate-100 text-slate-700 ring-slate-200'
};
const COLOR_POR_DEFECTO = 'gris';

/** Largo máximo del código: el de tbl_clientes/tbl_ascensores.clasificacion. */
const LARGO_CODIGO = 20;

/** Fila de BD → forma que consume el frontend (compatible con el catálogo anterior). */
function serializar(fila) {
  const clave = COLORES_CLASIFICACION[fila.color] ? fila.color : COLOR_POR_DEFECTO;
  return {
    id: fila.id,
    codigo: fila.codigo,
    etiqueta: fila.etiqueta,
    area: fila.area,
    color_clave: clave,
    color: COLORES_CLASIFICACION[clave],
    orden: fila.orden,
    activo: fila.estado === 1
  };
}

/** Catálogo completo (activas e inactivas) en orden de presentación. */
async function listarClasificaciones(db) {
  const filas = await db.tbl_clasificaciones_cliente.findMany({
    orderBy: [{ orden: 'asc' }, { etiqueta: 'asc' }]
  });
  return filas.map(serializar);
}

/** { codigo: etiqueta } de todo el catálogo, para exportaciones. */
async function mapaEtiquetasClasificacion(db) {
  const filas = await db.tbl_clasificaciones_cliente.findMany({ select: { codigo: true, etiqueta: true } });
  return Object.fromEntries(filas.map(f => [f.codigo, f.etiqueta]));
}

/**
 * ¿La clasificación aplica a un cliente con estas áreas? Un cliente de ambas
 * áreas admite cualquier clasificación; uno de una sola, solo las de su área o
 * las de 'ambos'.
 */
function aplicaAAreas(clasificacion, areasCliente) {
  if (!clasificacion || clasificacion.area === AREA_AMBAS) return true;
  return (areasCliente || []).includes(clasificacion.area);
}

/** "Servicios" / "Proyectos" / "Servicios y Proyectos". */
function etiquetaAreaClasificacion(area) {
  return area === AREA_AMBAS ? 'Servicios y Proyectos' : (ETIQUETA_AREA[area] || area);
}

/**
 * Resuelve la clasificación que llega por API antes de guardarla.
 *
 *  - vacía → null (sin clasificar).
 *  - igual a la actual (`previo`) → se conserva tal cual, aunque hoy esté
 *    inactiva o no encaje: editar otro dato del cliente no debe obligar a
 *    reclasificarlo.
 *  - cualquier otra → debe existir y estar activa y, si se pasan
 *    `areasCliente`, aplicar a esas áreas.
 *
 * @returns {Promise<{ ok: true, codigo: string|null } | { ok: false, error: string }>}
 */
async function resolverClasificacion(db, valor, { previo = null, areasCliente = null } = {}) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return { ok: true, codigo: null };
  const codigo = String(valor).trim();
  if (previo && codigo === previo) return { ok: true, codigo };

  const fila = await db.tbl_clasificaciones_cliente.findUnique({ where: { codigo } });
  if (!fila || fila.estado !== 1) return { ok: false, error: 'La clasificación elegida no existe o está desactivada' };
  if (areasCliente && !aplicaAAreas(fila, areasCliente)) {
    return {
      ok: false,
      error: `La clasificación «${fila.etiqueta}» es solo para clientes del área de ${etiquetaAreaClasificacion(fila.area)}`
    };
  }
  return { ok: true, codigo };
}

/**
 * Código estable a partir de la etiqueta: minúsculas, sin tildes, `_` como
 * separador, máximo LARGO_CODIGO. Si ya existe, se le añade un sufijo numérico.
 */
async function generarCodigo(db, etiqueta) {
  const base = String(etiqueta)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, LARGO_CODIGO) || 'clasificacion';
  let codigo = base;
  for (let n = 2; await db.tbl_clasificaciones_cliente.findUnique({ where: { codigo } }); n++) {
    const sufijo = `_${n}`;
    codigo = `${base.slice(0, LARGO_CODIGO - sufijo.length)}${sufijo}`;
  }
  return codigo;
}

module.exports = {
  AREAS_CLASIFICACION,
  COLORES_CLASIFICACION,
  COLOR_POR_DEFECTO,
  serializar,
  listarClasificaciones,
  mapaEtiquetasClasificacion,
  aplicaAAreas,
  etiquetaAreaClasificacion,
  resolverClasificacion,
  generarCodigo
};

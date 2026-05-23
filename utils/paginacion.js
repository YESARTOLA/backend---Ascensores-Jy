/**
 * Helpers de paginación para controllers Prisma.
 *
 * Convención:
 *   GET /recurso?page=1&pageSize=25  → paginado
 *   GET /recurso                      → sin paginar (compat hacia atrás)
 *
 * Respuesta paginada:
 *   { data, total, page, pageSize, totalPages }
 * Respuesta no paginada:
 *   { data }
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

function leerParams(query) {
  const rawPage = query?.page;
  if (rawPage === undefined || rawPage === null || rawPage === '') {
    return { paginar: false };
  }
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { paginar: true, page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Ejecuta una consulta findMany + count y devuelve la respuesta paginada
 * lista para JSON.
 *
 * @param {object} model       Modelo Prisma (ej. prisma.tbl_servicios_proyectos)
 * @param {object} args        Args para findMany (where, include, orderBy, etc.)
 * @param {object} reqQuery    req.query
 * @returns {Promise<object>}  { data, total?, page?, pageSize?, totalPages? }
 */
async function paginar(model, args, reqQuery) {
  const p = leerParams(reqQuery);
  if (!p.paginar) {
    const data = await model.findMany(args);
    return { data };
  }
  const [total, data] = await Promise.all([
    model.count({ where: args.where }),
    model.findMany({ ...args, skip: p.skip, take: p.take })
  ]);
  return {
    data,
    total,
    page: p.page,
    pageSize: p.pageSize,
    totalPages: Math.max(1, Math.ceil(total / p.pageSize))
  };
}

/**
 * Pagina un array ya cargado en memoria (cuando el filtrado/transformación
 * requiere haber traído todo, por ejemplo cuando hay cálculos post-fetch).
 */
function paginarArray(arr, reqQuery) {
  const p = leerParams(reqQuery);
  if (!p.paginar) return { data: arr };
  const total = arr.length;
  const data = arr.slice(p.skip, p.skip + p.take);
  return {
    data, total,
    page: p.page,
    pageSize: p.pageSize,
    totalPages: Math.max(1, Math.ceil(total / p.pageSize))
  };
}

module.exports = { paginar, paginarArray, leerParams, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };

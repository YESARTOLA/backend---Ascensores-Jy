/**
 * Catálogos cerrados para clientes.
 *
 * CLASIFICACIONES: clasificación informativa del cliente. No afecta el flujo
 * operativo; sirve para filtrar y agrupar en reportes. Single source of truth
 * para backend (validación) y frontend (select + badge).
 */

// Los `color` son clases Tailwind; al ser strings servidos por la API no las ve
// el escáner de contenido. Mantener en sync con el safelist del frontend.
const CLASIFICACIONES = [
  { codigo: 'grande',    etiqueta: 'Grande',    color: 'bg-violet-100 text-violet-800 ring-violet-200' },
  { codigo: 'pequeno',   etiqueta: 'Pequeño',   color: 'bg-sky-100 text-sky-800 ring-sky-200' },
  { codigo: 'marca_jy',  etiqueta: 'Marca JY',  color: 'bg-ember-100 text-ember-800 ring-ember-200' },
  { codigo: 'glarie',    etiqueta: 'Glarie',    color: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  { codigo: 'proyectos', etiqueta: 'Proyectos', color: 'bg-amber-100 text-amber-800 ring-amber-200' }
];

const CLASIFICACIONES_CODIGOS = CLASIFICACIONES.map(c => c.codigo);

/**
 * Normaliza una clasificación recibida por API: devuelve el código si pertenece
 * al catálogo y null en cualquier otro caso (vacío, desconocido o ausente). La
 * comparten cliente y ascensor, que clasifican con el mismo catálogo.
 */
function normalizarClasificacion(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const codigo = String(valor).trim();
  return CLASIFICACIONES_CODIGOS.includes(codigo) ? codigo : null;
}

// El tipo Edificio/Obra ahora vive en el edificio, no en el cliente. Ver
// utils/catalogosEdificios.js (TIPOS_EDIFICIO).

/**
 * Contrato del cliente POR ÁREA. Las claves son los `tipo_registro` de
 * tbl_servicios_proyectos ('servicio' | 'proyecto'), de modo que el área de un
 * cliente mapea 1:1 al ámbito del usuario (acceso_servicios / acceso_proyectos).
 *
 * Es la SSoT del mapeo área → columnas: la usan el controlador (validar y
 * guardar los contratos) y utils/alcanceUsuario.js (decidir qué clientes ve
 * cada usuario según su ámbito). Como al crear un cliente es obligatorio
 * registrar el contrato de al menos un área, estas columnas son la marca
 * explícita de a qué área pertenece cada cliente.
 */
const CAMPOS_CONTRATO_AREA = {
  servicio: { inicio: 'contrato_servicio_inicio', fin: 'contrato_servicio_fin', archivo: 'id_archivo_contrato_servicio' },
  proyecto: { inicio: 'contrato_proyecto_inicio', fin: 'contrato_proyecto_fin', archivo: 'id_archivo_contrato_proyecto' }
};

const ETIQUETA_AREA = { servicio: 'Servicios', proyecto: 'Proyectos' };

// Áreas del cliente, en orden de presentación. Misma clave que el ámbito del
// usuario y que el `tipo_registro` del servicio/proyecto.
const AREAS_CLIENTE = Object.keys(CAMPOS_CONTRATO_AREA);

// Valor extra del filtro por área: el cliente registra las dos.
const AREA_AMBAS = 'ambos';

/**
 * Áreas a las que pertenece un cliente POR CONTRATO: aquellas con inicio y fin
 * registrados. Es la marca EXPLÍCITA del área y existe desde que se crea el
 * cliente, antes de que tenga ningún servicio o proyecto.
 *
 * Espejo en JS de la primera condición de `clienteAlcanceWhere`
 * (utils/alcanceUsuario.js): lo que allí se consulta en SQL, aquí se evalúa
 * sobre una fila ya cargada. El cliente debe traer las columnas de contrato.
 *
 * @param {object} cliente fila de tbl_clientes (o un select con esas columnas)
 * @returns {string[]} subconjunto de AREAS_CLIENTE
 */
function areasPorContrato(cliente) {
  if (!cliente) return [];
  return AREAS_CLIENTE.filter(area => {
    const campos = CAMPOS_CONTRATO_AREA[area];
    return cliente[campos.inicio] != null && cliente[campos.fin] != null;
  });
}

/** Columnas de contrato que necesita `areasPorContrato`, como `select` de Prisma. */
const SELECT_CONTRATO_AREAS = Object.fromEntries(
  AREAS_CLIENTE.flatMap(area => {
    const campos = CAMPOS_CONTRATO_AREA[area];
    return [[campos.inicio, true], [campos.fin, true]];
  })
);

module.exports = {
  CLASIFICACIONES,
  CLASIFICACIONES_CODIGOS,
  normalizarClasificacion,
  CAMPOS_CONTRATO_AREA,
  ETIQUETA_AREA,
  AREAS_CLIENTE,
  AREA_AMBAS,
  areasPorContrato,
  SELECT_CONTRATO_AREAS
};

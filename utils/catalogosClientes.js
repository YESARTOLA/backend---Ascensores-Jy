/**
 * Catálogos cerrados para clientes.
 *
 * La CLASIFICACIÓN del cliente ya no es un catálogo cerrado: vive en
 * tbl_clasificaciones_cliente y se gestiona desde la app (ver
 * utils/clasificacionesCliente.js).
 */

// El tipo Edificio/Obra ahora vive en el edificio, no en el cliente. Ver
// utils/catalogosEdificios.js (TIPOS_EDIFICIO).

/**
 * Contrato del cliente POR ÁREA. Las claves son los `tipo_registro` de
 * tbl_servicios_proyectos ('servicio' | 'proyecto'), de modo que el área de un
 * cliente mapea 1:1 al ámbito del usuario (acceso_servicios / acceso_proyectos).
 *
 * Es la SSoT del mapeo área → columnas: la usan el controlador (validar y
 * guardar los contratos) y utils/alcanceUsuario.js (decidir qué clientes ve
 * cada usuario según su ámbito). El área del cliente vive en su propia columna
 * (`tbl_clientes.area`) porque el contrato es opcional; si lo tiene, va en esas
 * columnas de su área.
 */
const CAMPOS_CONTRATO_AREA = {
  servicio: { inicio: 'contrato_servicio_inicio', fin: 'contrato_servicio_fin', archivo: 'id_archivo_contrato_servicio' },
  proyecto: { inicio: 'contrato_proyecto_inicio', fin: 'contrato_proyecto_fin', archivo: 'id_archivo_contrato_proyecto' }
};

const ETIQUETA_AREA = { servicio: 'Servicios', proyecto: 'Proyectos' };

// Áreas del cliente, en orden de presentación. Misma clave que el ámbito del
// usuario y que el `tipo_registro` del servicio/proyecto.
const AREAS_CLIENTE = Object.keys(CAMPOS_CONTRATO_AREA);

// Área de una CLASIFICACIÓN que aplica a clientes de las dos áreas. No es un área
// de cliente: el cliente es de Servicios o de Proyectos, nunca de ambas.
const AREA_AMBAS = 'ambos';

/**
 * Áreas en las que el cliente tiene contrato registrado (inicio y fin). Lo
 * normal es una o ninguna (el contrato es opcional); dos solo en clientes
 * antiguos, de cuando existía la opción «Ambas».
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

/**
 * Áreas a las que pertenece un cliente: la elegida al registrarlo
 * (`tbl_clientes.area`) más la de su contrato, que coinciden salvo en los
 * clientes antiguos con contrato en las dos áreas (sin área elegida aún). Existe
 * desde que se crea el cliente, antes de que tenga ningún servicio o proyecto.
 *
 * Espejo en JS de las condiciones de área y de contrato de `clienteAlcanceWhere`
 * (utils/alcanceUsuario.js): lo que allí se consulta en SQL, aquí se evalúa
 * sobre una fila ya cargada (con SELECT_AREAS_CLIENTE).
 *
 * @param {object} cliente fila de tbl_clientes (o un select con esas columnas)
 * @returns {string[]} subconjunto de AREAS_CLIENTE
 */
function areasDelCliente(cliente) {
  if (!cliente) return [];
  const porContrato = areasPorContrato(cliente);
  return AREAS_CLIENTE.filter(area => area === cliente.area || porContrato.includes(area));
}

/** Columnas que necesita `areasDelCliente`, como `select` de Prisma. */
const SELECT_AREAS_CLIENTE = {
  area: true,
  ...Object.fromEntries(
    AREAS_CLIENTE.flatMap(area => {
      const campos = CAMPOS_CONTRATO_AREA[area];
      return [[campos.inicio, true], [campos.fin, true]];
    })
  )
};

module.exports = {
  CAMPOS_CONTRATO_AREA,
  ETIQUETA_AREA,
  AREAS_CLIENTE,
  AREA_AMBAS,
  areasPorContrato,
  areasDelCliente,
  SELECT_AREAS_CLIENTE
};

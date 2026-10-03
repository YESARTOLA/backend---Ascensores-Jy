/**
 * Filtros compartidos por los listados de Emergencias y Correctivos. Ambos se
 * resuelven sobre el servicio vinculado, que es donde viven los técnicos y la
 * ejecución:
 *
 *   id_tecnico                  — técnico con asignación activa en el servicio.
 *   inicio_desde / inicio_hasta — fecha de INICIO DE EJECUCIÓN (YYYY-MM-DD,
 *                                 día de Lima): la primera vez que el servicio
 *                                 pasó a "En curso". Es el mismo dato que
 *                                 `derivarEjecucion` expone como
 *                                 `fecha_inicio_real`; un caso que aún no
 *                                 arrancó no tiene inicio y no entra.
 */
const { ESTADOS_INICIO } = require('./ejecucionFechas');
const { parseYMDLima, parseYMDFinDiaLima } = require('./tiempo');

const esYMD = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/**
 * Fragmento Prisma para la entidad (emergencia o correctivo), o null si no hay
 * filtros. Pensado para sumarse con `conAlcance`, sin pisar el `where.servicio`
 * que ya pone la visibilidad del técnico.
 */
function whereFiltrosAtencion(query = {}) {
  const condiciones = [];

  const idTecnico = Number(query.id_tecnico);
  if (Number.isInteger(idTecnico) && idTecnico > 0) {
    condiciones.push({ asignaciones: { some: { id_tecnico: idTecnico, estado: 1 } } });
  }

  const desde = esYMD(query.inicio_desde) ? parseYMDLima(query.inicio_desde) : null;
  const hasta = esYMD(query.inicio_hasta) ? parseYMDFinDiaLima(query.inicio_hasta) : null;
  if (desde || hasta) {
    const inicio = { estado_nuevo: { in: ESTADOS_INICIO }, estado: 1 };
    const rango = { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) };
    condiciones.push({ historial_estados: { some: { ...inicio, fecha_cambio: rango } } });
    // Cuenta el PRIMER arranque: un servicio que ya había empezado antes del
    // rango no entra aunque se haya reanudado dentro de él.
    if (desde) condiciones.push({ historial_estados: { none: { ...inicio, fecha_cambio: { lt: desde } } } });
  }

  return condiciones.length ? { servicio: { is: { AND: condiciones } } } : null;
}

module.exports = { whereFiltrosAtencion };

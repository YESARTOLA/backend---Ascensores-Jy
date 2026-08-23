/**
 * Plazo para que el TÉCNICO registre el cierre de un servicio.
 *
 * Regla: el técnico dispone de N días CALENDARIO contados desde la fecha
 * programada del servicio (el último día programado si el servicio dura varios)
 * para finalizarlo. N sale de la configuración `SERVICIO_CIERRE_PLAZO_DIAS`
 * (editable por el super administrador).
 *
 * Pasado ese plazo el técnico ya no puede cerrar: el super administrador debe
 * habilitar el cierre de ESE servicio (`cierre_fuera_plazo_habilitado`), permiso
 * puntual que se consume al cerrarse el servicio.
 *
 * Por qué existe: la alerta de "cotización urgente" del calendario se agenda en
 * la FECHA PROGRAMADA del servicio, no en la fecha real de cierre (ver
 * utils/recordatoriosAuto.js). Como no se programa trabajo los domingos, esa
 * alerta nunca cae en domingo; pero si el cierre llega semanas tarde, la alerta
 * aparece en un día ya pasado y se pierde. El plazo acota esa ventana.
 *
 * Todo el cálculo trabaja en "fecha pura" (YYYY-MM-DD) de Lima, sin husos.
 */

const { ymdDeFecha, ymdLima, addDiasYMD } = require('./tiempo');

/**
 * Último día programado del servicio, en 'YYYY-MM-DD' (null si no está
 * programado).
 *
 * La programación puede ser de días NO corridos (10, 15 y 20 de agosto), así que
 * la fuente de verdad es la grilla `tbl_servicios_dias`: se toma la fecha máxima
 * de los días activos cuando el servicio llega con ellos cargados. Sin la grilla
 * (consultas que no la incluyen, o datos previos a la grilla) se cae al cálculo
 * clásico fecha_programada + (duracion_dias - 1), que solo es exacto si los días
 * son corridos — por eso es el fallback y no el camino principal.
 */
function ultimoDiaProgramado(servicio) {
  const dias = Array.isArray(servicio?.dias)
    ? servicio.dias.filter(d => d && d.estado !== 0).map(d => ymdDeFecha(d.fecha)).filter(Boolean)
    : [];
  if (dias.length > 0) return dias.sort().pop();

  const inicio = ymdDeFecha(servicio?.fecha_programada);
  if (!inicio) return null;
  const n = Number(servicio?.duracion_dias) || 1;
  return addDiasYMD(inicio, Math.max(0, n - 1));
}

/**
 * Fecha límite (inclusive) para que el técnico cierre: último día programado +
 * `plazoDias`. Devuelve 'YYYY-MM-DD', o null si no se puede calcular (servicio
 * sin fecha programada → no se aplica el límite).
 */
function fechaLimiteCierre(servicio, plazoDias) {
  const ultimo = ultimoDiaProgramado(servicio);
  if (!ultimo) return null;
  const n = Number(plazoDias);
  if (!Number.isFinite(n) || n < 0) return null;
  return addDiasYMD(ultimo, n);
}

/**
 * Estado del plazo de cierre de un servicio.
 * @param {object} servicio  con fecha_programada, duracion_dias y los campos
 *                           cierre_fuera_plazo_habilitado / _por / _en
 * @param {number} plazoDias valor de SERVICIO_CIERRE_PLAZO_DIAS
 * @param {string} [hoy]     'YYYY-MM-DD' (default: hoy en Lima) — para tests
 */
function estadoPlazoCierre(servicio, plazoDias, hoy = ymdLima()) {
  const fecha_limite = fechaLimiteCierre(servicio, plazoDias);
  const habilitado = !!servicio?.cierre_fuera_plazo_habilitado;
  // Sin fecha límite calculable (servicio sin fecha programada) no hay plazo que
  // vencer: no se bloquea al técnico.
  const vencido = !!fecha_limite && hoy > fecha_limite;
  return {
    plazo_dias: Number(plazoDias) || 0,
    fecha_limite,
    vencido,
    habilitado,
    // Lo que decide si el técnico puede cerrar hoy.
    puede_cerrar_tecnico: !vencido || habilitado,
    dias_vencido: vencido ? diasEntre(fecha_limite, hoy) : 0
  };
}

// Días de diferencia entre dos 'YYYY-MM-DD' (b - a), aritmética de calendario.
function diasEntre(a, b) {
  const da = new Date(`${a}T00:00:00.000Z`).getTime();
  const db = new Date(`${b}T00:00:00.000Z`).getTime();
  if (isNaN(da) || isNaN(db)) return 0;
  return Math.round((db - da) / 86400000);
}

module.exports = {
  addDiasYMD,
  ultimoDiaProgramado,
  fechaLimiteCierre,
  estadoPlazoCierre
};

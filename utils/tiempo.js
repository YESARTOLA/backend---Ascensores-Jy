/**
 * Utilidades de tiempo ancladas a America/Lima (UTC-5, sin DST).
 *
 * Por qué existen: process.env.TZ puede no propagarse a V8 en todos los
 * entornos (Windows, Railway sin variable explícita). Este módulo computa
 * fechas en Lima sin depender de la TZ del proceso — siempre devuelve el
 * mismo instante absoluto sin importar dónde corra el código.
 *
 * Lima nunca observa horario de verano: offset fijo -05:00.
 */
const TZ = 'America/Lima';
const OFFSET = '-05:00';

const FMT_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});
const FMT_HM = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
});
const FMT_HMS = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

function ymdLima(fecha = new Date()) {
  return FMT_YMD.format(fecha);
}

function hmLima(fecha = new Date()) {
  return FMT_HM.format(fecha);
}

function hmsLima(fecha = new Date()) {
  return FMT_HMS.format(fecha);
}

function inicioDelDiaLima(fecha = new Date()) {
  return new Date(`${ymdLima(fecha)}T00:00:00.000${OFFSET}`);
}

function finDelDiaLima(fecha = new Date()) {
  return new Date(`${ymdLima(fecha)}T23:59:59.999${OFFSET}`);
}

function inicioMesLima(fecha = new Date()) {
  const ymd = ymdLima(fecha);
  return new Date(`${ymd.substring(0, 8)}01T00:00:00.000${OFFSET}`);
}

function finMesLima(fecha = new Date()) {
  const ymd = ymdLima(fecha);
  const [y, m] = ymd.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(`${y}-${String(m).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}T23:59:59.999${OFFSET}`);
}

function parseYMDLima(ymd) {
  if (!ymd) return null;
  const s = String(ymd).substring(0, 10);
  return new Date(`${s}T00:00:00.000${OFFSET}`);
}

function parseYMDFinDiaLima(ymd) {
  if (!ymd) return null;
  const s = String(ymd).substring(0, 10);
  return new Date(`${s}T23:59:59.999${OFFSET}`);
}

/**
 * "YYYY-MM-DD" de un valor que representa un día calendario.
 *  - String "YYYY-MM-DD..." → toma los primeros 10 chars literalmente.
 *  - Date a 00:00:00.000 UTC exacto → fecha pura de Prisma `@db.Date`; se
 *    extrae el YMD usando getUTC* para preservar el día tal cual está
 *    almacenado en la columna. Convertirlo a Lima (-5h) lo correría un día atrás.
 *  - Date "instante absoluto" (cualquier otra hora) → se formatea en Lima.
 *
 * Esta heurística cubre el caso donde Prisma devuelve `@db.Date` como
 * `2026-05-22T00:00:00.000Z` y al pasarlo por TZ Lima cae al 21/05.
 */
function ymdDeFecha(fecha) {
  if (typeof fecha === 'string') return fecha.substring(0, 10);
  if (!(fecha instanceof Date) || isNaN(fecha.getTime())) return null;
  const esFechaPura =
    fecha.getUTCHours() === 0 &&
    fecha.getUTCMinutes() === 0 &&
    fecha.getUTCSeconds() === 0 &&
    fecha.getUTCMilliseconds() === 0;
  if (esFechaPura) {
    const y = fecha.getUTCFullYear();
    const m = String(fecha.getUTCMonth() + 1).padStart(2, '0');
    const d = String(fecha.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return ymdLima(fecha);
}

/**
 * Medianoche UTC de un "YYYY-MM-DD". Úsalo para filtrar rangos sobre columnas
 * `@db.Date` (que Prisma lee/almacena como 00:00:00.000Z): los límites del rango
 * deben alinearse a ese mismo instante. Con límites en Lima el borde superior se
 * corre un día (fin-de-día Lima cae en el día UTC siguiente y Prisma extrae la
 * fecha del límite en UTC), incluyendo registros del día posterior.
 */
function parseYMDUTC(ymd) {
  if (!ymd) return null;
  const s = String(ymd).substring(0, 10);
  const d = new Date(`${s}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

function combinarFechaHoraLima(fecha, hora) {
  const ymd = ymdDeFecha(fecha);
  const hm = (hora && /^\d{2}:\d{2}/.test(hora)) ? hora.substring(0, 5) : '09:00';
  return new Date(`${ymd}T${hm}:00.000${OFFSET}`);
}

/**
 * Parsea un string "YYYY-MM-DDTHH:mm" (input datetime-local) como instante de Lima,
 * sin depender de process.env.TZ. Robusto a desfases en Railway (UTC) o local Windows.
 * Si el string ya viene con designador de TZ (Z o ±HH:MM) se respeta tal cual.
 */
function parseDateTimeLocalLima(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (!v) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) return new Date(v);
  const completo = v.length === 16 ? `${v}:00.000` : (v.length === 19 ? `${v}.000` : v);
  return new Date(`${completo}${OFFSET}`);
}

/**
 * Instante actual truncado al minuto. Los inputs datetime-local tienen
 * granularidad de minuto, así que truncar evita rechazar el minuto en curso
 * al validar que una fecha no sea anterior a "ahora".
 */
const MS_POR_MINUTO = 60000;
function inicioDelMinutoActual() {
  return new Date(Math.floor(Date.now() / MS_POR_MINUTO) * MS_POR_MINUTO);
}

function diffDiasLima(a, b) {
  const da = inicioDelDiaLima(new Date(a)).getTime();
  const db = inicioDelDiaLima(new Date(b)).getTime();
  return Math.round((da - db) / 86400000);
}

module.exports = {
  TZ, OFFSET,
  ymdLima, hmLima, hmsLima, ymdDeFecha,
  inicioDelDiaLima, finDelDiaLima,
  inicioMesLima, finMesLima,
  parseYMDLima, parseYMDFinDiaLima, parseYMDUTC,
  combinarFechaHoraLima,
  parseDateTimeLocalLima,
  inicioDelMinutoActual,
  diffDiasLima
};

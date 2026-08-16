/**
 * DATOS DE SITIO (contacto en sitio + cuarto de máquinas) — SSoT.
 *
 * Se registran en la ficha del ASCENSOR (tbl_ascensores) y cada servicio o
 * proyecto que se crea sobre ese ascensor los HEREDA en sus columnas homónimas
 * (tbl_servicios_proyectos), de forma que el técnico asignado los ve en la card
 * "Datos" de su servicio sin que nadie los recargue a mano.
 *
 * La copia es un valor inicial, no un espejo: si en un servicio concreto el
 * contacto es otro, el coordinador lo corrige ahí (PATCH datos-contacto) sin
 * alterar la ficha del ascensor. Lo que venga explícito en el alta siempre gana
 * sobre lo heredado.
 */

// Valores admitidos para "Cuarto de máquinas". NULL/'' = todavía sin definir.
const CUARTO_MAQUINAS_VALIDOS = ['Si', 'No'];

const CAMPOS_SITIO = ['contacto_nombre', 'contacto_telefono', 'cuarto_maquinas'];

/** Normaliza un texto a null cuando viene vacío, recortado a `max` caracteres. */
const limpiarTexto = (v, max) => {
  const t = String(v ?? '').trim();
  return t === '' ? null : t.slice(0, max);
};

/**
 * Normaliza el valor de cuarto de máquinas.
 * @returns {{valor: string|null}|{error: string}}
 */
function normalizarCuartoMaquinas(v) {
  const valor = limpiarTexto(v, 2);
  if (valor !== null && !CUARTO_MAQUINAS_VALIDOS.includes(valor)) {
    return { error: 'Cuarto de máquinas solo admite "Si" o "No"' };
  }
  return { valor };
}

/**
 * Normaliza los tres datos de sitio de un payload de ascensor (alta o edición).
 * @param {object} d payload
 * @param {object|null} previo fila actual (edición parcial: lo ausente se conserva)
 * @returns {{data: object}|{error: string}}
 */
function normalizarDatosSitio(d, previo = null) {
  const tomar = (campo, max) => {
    if (d[campo] !== undefined) return limpiarTexto(d[campo], max);
    return previo ? previo[campo] : null;
  };
  const data = {
    contacto_nombre: tomar('contacto_nombre', 150),
    contacto_telefono: tomar('contacto_telefono', 30)
  };
  if (d.cuarto_maquinas !== undefined) {
    const cm = normalizarCuartoMaquinas(d.cuarto_maquinas);
    if (cm.error) return { error: cm.error };
    data.cuarto_maquinas = cm.valor;
  } else {
    data.cuarto_maquinas = previo ? previo.cuarto_maquinas : null;
  }
  return { data };
}

/**
 * Datos de sitio con los que nace un servicio/proyecto: los explícitos del alta
 * y, para los que no vengan, los del primer ascensor que los tenga registrados.
 *
 * @param {object} client prisma o el `tx` de la transacción en curso
 * @param {Array<number|string>} idsAscensores ascensores del servicio (en orden)
 * @param {object} explicitos valores del payload que deben prevalecer
 * @returns {Promise<{contacto_nombre: string|null, contacto_telefono: string|null, cuarto_maquinas: string|null}>}
 */
async function datosSitioParaServicio(client, idsAscensores, explicitos = {}) {
  const heredado = { contacto_nombre: null, contacto_telefono: null, cuarto_maquinas: null };
  for (const campo of CAMPOS_SITIO) {
    const v = limpiarTexto(explicitos[campo], campo === 'contacto_nombre' ? 150 : campo === 'contacto_telefono' ? 30 : 2);
    if (v !== null) heredado[campo] = v;
  }
  // Nada que heredar si ya vinieron los tres o no hay ascensor del que copiar.
  const faltantes = CAMPOS_SITIO.filter(c => heredado[c] === null);
  const ids = (idsAscensores || []).map(Number).filter(Boolean);
  if (faltantes.length === 0 || ids.length === 0) return heredado;

  const ascensores = await client.tbl_ascensores.findMany({
    where: { id: { in: ids } },
    select: { id: true, contacto_nombre: true, contacto_telefono: true, cuarto_maquinas: true }
  });
  // Se respeta el orden en que llegaron los ascensores: manda el primero que
  // tenga el dato (los servicios multi-ascensor comparten sitio en la práctica).
  const enOrden = ids.map(id => ascensores.find(a => a.id === id)).filter(Boolean);
  for (const campo of faltantes) {
    const fuente = enOrden.find(a => limpiarTexto(a[campo], 150) !== null);
    if (fuente) heredado[campo] = fuente[campo];
  }
  return heredado;
}

module.exports = {
  CUARTO_MAQUINAS_VALIDOS,
  normalizarCuartoMaquinas,
  normalizarDatosSitio,
  datosSitioParaServicio
};

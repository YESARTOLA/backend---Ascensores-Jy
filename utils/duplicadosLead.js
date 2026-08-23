/**
 * Detección de prospectos ya registrados.
 *
 * Antes de dar de alta (o editar) un lead se comprueba que su teléfono, su
 * nombre / razón social y su documento (RUC o DNI) no pertenezcan ya a otro
 * LEAD o a un CLIENTE. Cualquier coincidencia bloquea el registro y se informa
 * exactamente con quién choca, para que el usuario trabaje el registro que ya
 * existe en vez de duplicarlo.
 *
 * La comparación es exacta sobre el valor NORMALIZADO (no difusa):
 *   - teléfonos → solo dígitos, comparando los últimos 9 (el celular peruano),
 *     para que "+51 987 654 321" y "987654321" se reconozcan como el mismo.
 *   - nombres   → sin tildes, sin mayúsculas, sin espacios repetidos y sin la
 *     forma societaria final (S.A.C., E.I.R.L., …), que rara vez se escribe
 *     igual dos veces.
 *
 * El cruce se hace en memoria: la cartera de leads + clientes es de unos pocos
 * miles de filas, y así el mismo criterio de normalización vale para las dos
 * tablas (Postgres no normaliza tildes ni sufijos por sí solo).
 */

const prisma = require('../config/prisma');

// Campos de cada tabla que se consideran "el teléfono" o "el nombre" del
// registro: un prospecto puede haber entrado como contacto principal de un
// cliente, o con su celular cargado en WhatsApp.
const CAMPOS_TELEFONO_CLIENTE = ['telefono', 'whatsapp', 'contacto_principal_telefono'];
const CAMPOS_NOMBRE_CLIENTE = ['nombre', 'contacto_principal_nombre'];
const CAMPOS_TELEFONO_LEAD = ['telefono'];
const CAMPOS_NOMBRE_LEAD = ['nombre_contacto', 'razon_social'];

// Formas societarias que se ignoran al comparar nombres.
const SUFIJOS_SOCIETARIOS = /\b(s\.?a\.?c\.?|s\.?a\.?a\.?|s\.?a\.?|s\.?r\.?l\.?|e\.?i\.?r\.?l\.?|s\.?c\.?r\.?l\.?|ltda\.?|sac|eirl|srl)\b/g;

/** Teléfono comparable: solo dígitos, últimos 9 (sin prefijo país ni separadores). */
function normalizarTelefono(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length < 6) return '';
  return digitos.slice(-9);
}

/** Nombre comparable: sin tildes, minúsculas, sin forma societaria ni puntuación. */
function normalizarNombre(valor) {
  const base = String(valor ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return base
    .replace(SUFIJOS_SOCIETARIOS, ' ')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Documento comparable: solo dígitos. */
const normalizarDocumento = (valor) => String(valor ?? '').replace(/\D/g, '');

// Etiquetas legibles del campo que chocó, para el mensaje al usuario.
const ETIQUETA_CAMPO = {
  telefono: 'el teléfono',
  nombre: 'el nombre / razón social',
  documento: 'el RUC / DNI'
};

/** ¿Alguno de los campos del registro normaliza igual que el valor buscado? */
function coincideEn(registro, campos, valorNormalizado, normalizar) {
  if (!valorNormalizado) return false;
  return campos.some(c => normalizar(registro[c]) === valorNormalizado);
}

/**
 * Busca leads y clientes que ya usen alguno de estos datos.
 *
 * @param {object} datos              { telefono, nombre, razon_social, documento }
 * @param {object} opciones
 * @param {number} opciones.excluirLeadId     lead que se está editando (no choca consigo mismo)
 * @param {number} opciones.excluirClienteId  cliente ya vinculado al lead: si el lead
 *   nació de ese cliente (o se convirtió en él), compartir sus datos es lo correcto.
 * @returns {Promise<Array>} coincidencias [{ origen, id, nombre, campo, campo_etiqueta, detalle }]
 */
async function buscarDuplicadosLead(datos, { excluirLeadId = null, excluirClienteId = null } = {}) {
  const telefono = normalizarTelefono(datos.telefono);
  const documento = normalizarDocumento(datos.documento);
  // El nombre del contacto y la razón social se buscan por separado: cualquiera
  // de los dos puede chocar con cualquiera de los nombres del otro registro.
  const nombres = [datos.nombre, datos.razon_social]
    .map(normalizarNombre)
    .filter(Boolean);
  const nombresUnicos = [...new Set(nombres)];

  if (!telefono && !documento && nombresUnicos.length === 0) return [];

  const [leads, clientes] = await Promise.all([
    prisma.tbl_leads.findMany({
      where: { estado: 1, ...(excluirLeadId ? { id: { not: Number(excluirLeadId) } } : {}) },
      select: {
        id: true, nombre_contacto: true, razon_social: true, telefono: true,
        ruc: true, tipo_documento: true, estado_lead: true,
        vendedor: { select: { nombres: true } }
      }
    }),
    prisma.tbl_clientes.findMany({
      where: { estado: 1, ...(excluirClienteId ? { id: { not: Number(excluirClienteId) } } : {}) },
      select: {
        id: true, nombre: true, contacto_principal_nombre: true, telefono: true,
        whatsapp: true, contacto_principal_telefono: true,
        numero_documento: true, tipo_documento: true
      }
    })
  ]);

  const coincidencias = [];
  const registrar = (origen, id, nombre, campo, detalle) =>
    coincidencias.push({ origen, id, nombre, campo, campo_etiqueta: ETIQUETA_CAMPO[campo], detalle });

  for (const l of leads) {
    const nombreLead = l.razon_social || l.nombre_contacto;
    const donde = l.vendedor?.nombres ? `asignado a ${l.vendedor.nombres}` : `estado: ${l.estado_lead}`;
    if (coincideEn(l, CAMPOS_TELEFONO_LEAD, telefono, normalizarTelefono)) {
      registrar('lead', l.id, nombreLead, 'telefono', donde);
    }
    if (nombresUnicos.some(n => coincideEn(l, CAMPOS_NOMBRE_LEAD, n, normalizarNombre))) {
      registrar('lead', l.id, nombreLead, 'nombre', donde);
    }
    if (documento && normalizarDocumento(l.ruc) === documento) {
      registrar('lead', l.id, nombreLead, 'documento', `${l.tipo_documento || 'RUC'} ${l.ruc}`);
    }
  }

  for (const c of clientes) {
    if (coincideEn(c, CAMPOS_TELEFONO_CLIENTE, telefono, normalizarTelefono)) {
      registrar('cliente', c.id, c.nombre, 'telefono', 'cliente activo');
    }
    if (nombresUnicos.some(n => coincideEn(c, CAMPOS_NOMBRE_CLIENTE, n, normalizarNombre))) {
      registrar('cliente', c.id, c.nombre, 'nombre', 'cliente activo');
    }
    if (documento && normalizarDocumento(c.numero_documento) === documento) {
      registrar('cliente', c.id, c.nombre, 'documento', `${c.tipo_documento || 'RUC'} ${c.numero_documento}`);
    }
  }

  return coincidencias;
}

/** Mensaje único para el 409: nombra el campo y con quién choca. */
function mensajeDuplicados(coincidencias) {
  const partes = coincidencias.slice(0, 3).map(c =>
    `${c.campo_etiqueta} ya está registrado en ${c.origen === 'lead' ? 'el lead' : 'el cliente'} #${c.id} «${c.nombre}»`
  );
  const resto = coincidencias.length - partes.length;
  return `No se puede registrar: ${partes.join('; ')}${resto > 0 ? ` (y ${resto} coincidencia(s) más)` : ''}.`;
}

module.exports = {
  buscarDuplicadosLead,
  mensajeDuplicados,
  normalizarTelefono,
  normalizarNombre,
  normalizarDocumento
};

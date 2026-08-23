/**
 * SSoT de los datos identificatorios del lead: documento (RUC / DNI) y
 * referencia comercial "buen pagador".
 *
 * El lead puede ser una EMPRESA (RUC de 11 dígitos) o una PERSONA NATURAL
 * (DNI de 8). El número vive en la columna `ruc` de tbl_leads en los dos casos
 * —se conserva el nombre histórico de la columna— y `tipo_documento` dice cuál
 * de los dos es.
 */

const TIPO_DOC_RUC = 'RUC';
const TIPO_DOC_DNI = 'DNI';
const TIPOS_DOCUMENTO = [TIPO_DOC_RUC, TIPO_DOC_DNI];

// Longitud exacta exigida por tipo (ambos son numéricos).
const LONGITUD_DOCUMENTO = { [TIPO_DOC_RUC]: 11, [TIPO_DOC_DNI]: 8 };

const BUEN_PAGADOR_SIN_CALIFICAR = 'Sin calificar';
const BUEN_PAGADOR_SI = 'Buen pagador';
const BUEN_PAGADOR_NO = 'No es buen pagador';
// Orden de presentación en los selectores y en el filtro de la lista.
const ESTADOS_BUEN_PAGADOR = [BUEN_PAGADOR_SIN_CALIFICAR, BUEN_PAGADOR_SI, BUEN_PAGADOR_NO];

const esTipoDocumentoValido = (v) => TIPOS_DOCUMENTO.includes(v);
const esBuenPagadorValido = (v) => ESTADOS_BUEN_PAGADOR.includes(v);

/**
 * Normaliza y valida el par (tipo de documento, número).
 * El documento es OPCIONAL en el lead: sin número no se exige tipo.
 * Devuelve { tipo_documento, numero } o { error }.
 */
function resolverDocumento(tipoBruto, numeroBruto) {
  const numero = String(numeroBruto ?? '').replace(/\D/g, '');
  const tipo = String(tipoBruto ?? '').trim().toUpperCase();

  if (!numero) {
    // Sin número no hay documento: se guarda el tipo solo si es válido, para
    // que el formulario recuerde la elección (Empresa / Persona natural).
    return { tipo_documento: esTipoDocumentoValido(tipo) ? tipo : null, numero: null };
  }
  if (tipo && !esTipoDocumentoValido(tipo)) {
    return { error: `El tipo de documento debe ser ${TIPOS_DOCUMENTO.join(' o ')}` };
  }
  // Sin tipo explícito se deduce por la longitud (11 → RUC, 8 → DNI): así los
  // leads antiguos, que solo tienen número, siguen validando.
  const tipoFinal = tipo || (numero.length === LONGITUD_DOCUMENTO[TIPO_DOC_DNI] ? TIPO_DOC_DNI : TIPO_DOC_RUC);
  const largo = LONGITUD_DOCUMENTO[tipoFinal];
  if (numero.length !== largo) {
    return { error: `El ${tipoFinal} debe tener ${largo} dígitos numéricos` };
  }
  return { tipo_documento: tipoFinal, numero };
}

module.exports = {
  TIPO_DOC_RUC,
  TIPO_DOC_DNI,
  TIPOS_DOCUMENTO,
  LONGITUD_DOCUMENTO,
  BUEN_PAGADOR_SIN_CALIFICAR,
  BUEN_PAGADOR_SI,
  BUEN_PAGADOR_NO,
  ESTADOS_BUEN_PAGADOR,
  esTipoDocumentoValido,
  esBuenPagadorValido,
  resolverDocumento
};

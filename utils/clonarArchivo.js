/**
 * Clona un archivo de `tbl_archivos`: copia el objeto en Wasabi a una nueva key
 * y crea una nueva fila en `tbl_archivos` apuntando a esa copia.
 *
 * Se usa al "jalar" la foto de una observación hacia un ítem de cotización: la
 * cotización debe conservar su propia foto aunque luego se elimine la
 * observación/servicio de origen (cuya baja borra el objeto en Wasabi).
 *
 * @param {object} tx        cliente Prisma (o transaccional)
 * @param {number} idArchivo id del tbl_archivos a clonar
 * @param {object} opts
 * @param {string} opts.tipo       carpeta destino (uno de uploadMiddleware.TIPOS_VALIDOS)
 * @param {number} opts.usuarioId  usuario que origina la copia
 * @returns {Promise<object|null>} la nueva fila tbl_archivos, o null si no existe el origen
 */
const { construirKey } = require('../middleware/uploadMiddleware');
const { keyDesdeRuta, copiarObjeto, existeObjeto } = require('./storage');

async function clonarArchivo(tx, idArchivo, { tipo = 'cotizaciones', usuarioId = null } = {}) {
  if (!idArchivo) return null;
  const origen = await tx.tbl_archivos.findUnique({ where: { id: Number(idArchivo) } });
  if (!origen || origen.estado !== 1) return null;

  const keyOrigen = keyDesdeRuta(origen.ruta_almacenamiento);
  if (!keyOrigen) return null;

  // Una foto de origen inexistente/inaccesible (referencia colgada de datos
  // antiguos) NO debe abortar la operación que clona: se omite la foto y el
  // ítem se crea sin imagen.
  try {
    if (!(await existeObjeto(keyOrigen))) {
      console.warn(`[clonarArchivo] objeto de origen ausente, se omite la foto: ${keyOrigen}`);
      return null;
    }
    const keyDestino = construirKey(tipo, origen.nombre_original);
    const { ruta } = await copiarObjeto({ keyOrigen, keyDestino });
    return await tx.tbl_archivos.create({
      data: {
        nombre_original: origen.nombre_original,
        ruta_almacenamiento: ruta,
        mime_type: origen.mime_type,
        tamano_bytes: origen.tamano_bytes,
        subido_por: usuarioId,
        user_id_registration: usuarioId
      }
    });
  } catch (err) {
    console.warn(`[clonarArchivo] no se pudo copiar la foto (${keyOrigen}): ${err.message}`);
    return null;
  }
}

module.exports = { clonarArchivo };

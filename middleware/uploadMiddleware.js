const Busboy = require('busboy');
const { subirObjetoStream, eliminarObjeto } = require('../utils/storage');

/**
 * Recepción de archivos por STREAMING, sin límite de peso.
 *
 * El multipart se parsea con busboy y el stream del archivo se enchufa
 * directamente al storage (multipart upload en Wasabi, escritura a disco en
 * local). El backend nunca retiene el archivo entero en memoria —solo la parte
 * en curso—, así que un video de varios GB no compromete al contenedor.
 *
 * Deliberadamente NO hay `limits.fileSize`: el técnico y el coordinador suben
 * fotos, videos y PDFs de evidencia del peso que haga falta. Los límites que
 * quedan son los del propio S3 (10 000 partes) y los del proxy que tenga
 * delante el despliegue.
 *
 * Deja el resultado en `req.archivo`:
 *   { key, ruta, originalname, mimetype, size, tipo }
 * y los campos de texto del formulario en `req.body`.
 */

const TIPOS_VALIDOS = new Set([
  'guias',
  'evidencias',
  'comprobantes',
  'facturas',
  'entregas',
  'cotizaciones',
  'contratos',
  'ot',
  'clientes',           // adjuntos libres del expediente del cliente
  'leads',              // documentos libres del lead (tbl_leads_archivos)
  'observaciones',      // adjuntos de tbl_servicios_observaciones
  'emergencias',        // fotos/videos de contexto de tbl_emergencias_archivos
  'informes-servicio',  // PDFs auto-generados por checklist de finalización
  'documents'
]);
const TIPO_DEFECTO = 'documents';

function resolverTipo(req) {
  const crudo = (req.body?.tipo || req.params?.tipo || req.query?.tipo || TIPO_DEFECTO).toString();
  return TIPOS_VALIDOS.has(crudo) ? crudo : TIPO_DEFECTO;
}

/** Construye la key destino en S3: `uploads/<tipo>/<yyyy>/<mm>/<unique>.<ext>` */
function construirKey(tipo, originalname) {
  const path = require('path');
  const ahora = new Date();
  const anio = ahora.getFullYear();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const ext = path.extname(originalname);
  return `uploads/${tipo}/${anio}/${mes}/${unique}${ext}`;
}

/**
 * Middleware de subida. `campo` es el nombre del input en el FormData.
 *
 * El campo `tipo` debe viajar ANTES del archivo en el FormData (así lo arma
 * `archivosService.upload` en el frontend) para que la carpeta destino se
 * resuelva antes de abrir el stream.
 */
function recibirArchivo(campo = 'archivo') {
  return (req, res, next) => {
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('multipart/form-data')) {
      return res.status(400).json({ error: 'Se esperaba multipart/form-data' });
    }

    // `files: 1` acota cuántos archivos acepta la petición, no su tamaño.
    const bb = Busboy({ headers: req.headers, limits: { files: 1 } });
    req.body = req.body || {};

    let subida = null;        // promesa de la subida al storage (nunca rechaza)
    let errorSubida = null;   // el fallo, si lo hubo, se reporta al cerrar busboy
    let keyEnCurso = null;    // para limpiar si la petición se corta a medias
    let streamArchivo = null; // stream del archivo en curso, para cortarlo si hace falta
    let terminado = false;

    /** Borra del storage el archivo a medias de una subida que no llegó a término. */
    const limpiarParcial = () => {
      Promise.resolve(subida).finally(() => {
        if (keyEnCurso) eliminarObjeto(keyEnCurso).catch(() => {});
      });
    };

    const fallar = (err) => {
      if (terminado) return;
      terminado = true;
      req.unpipe(bb);
      next(err);
    };

    bb.on('field', (nombre, valor) => { req.body[nombre] = valor; });

    bb.on('file', (nombre, stream, info) => {
      if (nombre !== campo) return stream.resume(); // campo desconocido: se descarta
      const tipo = resolverTipo(req);
      const originalname = info.filename || 'archivo';
      const mimetype = info.mimeType || 'application/octet-stream';
      const key = construirKey(tipo, originalname);
      keyEnCurso = key;
      streamArchivo = stream;

      // La promesa se resuelve siempre: el fallo se guarda y se atiende en
      // 'close'. Si rechazara, entre el fallo y ese 'close' habría una promesa
      // rechazada sin manejar, que en Node tumba el proceso.
      subida = subirObjetoStream({ key, stream, contentType: mimetype })
        .then(r => {
          req.archivo = { key, ruta: r.ruta, originalname, mimetype, size: r.bytes, tipo };
        })
        .catch(err => {
          errorSubida = err;
          // Se drena lo que falte del cuerpo para que busboy pueda cerrar y la
          // respuesta de error llegue al cliente en vez de cortarle el socket.
          stream.resume();
        });
    });

    bb.on('error', fallar);

    bb.on('close', async () => {
      if (terminado) return;
      if (!subida) {
        terminado = true;
        return res.status(400).json({ error: 'No se envió archivo' });
      }
      await subida;
      if (errorSubida) return fallar(errorSubida);
      // Cuerpo truncado (señal perdida a mitad del video): busboy cierra igual,
      // pero lo que llegó al storage es un archivo a medias. Registrarlo seria
      // darle por bueno, así que se descarta y no se responde: no hay socket.
      if (!req.complete) {
        terminado = true;
        limpiarParcial();
        return;
      }
      terminado = true;
      next();
    });

    // Si el técnico cancela o pierde la señal a mitad de un video, lo que se
    // haya escrito no debe quedarse ocupando espacio en el bucket. `req.complete`
    // es la señal fiable de que el cuerpo llegó entero (el evento 'aborted' está
    // deprecado y no siempre se emite).
    req.on('close', () => {
      if (req.complete) return; // cierre normal: el cuerpo se recibió completo
      terminado = true;         // no queda socket al que responder
      req.unpipe(bb);
      // Sin esto el stream del archivo se queda a la espera de datos que ya no
      // van a llegar: la subida nunca termina, el destino queda a medias y el
      // handle abierto. Destruirlo con error la hace fallar y limpiarse.
      streamArchivo?.destroy(new Error('La subida se interrumpió antes de terminar'));
      limpiarParcial();
    });

    req.pipe(bb);
  };
}

module.exports = {
  recibirArchivo,
  TIPOS_VALIDOS,
  TIPO_DEFECTO,
  resolverTipo,
  construirKey
};

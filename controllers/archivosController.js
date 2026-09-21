const prisma = require('../config/prisma');
const { eliminarObjeto, keyDesdeRuta } = require('../utils/storage');

/**
 * El archivo ya llegó al storage por streaming (middleware `recibirArchivo`):
 * aquí solo se registra en tbl_archivos. Si el registro falla, se borra el
 * objeto recién subido para no dejarlo huérfano en el bucket.
 */
const subir = async (req, res) => {
  const subido = req.archivo;
  if (!subido) return res.status(400).json({ error: 'No se envió archivo' });
  try {
    const archivo = await prisma.tbl_archivos.create({
      data: {
        nombre_original: subido.originalname,
        ruta_almacenamiento: subido.ruta,
        mime_type: subido.mimetype,
        tamano_bytes: subido.size,
        subido_por: req.user.id,
        user_id_registration: req.user.id
      }
    });
    res.status(201).json({ data: archivo });
  } catch (err) {
    console.error(err);
    try { await eliminarObjeto(subido.key); }
    catch (e) { console.warn('[archivos.subir] no se pudo limpiar el objeto huérfano:', e.message); }
    res.status(500).json({ error: 'Error al subir archivo' });
  }
};

const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const archivo = await prisma.tbl_archivos.findUnique({ where: { id } });
    if (!archivo) return res.status(404).json({ error: 'No encontrado' });
    const key = keyDesdeRuta(archivo.ruta_almacenamiento);
    if (key) {
      try { await eliminarObjeto(key); }
      catch (e) { console.warn('[archivos.eliminar] no se pudo borrar de Wasabi:', e.message); }
    }
    await prisma.tbl_archivos.update({
      where: { id }, data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar archivo' });
  }
};

module.exports = { subir, eliminar };

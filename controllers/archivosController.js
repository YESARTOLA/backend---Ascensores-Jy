const prisma = require('../config/prisma');
const { resolverTipo, construirKey } = require('../middleware/uploadMiddleware');
const { subirObjeto, eliminarObjeto, keyDesdeRuta, rutaDesdeKey } = require('../utils/storage');

const subir = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió archivo' });
    const tipo = resolverTipo(req);
    const key = construirKey(tipo, req.file.originalname);
    await subirObjeto({
      key,
      body: req.file.buffer,
      contentType: req.file.mimetype
    });
    const archivo = await prisma.tbl_archivos.create({
      data: {
        nombre_original: req.file.originalname,
        ruta_almacenamiento: rutaDesdeKey(key),
        mime_type: req.file.mimetype,
        tamano_bytes: req.file.size,
        subido_por: req.user.id,
        user_id_registration: req.user.id
      }
    });
    res.status(201).json({ data: archivo });
  } catch (err) {
    console.error(err);
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

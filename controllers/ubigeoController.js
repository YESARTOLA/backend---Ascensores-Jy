const prisma = require('../config/prisma');

// Catálogo oficial de ubigeo INEI (1,893 distritos). Se devuelve completo en
// una sola respuesta: el frontend lo cachea y arma la cascada
// Departamento → Provincia → Distrito en memoria, evitando un round-trip por
// cada select.
const listar = async (_req, res) => {
  try {
    const data = await prisma.tbl_ubigeo_peru.findMany({
      orderBy: [{ departamento: 'asc' }, { provincia: 'asc' }, { distrito: 'asc' }]
    });
    res.json({ data });
  } catch (err) {
    console.error('[ubigeo.listar]', err);
    res.status(500).json({ error: 'Error al listar ubigeo' });
  }
};

module.exports = { listar };

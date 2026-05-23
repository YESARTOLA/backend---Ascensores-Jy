const prisma = require('../config/prisma');
const { parseYMDLima, parseYMDFinDiaLima } = require('../utils/tiempo');
const { paginar } = require('../utils/paginacion');

const listar = async (req, res) => {
  try {
    const { entidad, id_entidad, accion, id_usuario, desde, hasta } = req.query;
    const where = {};
    if (entidad) where.entidad = entidad;
    if (id_entidad) where.id_entidad = Number(id_entidad);
    if (accion) where.accion = accion;
    if (id_usuario) where.id_usuario = Number(id_usuario);
    if (desde || hasta) {
      where.fecha_evento = {};
      if (desde) where.fecha_evento.gte = parseYMDLima(desde);
      if (hasta) where.fecha_evento.lte = parseYMDFinDiaLima(hasta);
    }
    const result = await paginar(
      prisma.tbl_auditoria,
      { where, orderBy: { fecha_evento: 'desc' }, take: req.query.page ? undefined : 500 },
      req.query
    );

    // tbl_auditoria.id_usuario no tiene relación FK declarada en Prisma, así
    // que hidratamos usuario (nombre + rol) con una consulta aparte y mergeamos.
    const ids = Array.from(new Set(result.data.map(e => e.id_usuario).filter(Boolean)));
    let mapaUsuarios = {};
    if (ids.length > 0) {
      const usuarios = await prisma.tbl_usuarios.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          nombres: true,
          correo: true,
          rol: { select: { codigo: true, nombre: true } }
        }
      });
      mapaUsuarios = Object.fromEntries(usuarios.map(u => [u.id, u]));
    }
    const data = result.data.map(e => ({
      ...e,
      usuario: e.id_usuario ? (mapaUsuarios[e.id_usuario] || null) : null
    }));

    res.json({ ...result, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar auditoría' });
  }
};

module.exports = { listar };

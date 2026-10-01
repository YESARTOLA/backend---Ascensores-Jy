const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const {
  AREAS_CLASIFICACION,
  COLORES_CLASIFICACION,
  COLOR_POR_DEFECTO,
  serializar,
  listarClasificaciones,
  generarCodigo
} = require('../utils/clasificacionesCliente');

/**
 * Catálogo de clasificaciones de cliente (utils/clasificacionesCliente.js).
 * Lectura abierta a cualquier usuario autenticado (alimenta selects, badges y
 * filtros); alta, edición y activación solo para super_admin / admin (ver
 * clientesRoutes). El código se genera al crear y no cambia: es lo que guardan
 * clientes y ascensores.
 */

/**
 * Todas las clasificaciones, activas e inactivas: los badges de clientes ya
 * clasificados deben poder mostrarse aunque su clasificación se desactive. Cada
 * una lleva cuántos clientes y ascensores activos la usan.
 */
const listar = async (_req, res) => {
  try {
    const [clasificaciones, usoClientes, usoAscensores] = await Promise.all([
      listarClasificaciones(prisma),
      prisma.tbl_clientes.groupBy({ by: ['clasificacion'], where: { estado: 1, clasificacion: { not: null } }, _count: true }),
      prisma.tbl_ascensores.groupBy({ by: ['clasificacion'], where: { estado: 1, clasificacion: { not: null } }, _count: true })
    ]);
    const cuenta = (filas) => Object.fromEntries(filas.map(f => [f.clasificacion, f._count]));
    const clientes = cuenta(usoClientes);
    const ascensores = cuenta(usoAscensores);
    res.json({
      data: clasificaciones.map(c => ({ ...c, clientes: clientes[c.codigo] || 0, ascensores: ascensores[c.codigo] || 0 }))
    });
  } catch (err) {
    console.error('[clasificacionesCliente.listar]', err);
    res.status(500).json({ error: 'Error al listar las clasificaciones' });
  }
};

/** Valida y normaliza etiqueta / área / color. `previo` al editar. */
async function validarDatos(body, previo = null) {
  const datos = {};
  if (!previo || body.etiqueta !== undefined) {
    const etiqueta = String(body.etiqueta ?? '').trim();
    if (!etiqueta) return { error: 'El nombre de la clasificación es obligatorio' };
    if (etiqueta.length > 80) return { error: 'El nombre admite como máximo 80 caracteres' };
    const duplicada = await prisma.tbl_clasificaciones_cliente.findFirst({
      where: { etiqueta: { equals: etiqueta, mode: 'insensitive' }, ...(previo ? { NOT: { id: previo.id } } : {}) }
    });
    if (duplicada) return { error: `Ya existe la clasificación «${duplicada.etiqueta}»` };
    datos.etiqueta = etiqueta;
  }
  if (!previo || body.area !== undefined) {
    if (!AREAS_CLASIFICACION.includes(body.area)) {
      return { error: `Área inválida. Valores permitidos: ${AREAS_CLASIFICACION.join(', ')}` };
    }
    datos.area = body.area;
  }
  if (!previo || body.color !== undefined) {
    const color = body.color || COLOR_POR_DEFECTO;
    if (!COLORES_CLASIFICACION[color]) return { error: 'Color inválido' };
    datos.color = color;
  }
  return { datos };
}

const crear = async (req, res) => {
  try {
    const { datos, error } = await validarDatos(req.body || {});
    if (error) return res.status(400).json({ error });
    const ultima = await prisma.tbl_clasificaciones_cliente.aggregate({ _max: { orden: true } });
    const creada = await prisma.tbl_clasificaciones_cliente.create({
      data: {
        ...datos,
        codigo: await generarCodigo(prisma, datos.etiqueta),
        orden: (ultima._max.orden || 0) + 1,
        user_id_registration: req.user.id
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_clasificaciones_cliente', id_entidad: creada.id,
      accion: 'CREATE', valor_nuevo: creada, ip: req.ip
    });
    res.status(201).json({ data: serializar(creada) });
  } catch (err) {
    console.error('[clasificacionesCliente.crear]', err);
    res.status(500).json({ error: 'Error al crear la clasificación' });
  }
};

/**
 * Edita nombre, área o color. El código no cambia, así que los clientes ya
 * clasificados conservan su clasificación con el nombre nuevo. Cambiar el área
 * no reclasifica a nadie: solo decide qué clientes pueden elegirla en adelante.
 */
const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await prisma.tbl_clasificaciones_cliente.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Clasificación no encontrada' });
    const { datos, error } = await validarDatos(req.body || {}, previo);
    if (error) return res.status(400).json({ error });
    const actualizada = await prisma.tbl_clasificaciones_cliente.update({
      where: { id },
      data: { ...datos, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_clasificaciones_cliente', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: actualizada, ip: req.ip
    });
    res.json({ data: serializar(actualizada) });
  } catch (err) {
    console.error('[clasificacionesCliente.actualizar]', err);
    res.status(500).json({ error: 'Error al actualizar la clasificación' });
  }
};

/**
 * Activa / desactiva. Desactivar no borra la clasificación de quien ya la
 * tiene: solo deja de ofrecerse al clasificar.
 */
const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const estado = Number(req.body?.estado);
    if (![0, 1].includes(estado)) return res.status(400).json({ error: 'Estado inválido (0 o 1)' });
    const previo = await prisma.tbl_clasificaciones_cliente.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Clasificación no encontrada' });
    const actualizada = await prisma.tbl_clasificaciones_cliente.update({
      where: { id },
      data: { estado, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_clasificaciones_cliente', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado }, ip: req.ip
    });
    res.json({ data: serializar(actualizada) });
  } catch (err) {
    console.error('[clasificacionesCliente.cambiarEstado]', err);
    res.status(500).json({ error: 'Error al cambiar el estado' });
  }
};

module.exports = { listar, crear, actualizar, cambiarEstado };

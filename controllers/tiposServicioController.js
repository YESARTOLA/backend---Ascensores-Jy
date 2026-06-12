const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const {
  CATEGORIAS_FUNCIONALES_META,
  MODULOS_META,
  normalizarCategoriaFuncional,
  validarModuloParaCategoria,
  clasificarTipoServicio,
} = require('../utils/clasificacionServicio');

// Decora una fila con datos derivados de la clasificación (sin lógica por categoría libre).
function decorar(t) {
  const esPadre = t.id_padre == null;
  const clas = esPadre
    ? { categoria_funcional: t.categoria_funcional, tipo_registro: null, modulo_asociado: null, es_proyecto: t.categoria_funcional === 'PROYECTOS', es_mantenimiento: false }
    : clasificarTipoServicio(t);
  return {
    ...t,
    es_padre: esPadre,
    categoria_funcional: clas.categoria_funcional,
    tipo_registro: clas.tipo_registro,
    es_proyecto: clas.es_proyecto,
    es_preventivo: clas.es_mantenimiento, // cupo gratuito = módulo mantenimiento
  };
}

// Catálogos dinámicos (categorías funcionales + módulos operativos) para el frontend.
const catalogos = async (_req, res) => {
  res.json({ data: { categorias_funcionales: CATEGORIAS_FUNCIONALES_META, modulos: MODULOS_META } });
};

const listar = async (req, res) => {
  try {
    const { solo_padres, solo_subtipos, id_padre, categoria_funcional, modulo_asociado } = req.query;
    const where = { estado: 1 };
    if (solo_padres === '1') where.id_padre = null;
    if (solo_subtipos === '1') where.id_padre = { not: null };
    if (id_padre) where.id_padre = Number(id_padre);
    if (modulo_asociado) where.modulo_asociado = String(modulo_asociado).toLowerCase();
    if (categoria_funcional) {
      const cf = String(categoria_funcional).toUpperCase();
      // Filtra padres de esa categoría y subtipos cuyo padre sea de esa categoría.
      where.OR = [
        { id_padre: null, categoria_funcional: cf },
        { padre: { categoria_funcional: cf } },
      ];
    }
    const tipos = await prisma.tbl_tipos_servicio.findMany({
      where,
      orderBy: [{ id_padre: 'asc' }, { id: 'asc' }],
      include: {
        padre: { select: { id: true, nombre: true, categoria_funcional: true } },
        tecnicos: { where: { estado: 1 }, include: { tecnico: { select: { id: true, nombre: true } } } },
        _count: { select: { subtipos: true } },
      },
    });
    res.json({ data: tipos.map(decorar) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar tipos de servicio' });
  }
};

const listarTecnicos = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rel = await prisma.tbl_tipos_servicio_tecnicos.findMany({
      where: { id_tipo_servicio: id, estado: 1 },
      include: { tecnico: true },
    });
    res.json({ data: rel.map(r => r.tecnico) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar técnicos del tipo' });
  }
};

const vincularTecnico = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { id_tecnico } = req.body;
    if (!id_tecnico) return res.status(400).json({ error: 'Técnico obligatorio' });
    const r = await prisma.tbl_tipos_servicio_tecnicos.upsert({
      where: { id_tipo_servicio_id_tecnico: { id_tipo_servicio: id, id_tecnico: Number(id_tecnico) } },
      update: { estado: 1, user_id_modification: req.user.id, date_time_modification: new Date() },
      create: { id_tipo_servicio: id, id_tecnico: Number(id_tecnico), user_id_registration: req.user.id },
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio_tecnicos', id_entidad: r.id,
      accion: 'LINK', valor_nuevo: { id_tipo_servicio: id, id_tecnico: Number(id_tecnico) }, ip: req.ip,
    });
    res.status(201).json({ data: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al vincular' });
  }
};

const desvincularTecnico = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const id_tecnico = Number(req.params.id_tecnico);
    await prisma.tbl_tipos_servicio_tecnicos.updateMany({
      where: { id_tipo_servicio: id, id_tecnico },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() },
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio_tecnicos', id_entidad: id,
      accion: 'UNLINK', valor_anterior: { id_tipo_servicio: id, id_tecnico }, ip: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al desvincular' });
  }
};

// Resuelve los campos jerárquicos a partir del body. Lanza Error con mensaje claro
// si la combinación padre/categoría/módulo es inconsistente.
async function resolverJerarquia(data) {
  const tieneCategoria = data.categoria_funcional != null && data.categoria_funcional !== '';
  const tienePadre = data.id_padre != null && data.id_padre !== '';

  if (tienePadre && tieneCategoria) {
    throw new Error('Indique padre (subtipo) o categoría funcional (padre), no ambos.');
  }

  if (tienePadre) {
    // Subtipo: hereda categoría funcional del padre; valida módulo según ella.
    const padre = await prisma.tbl_tipos_servicio.findUnique({ where: { id: Number(data.id_padre) } });
    if (!padre || padre.estado !== 1) throw new Error('Tipo padre inválido o inactivo.');
    if (padre.id_padre != null) throw new Error('El padre seleccionado ya es un subtipo.');
    const modulo = validarModuloParaCategoria(padre.categoria_funcional, data.modulo_asociado);
    return { id_padre: padre.id, categoria_funcional: null, modulo_asociado: modulo };
  }

  if (tieneCategoria) {
    // Padre: define categoría funcional; sin módulo.
    const cf = normalizarCategoriaFuncional(data.categoria_funcional);
    if (data.modulo_asociado) throw new Error('Un tipo padre no lleva módulo operativo.');
    return { id_padre: null, categoria_funcional: cf, modulo_asociado: null };
  }

  throw new Error('Un tipo de servicio debe ser un padre (con categoría funcional) o un subtipo (con padre).');
}

const crear = async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.nombre) return res.status(400).json({ error: 'Nombre obligatorio' });
    let jerarquia;
    try { jerarquia = await resolverJerarquia(data); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const tipo = await prisma.tbl_tipos_servicio.create({
      data: {
        nombre: data.nombre,
        ...jerarquia,
        descripcion: data.descripcion || null,
        user_id_registration: req.user.id,
      },
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio', id_entidad: tipo.id,
      accion: 'CREATE', valor_nuevo: tipo, ip: req.ip,
    });
    res.status(201).json({ data: tipo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear tipo' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body || {};
    const previo = await prisma.tbl_tipos_servicio.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Tipo no encontrado' });

    const esPadre = previo.id_padre == null;
    const payload = {
      nombre: data.nombre ?? previo.nombre,
      descripcion: data.descripcion ?? previo.descripcion,
      user_id_modification: req.user.id,
      date_time_modification: new Date(),
    };

    if (esPadre) {
      // Solo se permite cambiar la categoría funcional si no tiene subtipos con módulo
      // incompatible. Cambiar de SERVICIOS↔PROYECTOS afectaría a los subtipos, así que
      // se bloquea si ya tiene subtipos.
      if (data.categoria_funcional && String(data.categoria_funcional).toUpperCase() !== previo.categoria_funcional) {
        const nSub = await prisma.tbl_tipos_servicio.count({ where: { id_padre: id, estado: 1 } });
        if (nSub > 0) {
          return res.status(409).json({ error: 'No se puede cambiar la categoría funcional de un padre con subtipos. Reasigne o elimine sus subtipos primero.' });
        }
        try { payload.categoria_funcional = normalizarCategoriaFuncional(data.categoria_funcional); }
        catch (e) { return res.status(400).json({ error: e.message }); }
      }
    } else {
      // Subtipo: puede cambiar de padre y/o módulo. Validar coherencia.
      const idPadreNuevo = data.id_padre != null && data.id_padre !== '' ? Number(data.id_padre) : previo.id_padre;
      const padre = await prisma.tbl_tipos_servicio.findUnique({ where: { id: idPadreNuevo } });
      if (!padre || padre.estado !== 1 || padre.id_padre != null) {
        return res.status(400).json({ error: 'Tipo padre inválido.' });
      }
      const moduloEntrada = Object.prototype.hasOwnProperty.call(data, 'modulo_asociado') ? data.modulo_asociado : previo.modulo_asociado;
      try { payload.modulo_asociado = validarModuloParaCategoria(padre.categoria_funcional, moduloEntrada); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      payload.id_padre = padre.id;
    }

    const tipo = await prisma.tbl_tipos_servicio.update({ where: { id }, data: payload });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: tipo, ip: req.ip,
    });
    res.json({ data: decorar({ ...tipo, padre: tipo.id_padre ? await prisma.tbl_tipos_servicio.findUnique({ where: { id: tipo.id_padre }, select: { id: true, nombre: true, categoria_funcional: true } }) : null }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar tipo' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    const previo = await prisma.tbl_tipos_servicio.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Tipo no encontrado' });
    // Desactivar un padre con subtipos activos dejaría subtipos huérfanos visibles.
    if (Number(estado) === 0 && previo.id_padre == null) {
      const nSub = await prisma.tbl_tipos_servicio.count({ where: { id_padre: id, estado: 1 } });
      if (nSub > 0) return res.status(409).json({ error: 'Desactive o reasigne primero los subtipos de este padre.' });
    }
    const tipo = await prisma.tbl_tipos_servicio.update({
      where: { id }, data: { estado: Number(estado), user_id_modification: req.user.id, date_time_modification: new Date() },
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado: Number(estado) }, ip: req.ip,
    });
    res.json({ data: tipo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

// Soft-delete: estado = 0. El tipo desaparece de listados y selectores, pero
// los servicios históricos que lo referencian conservan su FK intacta.
const eliminar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const previo = await prisma.tbl_tipos_servicio.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Tipo no encontrado' });
    // Eliminar un padre con subtipos activos dejaría subtipos huérfanos visibles.
    if (previo.id_padre == null) {
      const nSub = await prisma.tbl_tipos_servicio.count({ where: { id_padre: id, estado: 1 } });
      if (nSub > 0) return res.status(409).json({ error: 'Elimine o reasigne primero los subtipos de este padre.' });
    }
    const tipo = await prisma.tbl_tipos_servicio.update({
      where: { id }, data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() },
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_tipos_servicio', id_entidad: id,
      accion: 'DELETE', valor_anterior: previo, valor_nuevo: tipo, ip: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar tipo' });
  }
};

module.exports = { listar, catalogos, crear, actualizar, cambiarEstado, eliminar, listarTecnicos, vincularTecnico, desvincularTecnico };

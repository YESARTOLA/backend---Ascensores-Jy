const prisma = require('../config/prisma');
const bcrypt = require('bcrypt');
const { registrarAuditoria } = require('../utils/auditoria');
const { paginar } = require('../utils/paginacion');
const { ROLES_CON_ALCANCE, ROLES_CON_ALCANCE_EDIFICIOS } = require('../utils/alcanceUsuario');

/**
 * Resuelve los flags de ámbito a guardar:
 *   - acceso_servicios / acceso_proyectos → Administrador y Coordinador.
 *   - acceso_edificios / acceso_obras     → solo Administrador.
 * Para los roles a los que no aplican se fuerzan a 1 (se ignoran en runtime). En
 * cada dimensión con alcance se exige marcar al menos uno. `previo` conserva el
 * valor actual en una edición parcial.
 * @returns {{acceso_servicios,acceso_proyectos,acceso_edificios,acceso_obras}|{error:string}}
 */
async function resolverAccesoAmbito(idRol, body, previo = null) {
  const rol = await prisma.tbl_roles.findUnique({ where: { id: Number(idRol) }, select: { codigo: true } });
  const codigo = rol?.codigo;
  const resolver = (campo) => {
    if (body[campo] !== undefined) return body[campo] ? 1 : 0;
    if (previo && previo[campo] !== undefined && previo[campo] !== null) return previo[campo];
    return 1;
  };

  // Ámbito Servicios / Proyectos (Administrador y Coordinador).
  let acceso_servicios = 1, acceso_proyectos = 1;
  if (codigo && ROLES_CON_ALCANCE.includes(codigo)) {
    acceso_servicios = resolver('acceso_servicios');
    acceso_proyectos = resolver('acceso_proyectos');
    if (acceso_servicios === 0 && acceso_proyectos === 0) {
      return { error: 'Debe marcar al menos un ámbito (Servicios o Proyectos)' };
    }
  }

  // Alcance por tipo de edificio: Edificios / Obras (solo Administrador).
  let acceso_edificios = 1, acceso_obras = 1;
  if (codigo && ROLES_CON_ALCANCE_EDIFICIOS.includes(codigo)) {
    acceso_edificios = resolver('acceso_edificios');
    acceso_obras = resolver('acceso_obras');
    if (acceso_edificios === 0 && acceso_obras === 0) {
      return { error: 'Debe marcar al menos un tipo de ubicación (Edificios u Obras)' };
    }
  }

  return { acceso_servicios, acceso_proyectos, acceso_edificios, acceso_obras };
}

const listar = async (req, res) => {
  try {
    const { q } = req.query;
    const where = {};
    if (q) where.OR = [
      { nombres: { contains: q, mode: 'insensitive' } },
      { correo: { contains: q, mode: 'insensitive' } }
    ];

    // paginar() devuelve { data } sin ?page= (compatibilidad) o el sobre
    // completo cuando la vista pagina. En ambos casos se enmascara la contraseña.
    const result = await paginar(
      prisma.tbl_usuarios,
      { where, orderBy: { id: 'asc' }, include: { rol: true, tecnico: true } },
      req.query
    );
    result.data = result.data.map(u => ({ ...u, contrasena: undefined }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar usuarios' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.nombres || !d.correo || !d.contrasena || !d.id_rol) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    const exists = await prisma.tbl_usuarios.findUnique({ where: { correo: d.correo } });
    if (exists) return res.status(400).json({ error: 'Correo ya registrado' });
    const acceso = await resolverAccesoAmbito(d.id_rol, d);
    if (acceso.error) return res.status(400).json({ error: acceso.error });
    const hash = await bcrypt.hash(d.contrasena, 10);
    const u = await prisma.tbl_usuarios.create({
      data: {
        nombres: d.nombres,
        correo: d.correo,
        contrasena: hash,
        id_rol: Number(d.id_rol),
        id_tecnico: d.id_tecnico ? Number(d.id_tecnico) : null,
        telefono: d.telefono || null,
        acceso_servicios: acceso.acceso_servicios,
        acceso_proyectos: acceso.acceso_proyectos,
        acceso_edificios: acceso.acceso_edificios,
        acceso_obras: acceso.acceso_obras,
        user_id_registration: req.user.id
      }
    });
    await registrarAuditoria({ id_usuario: req.user.id, entidad: 'tbl_usuarios', id_entidad: u.id, accion: 'CREATE', valor_nuevo: { ...u, contrasena: '***' }, ip: req.ip });
    res.status(201).json({ data: { ...u, contrasena: undefined } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_usuarios.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'No encontrado' });
    const idRolFinal = d.id_rol ? Number(d.id_rol) : previo.id_rol;
    const acceso = await resolverAccesoAmbito(idRolFinal, d, previo);
    if (acceso.error) return res.status(400).json({ error: acceso.error });
    const data = {
      nombres: d.nombres ?? previo.nombres,
      correo: d.correo ?? previo.correo,
      id_rol: idRolFinal,
      id_tecnico: d.id_tecnico !== undefined ? (d.id_tecnico ? Number(d.id_tecnico) : null) : previo.id_tecnico,
      telefono: d.telefono ?? previo.telefono,
      acceso_servicios: acceso.acceso_servicios,
      acceso_proyectos: acceso.acceso_proyectos,
      acceso_edificios: acceso.acceso_edificios,
      acceso_obras: acceso.acceso_obras,
      user_id_modification: req.user.id,
      date_time_modification: new Date()
    };
    const cambiaContrasena = !!d.contrasena;
    if (cambiaContrasena) data.contrasena = await bcrypt.hash(d.contrasena, 10);
    const u = await prisma.tbl_usuarios.update({ where: { id }, data });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_usuarios', id_entidad: id,
      accion: cambiaContrasena ? 'UPDATE_WITH_PASSWORD' : 'UPDATE',
      valor_anterior: { ...previo, contrasena: '***' },
      valor_nuevo: { ...u, contrasena: '***' },
      ip: req.ip
    });
    res.json({ data: { ...u, contrasena: undefined } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    const previo = await prisma.tbl_usuarios.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Usuario no encontrado' });
    const u = await prisma.tbl_usuarios.update({
      where: { id },
      data: { estado: Number(estado), user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_usuarios', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_anterior: { estado: previo.estado }, valor_nuevo: { estado: Number(estado) }, ip: req.ip
    });
    res.json({ data: { ...u, contrasena: undefined } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
};

const roles = async (_req, res) => {
  try {
    const list = await prisma.tbl_roles.findMany({ where: { estado: 1 } });
    res.json({ data: list });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar roles' });
  }
};

const permisos = async (_req, res) => {
  try {
    const list = await prisma.tbl_permisos.findMany({ where: { estado: 1 } });
    res.json({ data: list });
  } catch (err) {
    res.status(500).json({ error: 'Error al listar permisos' });
  }
};

module.exports = { listar, crear, actualizar, cambiarEstado, roles, permisos };

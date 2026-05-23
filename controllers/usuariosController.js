const prisma = require('../config/prisma');
const bcrypt = require('bcrypt');
const { registrarAuditoria } = require('../utils/auditoria');

const listar = async (_req, res) => {
  try {
    const users = await prisma.tbl_usuarios.findMany({
      orderBy: { id: 'asc' },
      include: { rol: true, tecnico: true }
    });
    res.json({ data: users.map(u => ({ ...u, contrasena: undefined })) });
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
    const hash = await bcrypt.hash(d.contrasena, 10);
    const u = await prisma.tbl_usuarios.create({
      data: {
        nombres: d.nombres,
        correo: d.correo,
        contrasena: hash,
        id_rol: Number(d.id_rol),
        id_tecnico: d.id_tecnico ? Number(d.id_tecnico) : null,
        telefono: d.telefono || null,
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
    const data = {
      nombres: d.nombres ?? previo.nombres,
      correo: d.correo ?? previo.correo,
      id_rol: d.id_rol ? Number(d.id_rol) : previo.id_rol,
      id_tecnico: d.id_tecnico !== undefined ? (d.id_tecnico ? Number(d.id_tecnico) : null) : previo.id_tecnico,
      telefono: d.telefono ?? previo.telefono,
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

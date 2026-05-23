const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { findUserByEmail, findUserById, updateUltimoLogin } = require('../models/authModel');

const login = async (req, res) => {
  const { correo, contrasena } = req.body;

  if (!correo || !contrasena) {
    return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
  }

  try {
    const usuario = await findUserByEmail(correo);

    if (!usuario) {
      return res.status(404).json({ error: 'Correo no registrado o usuario inactivo' });
    }

    const coincide = await bcrypt.compare(contrasena, usuario.contrasena);
    if (!coincide) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const token = jwt.sign(
      {
        id: usuario.id,
        correo: usuario.correo,
        id_rol: usuario.id_rol,
        rol_codigo: usuario.rol_codigo,
        id_tecnico: usuario.id_tecnico
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await updateUltimoLogin(usuario.id);

    res.json({
      mensaje: 'Login exitoso',
      token,
      usuario: {
        id: usuario.id,
        nombres: usuario.nombres,
        correo: usuario.correo,
        id_rol: usuario.id_rol,
        id_tecnico: usuario.id_tecnico,
        rol: usuario.rol,
        rol_codigo: usuario.rol_codigo,
        permisos: usuario.permisos
      }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
};

const me = async (req, res) => {
  try {
    const usuario = await findUserById(req.user.id);
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ usuario });
  } catch (error) {
    console.error('Error en /me:', error);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
};

const logout = async (_req, res) => {
  res.json({ mensaje: 'Sesión cerrada' });
};

const cambiarContrasena = async (req, res) => {
  const { contrasena_actual, contrasena_nueva } = req.body;
  if (!contrasena_actual || !contrasena_nueva) {
    return res.status(400).json({ error: 'Contraseña actual y nueva son obligatorias' });
  }
  if (String(contrasena_nueva).length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }
  try {
    const prisma = require('../config/prisma');
    const usuario = await prisma.tbl_usuarios.findUnique({ where: { id: req.user.id } });
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    const ok = await bcrypt.compare(contrasena_actual, usuario.contrasena);
    if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    const hash = await bcrypt.hash(contrasena_nueva, 10);
    await prisma.tbl_usuarios.update({
      where: { id: req.user.id },
      data: { contrasena: hash, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    res.json({ mensaje: 'Contraseña actualizada' });
  } catch (err) {
    console.error('Error al cambiar contraseña:', err);
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
};

module.exports = { login, me, logout, cambiarContrasena };

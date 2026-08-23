require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const jwt = require('jsonwebtoken');
const { findUserByEmail } = require('../../models/authModel');
const prisma = require('../../config/prisma');
(async () => {
  const fila = await prisma.tbl_usuarios.findFirst({ where: { estado: 1, rol: { codigo: 'super_admin' } }, select: { correo: true } });
  const u = await findUserByEmail(fila.correo);
  const p = { id: u.id, correo: u.correo, id_rol: u.id_rol, rol_codigo: u.rol_codigo, id_tecnico: u.id_tecnico, acceso_servicios: u.acceso_servicios, acceso_proyectos: u.acceso_proyectos, acceso_edificios: u.acceso_edificios, acceso_obras: u.acceso_obras };
  console.log(JSON.stringify({ token: jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '2h' }), usuario: { id: u.id, nombres: u.nombres, correo: u.correo, id_rol: u.id_rol, id_tecnico: u.id_tecnico, acceso_servicios: u.acceso_servicios, acceso_proyectos: u.acceso_proyectos, acceso_edificios: u.acceso_edificios, acceso_obras: u.acceso_obras, rol: u.rol, rol_codigo: u.rol_codigo, permisos: u.permisos } }));
  await prisma.$disconnect();
})();

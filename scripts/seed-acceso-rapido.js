/**
 * Sincroniza las credenciales del ACCESO RÁPIDO del login (solo entorno local).
 *
 * El panel "Dev · Solo local" de `frontend/src/pages/Login.jsx` entra con un
 * usuario por rol. Este script deja esas cuentas usables en la base local:
 *   · Usa los usuarios que YA existen (los de la empresa), uno por rol.
 *   · Les fija la contraseña esperada por el botón, solo si aún no coincide.
 *   · Da de alta al usuario de pruebas que falte (hoy: la Vendedora, un rol sin
 *     ningún usuario en la base).
 *
 * Es idempotente: reejecutarlo no cambia nada si todo ya está en orden.
 *
 * ⚠️ SOLO PARA LA BASE LOCAL. Toca contraseñas de cuentas reales, así que nunca
 * debe correrse contra producción. El script aborta si DATABASE_URL no apunta a
 * localhost.
 *
 * Uso:  node scripts/seed-acceso-rapido.js
 */
require('dotenv').config({ quiet: true });
const bcrypt = require('bcrypt');
const prisma = require('../config/prisma');

// Espejo de USERS en frontend/src/pages/Login.jsx — mantener en sincronía.
const CUENTAS = [
  { rol: 'super_admin',   correo: 'superadmin@ascensoresjy.com',     pass: 'Admin2026!' },
  { rol: 'admin',         correo: 'preventivo@ascensoresjy.com',     pass: 'Demo2026!' },
  { rol: 'coordinador',   correo: 'oficinatecnica@ascensoresjy.com', pass: 'Demo2026!' },
  { rol: 'contabilidad',  correo: 'contabilidad@ascensoresjy.com',   pass: 'Demo2026!' },
  { rol: 'central_ventas', correo: 'cventas@gmail.com',              pass: 'Demo2026!' },
  { rol: 'tecnico',       correo: 'freddyhuata44@gmail.com',         pass: 'Demo2026!' },
  // Rol sin ningún usuario en la base: se crea una cuenta de pruebas.
  { rol: 'vendedora',     correo: 'vendedora@ascensoresjy.com',      pass: 'Demo2026!',
    crearSiFalta: { nombres: 'Vendedora (pruebas)' } }
];

function abortarSiNoEsLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    console.error('✖ DATABASE_URL no apunta a localhost. Este script solo se ejecuta contra la base local.');
    process.exit(1);
  }
}

async function main() {
  abortarSiNoEsLocal();

  const roles = await prisma.tbl_roles.findMany({ select: { id: true, codigo: true } });
  const idDeRol = new Map(roles.map(r => [r.codigo, r.id]));

  for (const c of CUENTAS) {
    const idRol = idDeRol.get(c.rol);
    if (!idRol) { console.log(`⚠ ${c.rol}: el rol no existe en la base — omitido`); continue; }

    let u = await prisma.tbl_usuarios.findUnique({
      where: { correo: c.correo },
      select: { id: true, contrasena: true, estado: true, id_rol: true, nombres: true }
    });

    if (!u) {
      if (!c.crearSiFalta) { console.log(`⚠ ${c.rol}: no existe ${c.correo} y no está marcado para crearse — omitido`); continue; }
      const creado = await prisma.tbl_usuarios.create({
        data: {
          nombres: c.crearSiFalta.nombres,
          correo: c.correo,
          contrasena: await bcrypt.hash(c.pass, 10),
          id_rol: idRol
          // acceso_* quedan en su default (1): sin restricción de ámbito.
        },
        select: { id: true }
      });
      console.log(`+ ${c.rol}: creado ${c.correo} (#${creado.id})`);
      continue;
    }

    const parche = {};
    if (!(await bcrypt.compare(c.pass, u.contrasena))) parche.contrasena = await bcrypt.hash(c.pass, 10);
    if (u.estado !== 1) parche.estado = 1;
    if (u.id_rol !== idRol) {
      // No se reasignan roles de cuentas reales sin querer: se avisa y se deja.
      console.log(`⚠ ${c.rol}: ${c.correo} tiene otro rol (id_rol=${u.id_rol}) — no se toca el rol`);
    }

    if (Object.keys(parche).length === 0) {
      console.log(`= ${c.rol}: ${c.correo} ya estaba listo`);
      continue;
    }
    parche.date_time_modification = new Date();
    await prisma.tbl_usuarios.update({ where: { id: u.id }, data: parche });
    console.log(`↻ ${c.rol}: ${c.correo} — ${Object.keys(parche).filter(k => k !== 'date_time_modification').join(', ')} actualizado`);
  }
}

main()
  .catch(e => { console.error('ERR', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

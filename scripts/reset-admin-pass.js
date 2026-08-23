/**
 * Restablece la contraseña del super admin de DESARROLLO a la misma que rellena
 * el botón "Acceso rápido" del login.
 *
 * IMPORTANTE: esta clave debe coincidir con la de `QuickAccessDev` en
 * frontend/src/pages/Login.jsx. Si divergen, el atajo del login deja de
 * funcionar sin ninguna señal de por qué (el botón rellena una contraseña que
 * la base ya no reconoce) — que es justo lo que pasaba cuando este script
 * ponía 'Admin123!' y el botón enviaba 'Admin2026!'.
 *
 * Uso: node scripts/reset-admin-pass.js
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const prisma = require('../config/prisma');

// Espejo de QuickAccessDev (frontend/src/pages/Login.jsx). Mantener sincronizado.
const CLAVE_ACCESO_RAPIDO = 'Admin2026!';

(async () => {
  const correo = process.env.SEED_ADMIN_EMAIL || 'superadmin@ascensoresjy.com';
  const u = await prisma.tbl_usuarios.findUnique({ where: { correo } });
  if (!u) {
    console.error(`No existe usuario ${correo}`);
    process.exit(1);
  }
  await prisma.tbl_usuarios.update({
    where: { correo },
    data: { contrasena: bcrypt.hashSync(CLAVE_ACCESO_RAPIDO, 10) }
  });
  console.log(`OK: contraseña de ${correo} cambiada a ${CLAVE_ACCESO_RAPIDO}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

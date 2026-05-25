require('dotenv').config();
const bcrypt = require('bcrypt');
const prisma = require('../config/prisma');

(async () => {
  const correo = process.env.SEED_ADMIN_EMAIL || 'superadmin@ascensoresjy.com';
  const nueva = 'Admin123!';
  const u = await prisma.tbl_usuarios.findUnique({ where: { correo } });
  if (!u) {
    console.error(`No existe usuario ${correo}`);
    process.exit(1);
  }
  await prisma.tbl_usuarios.update({
    where: { correo },
    data: { contrasena: bcrypt.hashSync(nueva, 10) }
  });
  console.log(`OK: contraseña de ${correo} cambiada a ${nueva}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

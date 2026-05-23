# Ascensores Jy — Backend

ERP operativo para empresa de instalación, reparación, mantenimiento y atención de emergencias de ascensores.

## Stack

- Node.js + Express 4
- PostgreSQL
- Prisma ORM
- JWT + bcrypt
- Multer (archivos)

## Variables de entorno

```
PORT=4000
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=...
DB_NAME=db_ascensores_jy
DB_PORT=5432
JWT_SECRET=...
JWT_EXPIRES_IN=8h
TZ=America/Lima
DATABASE_URL="postgresql://user:pass@host:5432/db_ascensores_jy?schema=public"
```

## Comandos

```bash
npm install
npx prisma generate
npx prisma db push     # crea/actualiza esquema
npm run db:seed        # carga data demo
npm run dev            # inicia con nodemon
```

## Usuarios demo (contraseña: admin123)

| Correo | Rol |
|--------|-----|
| superadmin@ascensoresjy.com | Super Administrador |
| admin@ascensoresjy.com | Administrador |
| coordinador@ascensoresjy.com | Coordinador |
| contabilidad@ascensoresjy.com | Contabilidad |
| carlos@ascensoresjy.com | Técnico |
| juan@ascensoresjy.com | Técnico |

## APIs principales

- POST /api/auth/login → autenticación
- GET /api/auth/me → usuario actual
- /api/clientes, /api/ascensores, /api/tecnicos, /api/tipos-servicio
- /api/servicios → CRUD + asignación + iniciar + finalizar + cancelar
- /api/checklists → checklist de salida
- /api/cobros → gestión de cobros + pagos + recordatorio WhatsApp
- /api/facturas, /api/emergencias, /api/mantenimientos
- /api/leads, /api/atenciones-rapidas, /api/calendario, /api/dashboard
- /api/reportes, /api/auditoria, /api/entregas, /api/archivos

## Manejo de fechas/horas

- TZ del proceso: `America/Lima` (definida vía `.env` y `process.env.TZ`).
- Todas las columnas de fecha/hora usan `timestamptz(6)`: PostgreSQL almacena en UTC pero respeta zona del cliente al consultar.
- El frontend renderiza fechas con `Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima' })` para evitar desfases en Railway u otros entornos UTC.

-- Rol "Central de ventas": punto de captura comercial. Registra el lead y a qué
-- Vendedora queda asignado; solo tiene acceso al módulo de Leads (el resto del
-- sistema le queda fuera, por ruta en el backend y por guard en el frontend).
-- El enforcement real es por `codigo` de rol (utils/accesoLeads.js): este código
-- NO debe cambiarse.
INSERT INTO "tbl_roles" ("codigo", "nombre", "descripcion")
VALUES ('central_ventas', 'Central de ventas', 'Captura de leads y asignación a la vendedora responsable')
ON CONFLICT ("codigo") DO NOTHING;

-- Permisos por defecto del rol (mismo criterio que prisma/seed.js): leads y los
-- catálogos de solo lectura que necesita su formulario.
INSERT INTO "tbl_roles_permisos" ("id_rol", "id_permiso")
SELECT r."id", p."id"
FROM "tbl_roles" r
JOIN "tbl_permisos" p
  ON p."codigo" IN ('leads.ver', 'leads.crear', 'leads.editar', 'clientes.ver', 'tipos_servicio.ver')
WHERE r."codigo" = 'central_ventas'
ON CONFLICT ("id_rol", "id_permiso") DO NOTHING;

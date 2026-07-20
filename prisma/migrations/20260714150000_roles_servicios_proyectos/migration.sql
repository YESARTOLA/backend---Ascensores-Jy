-- Roles inherentemente acotados a un área: "Servicios" y "Proyectos". Tienen los
-- permisos de un Coordinador pero limitados a su ámbito (acceso_servicios /
-- acceso_proyectos). El backend los trata como coordinador para RBAC y fija su
-- ámbito en utils/alcanceUsuario.js.
INSERT INTO "tbl_roles" ("codigo", "nombre", "descripcion")
VALUES
  ('servicios', 'Servicios', 'Coordinación acotada al área de Servicios'),
  ('proyectos', 'Proyectos', 'Coordinación acotada al área de Proyectos')
ON CONFLICT ("codigo") DO NOTHING;

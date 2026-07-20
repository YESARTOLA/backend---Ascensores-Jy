-- Se descartan los roles dedicados "Servicios" y "Proyectos": el área se maneja
-- con los flags de ámbito (acceso_servicios / acceso_proyectos), que ahora aplican
-- a cualquier rol (vendedora, contabilidad, etc.). Solo se borran si ningún
-- usuario los tiene asignado (evita romper la FK).
DELETE FROM "tbl_roles"
WHERE "codigo" IN ('servicios', 'proyectos')
  AND "id" NOT IN (SELECT DISTINCT "id_rol" FROM "tbl_usuarios");

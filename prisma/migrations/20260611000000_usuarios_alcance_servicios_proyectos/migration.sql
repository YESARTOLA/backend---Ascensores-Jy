-- Ámbito de acceso por usuario para los roles Administrador y Coordinador.
-- Cada usuario puede tener acceso al ámbito de Servicios y/o Proyectos. El
-- control de visibilidad (clientes, ascensores, módulos y datos derivados) se
-- deriva de estos dos flags + el tipo_registro de tbl_servicios_proyectos
-- (ver backend/utils/alcanceUsuario.js). Para el resto de roles se ignoran.
-- Default 1 (ambos) para NO alterar el acceso de los usuarios ya existentes.
ALTER TABLE "tbl_usuarios" ADD COLUMN "acceso_servicios" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tbl_usuarios" ADD COLUMN "acceso_proyectos" INTEGER NOT NULL DEFAULT 1;

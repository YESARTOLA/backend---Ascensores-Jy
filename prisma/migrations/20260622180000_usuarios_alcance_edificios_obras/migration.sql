-- Alcance por TIPO de edificio (Edificio / Obra) para el rol Administrador.
-- Cada Administrador puede acotarse a ver solo Edificios, solo Obras o ambos.
-- El control de visibilidad (edificios, ascensores y todo lo operativo que cuelga
-- de un ascensor) se deriva de estos dos flags + el `tipo` de tbl_edificios
-- (ver backend/utils/alcanceUsuario.js). Para el resto de roles se ignoran.
-- Default 1 (ambos) para NO alterar el acceso de los usuarios ya existentes.
ALTER TABLE "tbl_usuarios" ADD COLUMN "acceso_edificios" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tbl_usuarios" ADD COLUMN "acceso_obras" INTEGER NOT NULL DEFAULT 1;

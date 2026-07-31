-- Datos operativos del servicio que carga el coordinador desde el detalle
-- (card "Datos"): contacto en sitio (nombre + teléfono) y si el edificio tiene
-- cuarto de máquinas.
--
-- `cuarto_maquinas` guarda únicamente 'Si' / 'No'; NULL = todavía no definido
-- (los servicios existentes quedan así, sin suponer una respuesta).
-- Idempotente para no chocar en bases donde ya se aplicó parcialmente.

ALTER TABLE "tbl_servicios_proyectos" ADD COLUMN IF NOT EXISTS "contacto_nombre" VARCHAR(150);
ALTER TABLE "tbl_servicios_proyectos" ADD COLUMN IF NOT EXISTS "contacto_telefono" VARCHAR(30);
ALTER TABLE "tbl_servicios_proyectos" ADD COLUMN IF NOT EXISTS "cuarto_maquinas" VARCHAR(2);

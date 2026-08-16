-- Datos de sitio del ascensor: contacto en sitio (nombre + teléfono) y si tiene
-- cuarto de máquinas ('Si' / 'No'; NULL = sin definir). Mismos nombres y dominio
-- que las columnas homónimas de tbl_servicios_proyectos, porque cada servicio
-- nuevo sobre el ascensor los hereda al crearse (utils/datosSitioAscensor.js).
ALTER TABLE "tbl_ascensores" ADD COLUMN IF NOT EXISTS "contacto_nombre" VARCHAR(150);
ALTER TABLE "tbl_ascensores" ADD COLUMN IF NOT EXISTS "contacto_telefono" VARCHAR(30);
ALTER TABLE "tbl_ascensores" ADD COLUMN IF NOT EXISTS "cuarto_maquinas" VARCHAR(2);

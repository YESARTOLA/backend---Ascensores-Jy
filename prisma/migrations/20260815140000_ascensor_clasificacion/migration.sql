-- Clasificación comercial del ascensor. Usa el mismo catálogo cerrado que la
-- clasificación del cliente (grande / pequeno / marca_jy / glarie / proyectos,
-- ver utils/catalogosClientes.js), pero se registra por ascensor: un mismo
-- cliente puede tener ascensores de distinta clasificación.
ALTER TABLE "tbl_ascensores" ADD COLUMN "clasificacion" VARCHAR(20);

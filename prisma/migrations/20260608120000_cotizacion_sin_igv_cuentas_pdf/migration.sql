-- Cotización: opción de cotizar SIN IGV (afecta cálculo y PDF) y selección de
-- qué cuentas bancarias se adjuntan en el PDF.
--   sin_igv     : si true, el IGV es 0 y el total = subtotal.
--   cuentas_pdf : array JSON de ids de cuentas bancarias elegidas para el PDF.
--                 NULL = versión previa a esta feature (el PDF muestra todas las
--                 cuentas activas, como antes). [] = ninguna.
ALTER TABLE "tbl_cotizaciones_versiones" ADD COLUMN "sin_igv" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tbl_cotizaciones_versiones" ADD COLUMN "cuentas_pdf" JSONB;

-- Cotización: texto libre de garantía por versión.
--   garantia : lo que se ofrece como garantía en esa versión. Se imprime en el
--              PDF como "Garantía: <texto>". NULL = versión previa a esta
--              feature o sin garantía declarada (el PDF omite el bloque).
ALTER TABLE "tbl_cotizaciones_versiones" ADD COLUMN "garantia" TEXT;

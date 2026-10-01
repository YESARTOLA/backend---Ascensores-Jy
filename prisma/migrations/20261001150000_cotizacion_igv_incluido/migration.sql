-- Cotizaciones con el IGV incluido en el precio.
--
-- Hasta ahora una versión podía cotizarse "más IGV" (el IGV se suma al precio
-- registrado) o "sin IGV". Se añade el tercer caso: el precio registrado ya es
-- el final y el IGV se desglosa sin aumentarlo (total 118 → subtotal 100 + IGV
-- 18). Las versiones existentes quedan como estaban (false).
ALTER TABLE "tbl_cotizaciones_versiones" ADD COLUMN "igv_incluido" BOOLEAN NOT NULL DEFAULT false;

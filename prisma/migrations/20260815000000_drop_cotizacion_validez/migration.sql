-- Se elimina el concepto de "Validez" de las cotizaciones: ya no se pide una
-- fecha límite al cotizar ni se muestra en listados, detalle, PDF ni
-- exportaciones. Con ello desaparece también el parámetro de configuración que
-- calculaba la fecha por defecto.
ALTER TABLE "tbl_cotizaciones_versiones" DROP COLUMN "fecha_validez";

DELETE FROM "tbl_configuracion" WHERE "clave" = 'COTIZACION_VALIDEZ_DIAS';

-- Los términos por defecto del PDF referenciaban la fecha de validez. Solo se
-- reescriben si siguen siendo el texto sembrado (no se pisa un texto editado).
UPDATE "tbl_configuracion"
SET "valor" = 'Precios en soles, incluyen IGV. Forma de pago se acuerda al confirmar el servicio.'
WHERE "clave" = 'COTIZACION_TERMINOS'
  AND "valor" = 'Cotización válida hasta la fecha indicada. Precios en soles, incluyen IGV. Forma de pago se acuerda al confirmar el servicio.';

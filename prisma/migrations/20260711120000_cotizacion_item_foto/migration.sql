-- Foto por ítem de cotización (obligatoria en cotizaciones de correctivo).
-- NOTA: la columna "id_archivo" y su FK ya pueden existir por la migración previa
-- 20260624000000_cotizacion_desde_observaciones. Se aplica de forma idempotente
-- para evitar colisiones en bases limpias (código 42701 / 42710).
ALTER TABLE "tbl_cotizaciones_items" ADD COLUMN IF NOT EXISTS "id_archivo" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_cotizaciones_items_id_archivo_fkey'
  ) THEN
    ALTER TABLE "tbl_cotizaciones_items"
      ADD CONSTRAINT "tbl_cotizaciones_items_id_archivo_fkey"
      FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Foto por ítem de cotización (obligatoria en cotizaciones de correctivo).
ALTER TABLE "tbl_cotizaciones_items" ADD COLUMN "id_archivo" INTEGER;
ALTER TABLE "tbl_cotizaciones_items"
  ADD CONSTRAINT "tbl_cotizaciones_items_id_archivo_fkey"
  FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

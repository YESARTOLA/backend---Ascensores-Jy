-- Crear cotización desde observaciones de un servicio de mantenimiento.
--
-- Las observaciones del técnico (texto + foto) pueden "jalarse" hacia una nueva
-- cotización: cada observación se vuelve un ítem que arrastra su foto (copiada).
--
-- 1) tbl_cotizaciones_items.id_archivo: foto opcional por ítem (la copiada desde
--    la observación de origen, o cualquier foto que el ítem lleve).
-- 2) tbl_servicios_observaciones.id_cotizacion: cotización donde la observación
--    fue usada como ítem. Marca la observación como "ya cotizada" para no
--    convertirla dos veces y deja trazabilidad.
--
-- onDelete SET NULL en ambas: borrar el archivo o la cotización no debe bloquear
-- ni borrar en cascada el otro extremo (la baja real cascadea por su propia FK).

ALTER TABLE "tbl_cotizaciones_items" ADD COLUMN "id_archivo" INTEGER;

ALTER TABLE "tbl_servicios_observaciones" ADD COLUMN "id_cotizacion" INTEGER;

CREATE INDEX "tbl_servicios_observaciones_id_cotizacion_idx" ON "tbl_servicios_observaciones"("id_cotizacion");

ALTER TABLE "tbl_cotizaciones_items"
  ADD CONSTRAINT "tbl_cotizaciones_items_id_archivo_fkey"
  FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_servicios_observaciones"
  ADD CONSTRAINT "tbl_servicios_observaciones_id_cotizacion_fkey"
  FOREIGN KEY ("id_cotizacion") REFERENCES "tbl_cotizaciones"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

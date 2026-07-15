-- Checklist de finalización progresivo con foto por ítem y geolocalización.
--
-- El checklist de finalización pasa a llenarse durante "En curso" (no al final).
-- Cada ítem marcado "Sí" lleva ≥1 foto, que se guarda como una fila de
-- tbl_servicios_evidencias con id_respuesta (la liga al ítem) y, opcionalmente,
-- latitud/longitud capturadas por el navegador para verificar la ubicación.
--
-- - id_respuesta NULL  → evidencia "general" del servicio (comportamiento previo).
-- - id_respuesta NOT NULL → foto de un ítem del checklist de finalización.
--
-- onDelete SET NULL: si se elimina una respuesta, su foto no se borra ni bloquea;
-- queda como evidencia general (la baja real de servicios cascadea por id_servicio).

ALTER TABLE "tbl_servicios_evidencias" ADD COLUMN "id_respuesta" INTEGER;
ALTER TABLE "tbl_servicios_evidencias" ADD COLUMN "latitud" DECIMAL(10,7);
ALTER TABLE "tbl_servicios_evidencias" ADD COLUMN "longitud" DECIMAL(10,7);

CREATE INDEX "tbl_servicios_evidencias_id_respuesta_idx" ON "tbl_servicios_evidencias"("id_respuesta");

ALTER TABLE "tbl_servicios_evidencias"
  ADD CONSTRAINT "tbl_servicios_evidencias_id_respuesta_fkey"
  FOREIGN KEY ("id_respuesta") REFERENCES "tbl_servicios_finalizacion_respuestas"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

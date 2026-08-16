-- Documentos libres del lead (PDF, imágenes, videos, Office…) que la Central de
-- ventas carga durante la etapa comercial para que la Vendedora asignada los
-- consulte. Al convertir el lead en cliente/servicio los documentos NO se copian
-- ni se mueven: se quedan en el lead.
CREATE TABLE "tbl_leads_archivos" (
  "id"                     SERIAL       NOT NULL,
  "id_lead"                INTEGER      NOT NULL,
  "id_archivo"             INTEGER      NOT NULL,
  "descripcion"            VARCHAR(200),
  "orden"                  INTEGER      NOT NULL DEFAULT 0,
  "estado"                 INTEGER      NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_leads_archivos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_leads_archivos_id_lead_idx"
  ON "tbl_leads_archivos"("id_lead");

ALTER TABLE "tbl_leads_archivos"
  ADD CONSTRAINT "tbl_leads_archivos_id_lead_fkey"
  FOREIGN KEY ("id_lead") REFERENCES "tbl_leads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_leads_archivos"
  ADD CONSTRAINT "tbl_leads_archivos_id_archivo_fkey"
  FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_leads_archivos"
  ADD CONSTRAINT "tbl_leads_archivos_user_id_registration_fkey"
  FOREIGN KEY ("user_id_registration") REFERENCES "tbl_usuarios"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

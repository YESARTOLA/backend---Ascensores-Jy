-- =====================================================================
-- DOCUMENTOS DE UNA ENTREGA
-- =====================================================================
-- Una entrega llevaba un único archivo (tbl_entregas.id_archivo), así que
-- entregar un expediente de muchos documentos (actas, planos, manuales,
-- certificados…) obligaba a subirlos de uno en uno. Esta tabla le da a cada
-- entrega tantos documentos como haga falta, cargados en lote.
--
-- tbl_entregas.id_archivo se conserva: es el archivo de las entregas
-- registradas antes de este cambio y se muestra junto a sus documentos. Tabla
-- nueva, sin backfill: las entregas existentes no cambian.
CREATE TABLE "tbl_entregas_archivos" (
  "id"                     SERIAL       NOT NULL,
  "id_entrega"             INTEGER      NOT NULL,
  "id_archivo"             INTEGER      NOT NULL,
  "descripcion"            VARCHAR(200),
  "orden"                  INTEGER      NOT NULL DEFAULT 0,
  "estado"                 INTEGER      NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_entregas_archivos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_entregas_archivos_id_entrega_idx"
  ON "tbl_entregas_archivos"("id_entrega");

ALTER TABLE "tbl_entregas_archivos"
  ADD CONSTRAINT "tbl_entregas_archivos_id_entrega_fkey"
  FOREIGN KEY ("id_entrega") REFERENCES "tbl_entregas"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_entregas_archivos"
  ADD CONSTRAINT "tbl_entregas_archivos_id_archivo_fkey"
  FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

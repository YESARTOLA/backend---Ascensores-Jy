-- Adjuntos de contexto de una emergencia (fotos / videos de la falla) cargados
-- por quien la reporta, para que el técnico asignado los revise antes de salir
-- a campo. Complementa —no reemplaza— a tbl_servicios_evidencias, que es la
-- evidencia probatoria que sube el técnico después de intervenir.
CREATE TABLE "tbl_emergencias_archivos" (
  "id"                     SERIAL       NOT NULL,
  "id_emergencia"          INTEGER      NOT NULL,
  "id_archivo"             INTEGER      NOT NULL,
  "descripcion"            VARCHAR(200),
  "orden"                  INTEGER      NOT NULL DEFAULT 0,
  "estado"                 INTEGER      NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_emergencias_archivos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_emergencias_archivos_id_emergencia_idx"
  ON "tbl_emergencias_archivos"("id_emergencia");

ALTER TABLE "tbl_emergencias_archivos"
  ADD CONSTRAINT "tbl_emergencias_archivos_id_emergencia_fkey"
  FOREIGN KEY ("id_emergencia") REFERENCES "tbl_emergencias"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_emergencias_archivos"
  ADD CONSTRAINT "tbl_emergencias_archivos_id_archivo_fkey"
  FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

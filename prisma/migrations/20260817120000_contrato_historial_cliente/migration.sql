-- Historial de contratos reemplazados del cliente, por área.
-- Al registrar un contrato nuevo, las fechas vigentes del área se archivan aquí y
-- tbl_clientes queda con las nuevas (siempre el contrato VIGENTE).
-- No se guarda el documento: el PDF es uno solo por área y el nuevo reemplaza al
-- anterior; aquí solo queda el rastro de las fechas de vigencia.

CREATE TABLE "tbl_clientes_contratos_historial" (
  "id"                     SERIAL PRIMARY KEY,
  "id_cliente"             INTEGER NOT NULL,
  "area"                   VARCHAR(20) NOT NULL,
  "fecha_inicio"           DATE NOT NULL,
  "fecha_fin"              DATE NOT NULL,
  "fecha_reemplazo"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observaciones"          TEXT,
  "estado"                 INTEGER NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6)
);

CREATE INDEX "tbl_clientes_contratos_historial_id_cliente_area_idx"
  ON "tbl_clientes_contratos_historial" ("id_cliente", "area");

ALTER TABLE "tbl_clientes_contratos_historial"
  ADD CONSTRAINT "tbl_clientes_contratos_historial_id_cliente_fkey"
  FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

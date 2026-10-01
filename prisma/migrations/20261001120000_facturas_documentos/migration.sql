-- DOCUMENTOS DE SOPORTE DE UNA FACTURA
-- =====================================================================
-- Una factura venía con un único archivo (tbl_facturas.id_archivo: el PDF del
-- comprobante). Contabilidad necesita guardar junto a ella otros documentos que
-- llegan después o por separado: constancia de detracción, de retención, de
-- pago, el XML/CDR de SUNAT, la guía de remisión…
--
-- tbl_facturas.id_archivo se conserva como el COMPROBANTE en sí; esta tabla
-- guarda los documentos ADICIONALES, cada uno con su tipo (catálogo en
-- utils/documentosFactura.js). Tabla nueva, sin backfill: las facturas
-- existentes simplemente no tienen documentos adicionales.
CREATE TABLE "tbl_facturas_archivos" (
  "id"                     SERIAL       NOT NULL,
  "id_factura"             INTEGER      NOT NULL,
  "id_archivo"             INTEGER      NOT NULL,
  "tipo_documento"         VARCHAR(40)  NOT NULL DEFAULT 'Otro',
  "descripcion"            VARCHAR(200),
  "orden"                  INTEGER      NOT NULL DEFAULT 0,
  "estado"                 INTEGER      NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_facturas_archivos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_facturas_archivos_id_factura_idx"
  ON "tbl_facturas_archivos"("id_factura");

ALTER TABLE "tbl_facturas_archivos"
  ADD CONSTRAINT "tbl_facturas_archivos_id_factura_fkey"
  FOREIGN KEY ("id_factura") REFERENCES "tbl_facturas"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_facturas_archivos"
  ADD CONSTRAINT "tbl_facturas_archivos_id_archivo_fkey"
  FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- DOCUMENTOS DE SOPORTE DE UN ABONO
-- =====================================================================
-- Un abono venía con un único archivo (tbl_pagos.id_archivo_comprobante: el
-- voucher o la captura de la transferencia). Contabilidad necesita guardar
-- junto al cobro los mismos documentos que acompañan a una factura: constancia
-- de detracción, de retención, de pago…
--
-- tbl_pagos.id_archivo_comprobante se conserva como el COMPROBANTE en sí; esta
-- tabla guarda los documentos ADICIONALES, cada uno con su tipo (mismo catálogo
-- que tbl_facturas_archivos, en utils/documentosFactura.js). Tabla nueva, sin
-- backfill: los abonos existentes simplemente no tienen documentos adicionales.
CREATE TABLE "tbl_pagos_archivos" (
  "id"                     SERIAL       NOT NULL,
  "id_pago"                INTEGER      NOT NULL,
  "id_archivo"             INTEGER      NOT NULL,
  "tipo_documento"         VARCHAR(40)  NOT NULL DEFAULT 'Otro',
  "descripcion"            VARCHAR(200),
  "orden"                  INTEGER      NOT NULL DEFAULT 0,
  "estado"                 INTEGER      NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_pagos_archivos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_pagos_archivos_id_pago_idx"
  ON "tbl_pagos_archivos"("id_pago");

ALTER TABLE "tbl_pagos_archivos"
  ADD CONSTRAINT "tbl_pagos_archivos_id_pago_fkey"
  FOREIGN KEY ("id_pago") REFERENCES "tbl_pagos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_pagos_archivos"
  ADD CONSTRAINT "tbl_pagos_archivos_id_archivo_fkey"
  FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

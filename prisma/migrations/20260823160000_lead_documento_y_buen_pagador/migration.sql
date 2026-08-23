-- LEADS: persona natural (DNI) y referencia comercial de pago
-- =====================================================================
-- 1) tipo_documento: el prospecto podía registrarse únicamente con RUC. Ahora
--    también puede ser PERSONA NATURAL y aportar su DNI. El número sigue
--    viviendo en la columna `ruc` (se conserva el nombre para no migrar datos
--    ni romper el histórico); esta columna dice cuál de los dos documentos es.
--    Los leads existentes se marcan como 'RUC' solo si ya traían número: los
--    que no tienen documento quedan en NULL para no inventar una clasificación.
--
-- 2) buen_pagador: referencia comercial INFORMATIVA. No condiciona ningún
--    flujo (no bloquea conversión ni cotización), solo se muestra y se filtra.
--    El histórico arranca en 'Sin calificar', que es también el DEFAULT: nadie
--    queda marcado como mal pagador sin que alguien lo haya evaluado.

ALTER TABLE "tbl_leads"
  ADD COLUMN "tipo_documento" VARCHAR(20),
  ADD COLUMN "buen_pagador" VARCHAR(20) NOT NULL DEFAULT 'Sin calificar';

-- Backfill del tipo para los leads que ya tenían número de documento: hasta
-- hoy solo podía ser un RUC.
UPDATE "tbl_leads"
   SET "tipo_documento" = 'RUC'
 WHERE "ruc" IS NOT NULL AND btrim("ruc") <> '';

-- El listado de leads filtra por la referencia de pago.
CREATE INDEX "tbl_leads_buen_pagador_idx" ON "tbl_leads"("buen_pagador");

-- La detección de duplicados busca por documento y por teléfono en cada alta.
CREATE INDEX "tbl_leads_ruc_idx" ON "tbl_leads"("ruc");
CREATE INDEX "tbl_leads_telefono_idx" ON "tbl_leads"("telefono");

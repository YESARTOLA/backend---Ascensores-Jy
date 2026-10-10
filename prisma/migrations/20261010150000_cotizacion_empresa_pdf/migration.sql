-- EMPRESA DEL PDF VIGENTE
-- =====================================================================
-- Empresa emisora con la que se generó el PDF vigente de cada versión. Si
-- difiere de id_empresa_emisora, la empresa se cambió DESPUÉS de generar el PDF:
-- el PDF quedó desactualizado y el detalle de la cotización pide regenerarlo.
ALTER TABLE "tbl_cotizaciones_versiones" ADD COLUMN "id_empresa_pdf" INTEGER;

ALTER TABLE "tbl_cotizaciones_versiones"
  ADD CONSTRAINT "tbl_cotizaciones_versiones_id_empresa_pdf_fkey"
  FOREIGN KEY ("id_empresa_pdf") REFERENCES "tbl_empresas_emisoras"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- PDF ya generados:
--   - anteriores al alta de la primera empresa (la sembró la migración
--     20261010120000_empresas_emisoras) solo pudieron salir con esa empresa;
--   - posteriores: se asume la empresa vigente de la versión.
UPDATE "tbl_cotizaciones_versiones" v
SET "id_empresa_pdf" = CASE
    WHEN a."date_time_registration" < p."date_time_registration" THEN p."id"
    ELSE v."id_empresa_emisora"
  END
FROM "tbl_archivos" a,
     (SELECT "id", "date_time_registration" FROM "tbl_empresas_emisoras" ORDER BY "id" LIMIT 1) p
WHERE a."id" = v."id_archivo_pdf";

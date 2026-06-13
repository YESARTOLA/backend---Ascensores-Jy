-- Trazabilidad de la revisión administrativa en servicios realizados.
ALTER TABLE "tbl_servicios_realizados" ADD COLUMN "revisado_por" INTEGER;
ALTER TABLE "tbl_servicios_realizados" ADD COLUMN "fecha_revision" TIMESTAMPTZ(6);
ALTER TABLE "tbl_servicios_realizados" ADD COLUMN "resultado_revision" VARCHAR(20);
ALTER TABLE "tbl_servicios_realizados" ADD COLUMN "observacion_revision" TEXT;

-- Limpieza: estado_contable quedó obsoleto (nunca se leía; reemplazado por
-- estado_administrativo + estado_cobro + estado_facturacion).
ALTER TABLE "tbl_servicios_realizados" DROP COLUMN IF EXISTS "estado_contable";

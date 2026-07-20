-- Contrato de servicio POR ÁREA (Servicios / Proyectos): cada área tiene sus
-- fechas de vigencia y su propio documento de contrato. Los datos previos (área
-- única) se conservan renombrando sus columnas al área de Servicios; se agregan
-- las columnas del área de Proyectos.

-- 1) Renombrar las columnas existentes → área de Servicios (preserva los datos).
ALTER TABLE "tbl_clientes" RENAME COLUMN "contrato_inicio" TO "contrato_servicio_inicio";
ALTER TABLE "tbl_clientes" RENAME COLUMN "contrato_fin" TO "contrato_servicio_fin";
ALTER TABLE "tbl_clientes" RENAME COLUMN "id_archivo_contrato" TO "id_archivo_contrato_servicio";
ALTER TABLE "tbl_clientes" RENAME CONSTRAINT "tbl_clientes_id_archivo_contrato_fkey" TO "tbl_clientes_id_archivo_contrato_servicio_fkey";

-- 2) Columnas del área de Proyectos.
ALTER TABLE "tbl_clientes" ADD COLUMN "contrato_proyecto_inicio" DATE;
ALTER TABLE "tbl_clientes" ADD COLUMN "contrato_proyecto_fin" DATE;
ALTER TABLE "tbl_clientes" ADD COLUMN "id_archivo_contrato_proyecto" INTEGER;

-- 3) FK del documento de contrato del área de Proyectos.
ALTER TABLE "tbl_clientes"
  ADD CONSTRAINT "tbl_clientes_id_archivo_contrato_proyecto_fkey"
  FOREIGN KEY ("id_archivo_contrato_proyecto") REFERENCES "tbl_archivos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

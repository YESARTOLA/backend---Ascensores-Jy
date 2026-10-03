-- TÉCNICO DEL PLAN DE MANTENIMIENTO
-- =====================================================================
-- El plan lleva un técnico que se asigna a todos sus servicios: a los que se
-- crean al materializar cada visita y a los ya creados que aún no empezaron.
-- Cada servicio conserva su propia asignación (tbl_servicios_asignaciones) y se
-- puede cambiar a mano desde el servicio. Opcional: los planes existentes
-- quedan sin técnico hasta que se edite el plan.
ALTER TABLE "tbl_mantenimientos_planes" ADD COLUMN "id_tecnico" INTEGER;

ALTER TABLE "tbl_mantenimientos_planes"
  ADD CONSTRAINT "tbl_mantenimientos_planes_id_tecnico_fkey"
  FOREIGN KEY ("id_tecnico") REFERENCES "tbl_tecnicos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

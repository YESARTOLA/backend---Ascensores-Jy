-- Cobro/factura a nivel de plan de mantenimiento.
-- Antes: 1 cobro = 1 servicio (id_servicio UNIQUE NOT NULL). Ahora un cobro/factura
-- puede pertenecer a un PLAN (un único cobro por el total del plan) en vez de a un
-- servicio: id_servicio pasa a opcional y se agrega id_mantenimiento_plan.

-- 1. Cobros
ALTER TABLE "tbl_cobros" ALTER COLUMN "id_servicio" DROP NOT NULL;
ALTER TABLE "tbl_cobros" ADD COLUMN "id_mantenimiento_plan" INTEGER;
CREATE UNIQUE INDEX "tbl_cobros_id_mantenimiento_plan_key" ON "tbl_cobros"("id_mantenimiento_plan");
ALTER TABLE "tbl_cobros"
    ADD CONSTRAINT "tbl_cobros_id_mantenimiento_plan_fkey"
    FOREIGN KEY ("id_mantenimiento_plan") REFERENCES "tbl_mantenimientos_planes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Facturas
ALTER TABLE "tbl_facturas" ALTER COLUMN "id_servicio" DROP NOT NULL;
ALTER TABLE "tbl_facturas" ADD COLUMN "id_mantenimiento_plan" INTEGER;
CREATE INDEX "tbl_facturas_id_mantenimiento_plan_idx" ON "tbl_facturas"("id_mantenimiento_plan");
ALTER TABLE "tbl_facturas"
    ADD CONSTRAINT "tbl_facturas_id_mantenimiento_plan_fkey"
    FOREIGN KEY ("id_mantenimiento_plan") REFERENCES "tbl_mantenimientos_planes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- La relación factura→servicio pasa de obligatoria (NO ACTION) a opcional (SET NULL)
-- para coincidir con el schema (id_servicio ahora nullable).
ALTER TABLE "tbl_facturas" DROP CONSTRAINT IF EXISTS "tbl_facturas_id_servicio_fkey";
ALTER TABLE "tbl_facturas"
    ADD CONSTRAINT "tbl_facturas_id_servicio_fkey"
    FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

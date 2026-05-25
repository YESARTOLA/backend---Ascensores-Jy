-- Lead: vendedor (FK a usuarios) y nuevo default de estado.
-- 1) Columna id_vendedor + FK opcional a tbl_usuarios.
ALTER TABLE "tbl_leads" ADD COLUMN "id_vendedor" INTEGER;

ALTER TABLE "tbl_leads"
  ADD CONSTRAINT "tbl_leads_id_vendedor_fkey"
  FOREIGN KEY ("id_vendedor") REFERENCES "tbl_usuarios"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Nuevo estado por defecto del lead.
ALTER TABLE "tbl_leads" ALTER COLUMN "estado_lead" SET DEFAULT 'Consulta';

-- 3) Reencauzar estados legacy al nuevo catálogo (Consulta/Pendiente/Cotizado/Ingresado).
UPDATE "tbl_leads" SET "estado_lead" = 'Consulta'  WHERE "estado_lead" = 'nuevo';
UPDATE "tbl_leads" SET "estado_lead" = 'Ingresado' WHERE "estado_lead" IN ('convertido', 'ganado');
UPDATE "tbl_leads" SET "estado_lead" = 'Pendiente' WHERE "estado_lead" = 'perdido';

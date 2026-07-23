-- Cotización de COBRO sobre un servicio EXISTENTE (sin crear servicio nuevo).
--
-- Caso de uso: una emergencia ya atendida (su servicio ya se ejecutó y finalizó)
-- que debe generar un cobro después del hecho. Se crea una cotización jalando los
-- datos de la emergencia; al APROBARLA NO se crea un servicio/proyecto nuevo ni se
-- replica en el módulo: solo se genera el cobro sobre el servicio existente.
--
-- `id_servicio_cobro` apunta a ese servicio. NULL = flujo de cotización normal.
-- FK con ON DELETE SET NULL: borrar el servicio no debe borrar la cotización.
-- Idempotente para no chocar en bases donde ya se aplicó parcialmente.

ALTER TABLE "tbl_cotizaciones" ADD COLUMN IF NOT EXISTS "id_servicio_cobro" INTEGER;

CREATE INDEX IF NOT EXISTS "tbl_cotizaciones_id_servicio_cobro_idx"
  ON "tbl_cotizaciones"("id_servicio_cobro");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_cotizaciones_id_servicio_cobro_fkey'
  ) THEN
    ALTER TABLE "tbl_cotizaciones"
      ADD CONSTRAINT "tbl_cotizaciones_id_servicio_cobro_fkey"
      FOREIGN KEY ("id_servicio_cobro") REFERENCES "tbl_servicios_proyectos"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

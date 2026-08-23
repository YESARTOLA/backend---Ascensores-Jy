-- ===========================================================================
-- RAILWAY · Estados simplificados + OT en el servicio
-- ===========================================================================
-- Copia AUTÓNOMA e IDEMPOTENTE de la migración
--   prisma/migrations/20260823190000_estados_simplificados_y_ot_en_servicio
--
-- NO hace falta ejecutarlo a mano si el despliegue corre `prisma migrate deploy`
-- (el `npm start` del backend ya lo hace): ahí la migración se aplica sola. Este
-- archivo existe para poder aplicarlo manualmente sobre Railway y para poder
-- releerlo sin abrir la carpeta de migraciones.
--
-- Es idempotente: se puede ejecutar dos veces sin romper nada. Si lo aplicas a
-- mano, márcalo después como aplicado para que Prisma no lo repita:
--   INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
--   VALUES (gen_random_uuid()::text, '', '20260823190000_estados_simplificados_y_ot_en_servicio', now(), now(), 1);
--
-- ANTES DE EJECUTAR: respaldo. Este script BORRA dos tablas y una columna.
--   pg_dump "$DATABASE_URL" -t tbl_checklists_salida -t tbl_checklists_salida_items > respaldo_checklist.sql
--
-- Qué toca (cifras de la base local al 2026-08-23, Railway tendrá las suyas):
--   · 532 filas en tbl_checklists_salida      → SE BORRAN
--   · 462 filas en tbl_checklists_salida_items → SE BORRAN
--   · 725 asignaciones con responsable_checklist → columna eliminada
--   · 162 servicios cambian de estado (Checklist/Listo para salida → Asignado)
--   · 194 OT se copian de tbl_servicios_realizados al servicio
-- ===========================================================================

BEGIN;

-- Estados operativos simplificados + Orden de Trabajo en el servicio.
--
-- 1) La OT deja de vivir en `tbl_servicios_realizados` (que solo existe DESPUÉS
--    de cerrar) y pasa al servicio, donde el técnico la sube durante la
--    ejecución junto a la guía de salida. Una sola fuente para cierre,
--    Contabilidad, Gestión de cobros y reportes.
--
-- 2) El CHECKLIST DE SALIDA se elimina por completo: tablas, la columna
--    `responsable_checklist` de las asignaciones y los dos estados de servicio
--    que solo existían para él.
--
-- 3) Los estados operativos quedan en cuatro:
--       Pendiente → Asignado → En curso → Finalizado
--    "Checklist de salida pendiente" y "Listo para salida" no tenían sentido sin
--    el checklist; "En camino" se funde en "En curso" (el estado lo enciende
--    ahora el primer registro del técnico, no un botón); y las dos
--    finalizaciones se unifican — un cierre sin guía se reconoce por el estado
--    de la GUÍA ("Observada"), no por un estado de servicio aparte.
--
-- El historial de estados se migra con la misma equivalencia: si no, quedarían
-- registros apuntando a estados que ya no existen y la fecha de cierre (que se
-- deriva buscando "Finalizado" en el historial) se perdería en los servicios ya
-- cerrados.

-- ---------------------------------------------------------------------------
-- 1. OT en el servicio
-- ---------------------------------------------------------------------------
ALTER TABLE "tbl_servicios_proyectos"
  ADD COLUMN IF NOT EXISTS "numero_ot"     VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "id_archivo_ot" INTEGER,
  ADD COLUMN IF NOT EXISTS "ot_subida_por" INTEGER,
  ADD COLUMN IF NOT EXISTS "ot_subida_en"  TIMESTAMPTZ(6);

-- Traer las OT ya cargadas. `date_time_registration` del realizado es el momento
-- del cierre, que es cuando se subía la OT con el formulario anterior.
-- Solo si las columnas de origen siguen existiendo (primera ejecución).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'tbl_servicios_realizados' AND column_name = 'numero_ot') THEN
    EXECUTE $sql$
UPDATE "tbl_servicios_proyectos" sp
SET "numero_ot"     = sr."numero_ot",
    "id_archivo_ot" = sr."id_archivo_ot",
    "ot_subida_por" = sr."user_id_registration",
    "ot_subida_en"  = sr."date_time_registration"
FROM "tbl_servicios_realizados" sr
WHERE sr."id_servicio" = sp."id"
  AND (sr."numero_ot" IS NOT NULL OR sr."id_archivo_ot" IS NOT NULL)
    $sql$;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE "tbl_servicios_proyectos"
    ADD CONSTRAINT "tbl_servicios_proyectos_id_archivo_ot_fkey"
    FOREIGN KEY ("id_archivo_ot") REFERENCES "tbl_archivos"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ya migrada: fuera la copia.
ALTER TABLE "tbl_servicios_realizados"
  DROP CONSTRAINT IF EXISTS "tbl_servicios_realizados_id_archivo_ot_fkey";
ALTER TABLE "tbl_servicios_realizados"
  DROP COLUMN IF EXISTS "numero_ot",
  DROP COLUMN IF EXISTS "id_archivo_ot";

-- ---------------------------------------------------------------------------
-- 2. Estados operativos: de nueve a cuatro
-- ---------------------------------------------------------------------------
-- Sin checklist, un servicio con técnico y fecha está simplemente "Asignado".
UPDATE "tbl_servicios_proyectos"
SET "estado_servicio" = 'Asignado'
WHERE "estado_servicio" IN ('Checklist de salida pendiente', 'Listo para salida');

-- "En camino" era un tramo previo al trabajo; ahora la ejecución es una sola.
UPDATE "tbl_servicios_proyectos"
SET "estado_servicio" = 'En curso'
WHERE "estado_servicio" = 'En camino';

-- Una única finalización.
UPDATE "tbl_servicios_proyectos"
SET "estado_servicio" = 'Finalizado'
WHERE "estado_servicio" IN ('Finalizado por técnico', 'Finalizado observado');

-- Mismo mapeo en el historial, en las dos columnas.
UPDATE "tbl_servicios_estados_historial"
SET "estado_nuevo" = CASE
      WHEN "estado_nuevo" IN ('Checklist de salida pendiente', 'Listo para salida') THEN 'Asignado'
      WHEN "estado_nuevo" = 'En camino' THEN 'En curso'
      WHEN "estado_nuevo" IN ('Finalizado por técnico', 'Finalizado observado') THEN 'Finalizado'
      ELSE "estado_nuevo" END
WHERE "estado_nuevo" IN ('Checklist de salida pendiente', 'Listo para salida', 'En camino',
                         'Finalizado por técnico', 'Finalizado observado');

UPDATE "tbl_servicios_estados_historial"
SET "estado_anterior" = CASE
      WHEN "estado_anterior" IN ('Checklist de salida pendiente', 'Listo para salida') THEN 'Asignado'
      WHEN "estado_anterior" = 'En camino' THEN 'En curso'
      WHEN "estado_anterior" IN ('Finalizado por técnico', 'Finalizado observado') THEN 'Finalizado'
      ELSE "estado_anterior" END
WHERE "estado_anterior" IN ('Checklist de salida pendiente', 'Listo para salida', 'En camino',
                            'Finalizado por técnico', 'Finalizado observado');

-- La renumeración deja pasos consecutivos idénticos (Asignado → Asignado), que
-- no aportan nada al historial y ensucian la línea de tiempo del servicio.
DELETE FROM "tbl_servicios_estados_historial"
WHERE "estado_anterior" = "estado_nuevo";

-- ---------------------------------------------------------------------------
-- 3. Fuera el checklist de salida
-- ---------------------------------------------------------------------------
ALTER TABLE "tbl_servicios_asignaciones" DROP COLUMN IF EXISTS "responsable_checklist";

DROP TABLE IF EXISTS "tbl_checklists_salida_items";
DROP TABLE IF EXISTS "tbl_checklists_salida";

COMMIT;

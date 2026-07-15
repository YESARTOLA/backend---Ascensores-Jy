-- Servicios/Proyectos multidía: un trabajo puede durar varios días consecutivos.
-- - duracion_dias en el servicio (1 = un solo día, retrocompatible).
-- - tbl_servicios_dias: una fila por día programado (fuente de verdad de la grilla).
-- - id_dia en evidencias (cada evidencia se liga a su día) y en eventos de
--   calendario (la agenda muestra "Día k/N" y el estado por día).

-- 1. Duración del servicio
ALTER TABLE "tbl_servicios_proyectos" ADD COLUMN "duracion_dias" INTEGER NOT NULL DEFAULT 1;

-- 2. Tabla de días del servicio
CREATE TABLE "tbl_servicios_dias" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "orden" INTEGER NOT NULL,
    "fecha" DATE NOT NULL,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),
    CONSTRAINT "tbl_servicios_dias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_servicios_dias_id_servicio_orden_key" ON "tbl_servicios_dias"("id_servicio", "orden");
CREATE INDEX "tbl_servicios_dias_id_servicio_idx" ON "tbl_servicios_dias"("id_servicio");
CREATE INDEX "tbl_servicios_dias_fecha_idx" ON "tbl_servicios_dias"("fecha");

ALTER TABLE "tbl_servicios_dias"
    ADD CONSTRAINT "tbl_servicios_dias_id_servicio_fkey"
    FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Enlace de evidencias y eventos de calendario al día
ALTER TABLE "tbl_servicios_evidencias" ADD COLUMN "id_dia" INTEGER;
ALTER TABLE "tbl_calendario_eventos" ADD COLUMN "id_dia" INTEGER;

CREATE INDEX "tbl_servicios_evidencias_id_dia_idx" ON "tbl_servicios_evidencias"("id_dia");
CREATE INDEX "tbl_calendario_eventos_id_dia_idx" ON "tbl_calendario_eventos"("id_dia");

ALTER TABLE "tbl_servicios_evidencias"
    ADD CONSTRAINT "tbl_servicios_evidencias_id_dia_fkey"
    FOREIGN KEY ("id_dia") REFERENCES "tbl_servicios_dias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_calendario_eventos"
    ADD CONSTRAINT "tbl_calendario_eventos_id_dia_fkey"
    FOREIGN KEY ("id_dia") REFERENCES "tbl_servicios_dias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Backfill: cada servicio vivo (en gestión, no borrador) con fecha_programada
--    obtiene su Día 1. Todos arrancan con duracion_dias = 1, así que un solo día
--    reproduce el comportamiento actual. El evento de calendario existente del
--    servicio se enlaza a ese Día 1.
INSERT INTO "tbl_servicios_dias" ("id_servicio", "orden", "fecha", "estado", "user_id_registration")
SELECT s."id", 1, s."fecha_programada", 1, s."user_id_registration"
FROM "tbl_servicios_proyectos" s
WHERE s."estado" = 1
  AND s."fecha_programada" IS NOT NULL
  AND s."estado_servicio" IN (
    'Pendiente', 'Asignado', 'Checklist de salida pendiente',
    'Listo para salida', 'En camino', 'En curso'
  );

UPDATE "tbl_calendario_eventos" e
SET "id_dia" = d."id"
FROM "tbl_servicios_dias" d
WHERE e."id_servicio" = d."id_servicio"
  AND d."orden" = 1
  AND e."id_dia" IS NULL
  AND e."estado" = 1;

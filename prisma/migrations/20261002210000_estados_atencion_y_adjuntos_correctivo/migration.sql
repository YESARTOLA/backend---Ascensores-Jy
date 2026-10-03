-- Emergencias y correctivos pasan a tener solo tres estados, derivados del
-- servicio que los atiende (utils/estadoAtencion.js):
--
--   En atención — antes "Reportada"/"Reportado" y "En atención".
--   Atendida    — antes "Atendida", "Cerrada", "Resuelto" y "Cerrado"
--                 (en el correctivo, "Atendido").
--   Cancelada   — servicio cancelado (en el correctivo, "Cancelado").
--
-- El correctivo, además, deja de moverse a mano: se quedaba congelado en
-- "Reportado" aunque el técnico ya hubiera terminado. Este UPDATE es el backfill
-- de una sola vez; de aquí en adelante lo mantiene sincronizarEstadoAtencion
-- (utils/estadoServicio.js) en cada cambio de estado del servicio. El CASE
-- replica `etapaAtencion` (ESTADOS_FIN de utils/ejecucionFechas.js).
UPDATE "tbl_emergencias" e
SET "estado_emergencia" = CASE
    WHEN s."estado_servicio" = 'Cancelado' THEN 'Cancelada'
    WHEN s."estado_servicio" IN (
      'Finalizado', 'En revisión administrativa', 'A gestión de cobro', 'En cobro',
      'Cobrado parcial', 'Cobrado total', 'Facturado', 'Cerrado'
    ) THEN 'Atendida'
    ELSE 'En atención'
  END,
  "date_time_modification" = NOW()
FROM "tbl_servicios_proyectos" s
WHERE e."id_servicio" = s."id";

UPDATE "tbl_correctivos" c
SET "estado_correctivo" = CASE
    WHEN s."estado_servicio" = 'Cancelado' THEN 'Cancelado'
    WHEN s."estado_servicio" IN (
      'Finalizado', 'En revisión administrativa', 'A gestión de cobro', 'En cobro',
      'Cobrado parcial', 'Cobrado total', 'Facturado', 'Cerrado'
    ) THEN 'Atendido'
    ELSE 'En atención'
  END,
  "date_time_modification" = NOW()
FROM "tbl_servicios_proyectos" s
WHERE c."id_servicio" = s."id";

-- Sin servicio vinculado no hay nada terminado: siguen en atención.
UPDATE "tbl_emergencias" SET "estado_emergencia" = 'En atención', "date_time_modification" = NOW()
WHERE "id_servicio" IS NULL AND "estado_emergencia" <> 'En atención';
UPDATE "tbl_correctivos" SET "estado_correctivo" = 'En atención', "date_time_modification" = NOW()
WHERE "id_servicio" IS NULL AND "estado_correctivo" <> 'En atención';

ALTER TABLE "tbl_emergencias" ALTER COLUMN "estado_emergencia" SET DEFAULT 'En atención';
ALTER TABLE "tbl_correctivos" ALTER COLUMN "estado_correctivo" SET DEFAULT 'En atención';

-- Adjuntos de contexto del correctivo (fotos / videos / PDFs de la falla), igual
-- que tbl_emergencias_archivos: los carga quien lo reporta para que el técnico
-- asignado los revise antes de salir a campo.
CREATE TABLE "tbl_correctivos_archivos" (
  "id"                     SERIAL       NOT NULL,
  "id_correctivo"          INTEGER      NOT NULL,
  "id_archivo"             INTEGER      NOT NULL,
  "descripcion"            VARCHAR(200),
  "orden"                  INTEGER      NOT NULL DEFAULT 0,
  "estado"                 INTEGER      NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_correctivos_archivos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_correctivos_archivos_id_correctivo_idx"
  ON "tbl_correctivos_archivos"("id_correctivo");

ALTER TABLE "tbl_correctivos_archivos"
  ADD CONSTRAINT "tbl_correctivos_archivos_id_correctivo_fkey"
  FOREIGN KEY ("id_correctivo") REFERENCES "tbl_correctivos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_correctivos_archivos"
  ADD CONSTRAINT "tbl_correctivos_archivos_id_archivo_fkey"
  FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

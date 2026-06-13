-- Plan de mantenimiento con varios ascensores.
-- Antes: tbl_mantenimientos_planes.id_ascensor (1 plan = 1 ascensor).
-- Ahora: junction tbl_mantenimientos_planes_ascensores (1 plan = N ascensores),
-- cada uno con su monto (el precio del catálogo del cliente repartido).

-- 1. Junction plan ↔ ascensores
CREATE TABLE "tbl_mantenimientos_planes_ascensores" (
    "id" SERIAL NOT NULL,
    "id_plan" INTEGER NOT NULL,
    "id_ascensor" INTEGER NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "moneda" VARCHAR(10) NOT NULL DEFAULT 'PEN',
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),
    CONSTRAINT "tbl_mantenimientos_planes_ascensores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_mantenimientos_planes_ascensores_id_plan_id_ascensor_key"
    ON "tbl_mantenimientos_planes_ascensores"("id_plan", "id_ascensor");

ALTER TABLE "tbl_mantenimientos_planes_ascensores"
    ADD CONSTRAINT "tbl_mantenimientos_planes_ascensores_id_plan_fkey"
    FOREIGN KEY ("id_plan") REFERENCES "tbl_mantenimientos_planes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_mantenimientos_planes_ascensores"
    ADD CONSTRAINT "tbl_mantenimientos_planes_ascensores_id_ascensor_fkey"
    FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Backfill: cada plan existente conserva su único ascensor. El monto se toma
--    de la junction del servicio generado más reciente para ese ascensor (lo que
--    realmente se pactó); si el plan aún no generó servicios, cae al precio del
--    catálogo del cliente para ese tipo de servicio; último fallback: 0.
INSERT INTO "tbl_mantenimientos_planes_ascensores"
    ("id_plan", "id_ascensor", "monto", "moneda", "estado", "user_id_registration")
SELECT
    p."id",
    p."id_ascensor",
    COALESCE(sa."monto", cp."precio", 0),
    COALESCE(sa."moneda", cp."moneda", 'PEN'),
    1,
    p."user_id_registration"
FROM "tbl_mantenimientos_planes" p
LEFT JOIN LATERAL (
    SELECT sa2."monto", sa2."moneda"
    FROM "tbl_servicios_ascensores" sa2
    JOIN "tbl_servicios_proyectos" s2 ON s2."id" = sa2."id_servicio"
    WHERE s2."id_mantenimiento_plan" = p."id"
      AND sa2."id_ascensor" = p."id_ascensor"
      AND sa2."estado" = 1
    ORDER BY s2."id" DESC
    LIMIT 1
) sa ON TRUE
LEFT JOIN "tbl_clientes_precios" cp
    ON cp."id_cliente" = p."id_cliente" AND cp."id_tipo_servicio" = p."id_tipo_servicio";

-- 3. Eliminar la columna obsoleta (la junction es ahora la única fuente de verdad).
ALTER TABLE "tbl_mantenimientos_planes" DROP CONSTRAINT IF EXISTS "tbl_mantenimientos_planes_id_ascensor_fkey";
ALTER TABLE "tbl_mantenimientos_planes" DROP COLUMN "id_ascensor";

-- Introduce la entidad Edificio entre Cliente y Ascensor.
-- El Cliente pasa a ser entidad comercial; el Edificio toma la ubicación física
-- (tipo Edificio/Obra, nombre, dirección, distrito, coordenadas). Cada cliente
-- existente genera un edificio con sus datos actuales y sus ascensores se
-- reparentan a ese edificio. No se pierde información.

-- 1. Tabla de edificios.
CREATE TABLE "tbl_edificios" (
    "id" SERIAL NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "tipo" VARCHAR(20) NOT NULL DEFAULT 'Edificio',
    "nombre" VARCHAR(200) NOT NULL,
    "direccion" TEXT,
    "distrito" VARCHAR(100) NOT NULL,
    "latitud" DECIMAL(10,7),
    "longitud" DECIMAL(10,7),
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),
    CONSTRAINT "tbl_edificios_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "tbl_edificios" ADD CONSTRAINT "tbl_edificios_id_cliente_fkey"
    FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "tbl_edificios_id_cliente_idx" ON "tbl_edificios"("id_cliente");

-- 2. Un edificio por cliente existente, con su ubicación física actual.
INSERT INTO "tbl_edificios"
  ("id_cliente","tipo","nombre","direccion","distrito","latitud","longitud","estado","user_id_registration","date_time_registration")
SELECT
  c."id",
  COALESCE(c."tipo", 'Edificio'),
  COALESCE(NULLIF(c."nombre_edificio", ''), c."nombre"),
  c."direccion",
  c."distrito",
  c."latitud",
  c."longitud",
  1,
  c."user_id_registration",
  COALESCE(c."date_time_registration", now())
FROM "tbl_clientes" c;

-- 3. Reparentar ascensores: cada uno pasa al edificio de su cliente actual.
ALTER TABLE "tbl_ascensores" ADD COLUMN "id_edificio" INTEGER;
UPDATE "tbl_ascensores" a
SET "id_edificio" = e."id"
FROM "tbl_edificios" e
WHERE e."id_cliente" = a."id_cliente";

-- 4. id_edificio obligatorio + FK. Quitar id_cliente (DROP COLUMN elimina su FK).
ALTER TABLE "tbl_ascensores" ALTER COLUMN "id_edificio" SET NOT NULL;
ALTER TABLE "tbl_ascensores" ADD CONSTRAINT "tbl_ascensores_id_edificio_fkey"
    FOREIGN KEY ("id_edificio") REFERENCES "tbl_edificios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "tbl_ascensores_id_edificio_idx" ON "tbl_ascensores"("id_edificio");
ALTER TABLE "tbl_ascensores" DROP COLUMN "id_cliente";

-- 5. El cliente deja de llevar la ubicación física (ahora vive en el edificio).
ALTER TABLE "tbl_clientes" DROP COLUMN "tipo";
ALTER TABLE "tbl_clientes" DROP COLUMN "nombre_edificio";
ALTER TABLE "tbl_clientes" DROP COLUMN "direccion";
ALTER TABLE "tbl_clientes" DROP COLUMN "distrito";
ALTER TABLE "tbl_clientes" DROP COLUMN "latitud";
ALTER TABLE "tbl_clientes" DROP COLUMN "longitud";

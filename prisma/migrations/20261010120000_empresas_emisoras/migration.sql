-- EMPRESAS EMISORAS
-- =====================================================================
-- Hasta ahora los datos de empresa del PDF de cotización (razón social, RUC,
-- dirección, teléfono, correo) eran únicos: claves EMPRESA_* de
-- tbl_configuracion. Pasan a una tabla para registrar varias razones sociales
-- y elegir, al crear la cotización, con cuál se emite.
--
-- Una de ellas es la PREDETERMINADA: viene marcada en el formulario de
-- cotización y la usan los documentos que no eligen empresa (informe de
-- servicio, exportaciones). Lo garantiza la aplicación
-- (controllers/empresasEmisorasController.js), no un índice.
CREATE TABLE "tbl_empresas_emisoras" (
  "id"                     SERIAL       NOT NULL,
  "razon_social"           VARCHAR(200) NOT NULL,
  "ruc"                    VARCHAR(20)  NOT NULL,
  "direccion"              TEXT,
  "telefono"               VARCHAR(50),
  "correo"                 VARCHAR(120),
  "es_predeterminada"      BOOLEAN      NOT NULL DEFAULT false,
  "estado"                 INTEGER      NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_empresas_emisoras_pkey" PRIMARY KEY ("id")
);

-- La primera empresa es la que ya estaba configurada (claves EMPRESA_*), con
-- los mismos valores por defecto de utils/configuracion.js si alguna falta.
INSERT INTO "tbl_empresas_emisoras" ("razon_social", "ruc", "direccion", "telefono", "correo", "es_predeterminada")
SELECT
  LEFT(COALESCE(MAX(CASE WHEN "clave" = 'EMPRESA_RAZON_SOCIAL' THEN NULLIF(TRIM("valor"), '') END), 'Ascensores Jy S.A.C.'), 200),
  LEFT(COALESCE(MAX(CASE WHEN "clave" = 'EMPRESA_RUC' THEN NULLIF(TRIM("valor"), '') END), '20000000000'), 20),
  COALESCE(MAX(CASE WHEN "clave" = 'EMPRESA_DIRECCION' THEN NULLIF(TRIM("valor"), '') END), 'Lima, Perú'),
  LEFT(MAX(CASE WHEN "clave" = 'EMPRESA_TELEFONO' THEN NULLIF(TRIM("valor"), '') END), 50),
  LEFT(MAX(CASE WHEN "clave" = 'EMPRESA_CORREO' THEN NULLIF(TRIM("valor"), '') END), 120),
  true
FROM "tbl_configuracion"
WHERE "estado" = 1;

-- Empresa con la que se emite cada versión de la cotización (su PDF). NULL =
-- se usa la predeterminada.
ALTER TABLE "tbl_cotizaciones_versiones" ADD COLUMN "id_empresa_emisora" INTEGER;

ALTER TABLE "tbl_cotizaciones_versiones"
  ADD CONSTRAINT "tbl_cotizaciones_versiones_id_empresa_emisora_fkey"
  FOREIGN KEY ("id_empresa_emisora") REFERENCES "tbl_empresas_emisoras"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Las versiones existentes se emitieron con la única empresa que había.
UPDATE "tbl_cotizaciones_versiones"
SET "id_empresa_emisora" = (SELECT "id" FROM "tbl_empresas_emisoras" WHERE "es_predeterminada" LIMIT 1);

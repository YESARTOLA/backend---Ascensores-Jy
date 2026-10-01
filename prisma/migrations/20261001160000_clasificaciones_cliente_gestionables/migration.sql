-- CLASIFICACIONES DE CLIENTE GESTIONABLES Y POR ÁREA
-- =====================================================================
-- Hasta ahora la clasificación del cliente (Grande, Pequeño, Marca JY…) era un
-- catálogo cerrado en código (utils/catalogosClientes.js). Pasa a una tabla para
-- que se pueda gestionar desde la aplicación, y cada clasificación indica a qué
-- área aplica: solo Servicios, solo Proyectos, o ambas.
--
-- tbl_clientes.clasificacion y tbl_ascensores.clasificacion siguen guardando el
-- CÓDIGO (máx. 20 caracteres, como esas columnas): las filas sembradas
-- conservan los códigos de siempre, así que ningún cliente ni ascensor pierde
-- su clasificación. El código no cambia al renombrar (solo la etiqueta), por
-- eso no hace falta FK ni backfill.
CREATE TABLE "tbl_clasificaciones_cliente" (
  "id"                     SERIAL       NOT NULL,
  "codigo"                 VARCHAR(20)  NOT NULL,
  "etiqueta"               VARCHAR(80)  NOT NULL,
  -- 'servicio' | 'proyecto' | 'ambos' (mismas claves que el área del cliente).
  "area"                   VARCHAR(20)  NOT NULL DEFAULT 'ambos',
  -- Clave de la paleta (utils/clasificacionesCliente.js), no clases CSS.
  "color"                  VARCHAR(20)  NOT NULL DEFAULT 'gris',
  "orden"                  INTEGER      NOT NULL DEFAULT 0,
  "estado"                 INTEGER      NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_clasificaciones_cliente_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_clasificaciones_cliente_codigo_key"
  ON "tbl_clasificaciones_cliente"("codigo");

-- El catálogo que existía en código. "Proyectos" aplica al área de Proyectos;
-- el resto se venía usando con clientes de Servicios. Se ajusta desde la app.
INSERT INTO "tbl_clasificaciones_cliente" ("codigo", "etiqueta", "area", "color", "orden") VALUES
  ('grande',    'Grande',    'servicio', 'violeta', 1),
  ('pequeno',   'Pequeño',   'servicio', 'celeste', 2),
  ('marca_jy',  'Marca JY',  'servicio', 'naranja', 3),
  ('glarie',    'Glarie',    'servicio', 'verde',   4),
  ('proyectos', 'Proyectos', 'proyecto', 'ambar',   5);

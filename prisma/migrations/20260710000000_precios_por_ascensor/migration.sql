-- Mueve el catálogo de precios de servicio de (cliente) a (ascensor).
-- El mismo servicio puede costar distinto según el ascensor. El ascensor ya
-- conoce su edificio y su cliente, así que no se pierde ninguna relación.
-- Se descarta el catálogo de cliente (decisión: empezar de cero). Los planes y
-- servicios existentes no dependen de esta tabla en runtime: guardan su propio
-- monto por ascensor en la junction / en tbl_servicios_ascensores.

-- CreateTable
CREATE TABLE "tbl_ascensores_precios" (
    "id" SERIAL NOT NULL,
    "id_ascensor" INTEGER NOT NULL,
    "id_tipo_servicio" INTEGER NOT NULL,
    "precio" DECIMAL(12,2) NOT NULL,
    "moneda" VARCHAR(10) NOT NULL DEFAULT 'PEN',
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_ascensores_precios_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tbl_ascensores_precios_id_ascensor_idx" ON "tbl_ascensores_precios"("id_ascensor");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_ascensores_precios_id_ascensor_id_tipo_servicio_key" ON "tbl_ascensores_precios"("id_ascensor", "id_tipo_servicio");

-- AddForeignKey
ALTER TABLE "tbl_ascensores_precios" ADD CONSTRAINT "tbl_ascensores_precios_id_ascensor_fkey" FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ascensores_precios" ADD CONSTRAINT "tbl_ascensores_precios_id_tipo_servicio_fkey" FOREIGN KEY ("id_tipo_servicio") REFERENCES "tbl_tipos_servicio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropTable (catálogo de precios a nivel de cliente, ya reemplazado)
DROP TABLE "tbl_clientes_precios";

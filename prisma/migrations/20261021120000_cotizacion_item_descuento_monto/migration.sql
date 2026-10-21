-- DESCUENTO DE ÍTEM DE COTIZACIÓN: PORCENTAJE O MONTO FIJO
-- =====================================================================
-- Cada ítem elige cómo se descuenta:
--
--   'porcentaje'  (lo de siempre) `descuento_porcentaje` % sobre
--                 cantidad × precio unitario.
--   'monto'       `descuento_monto` en la moneda de la cotización, restado
--                 una vez al importe de la línea (cantidad × precio unitario).
--
-- Solo se guarda el valor del tipo elegido; el otro queda en 0. Regla única en
-- utils/cotizacionCalculos.js (calcularImporteLinea / normalizarDescuentoItem).
--
-- Todos los ítems existentes quedan en 'porcentaje': su importe no cambia.
ALTER TABLE "tbl_cotizaciones_items"
  ADD COLUMN "descuento_tipo" VARCHAR(10) NOT NULL DEFAULT 'porcentaje',
  ADD COLUMN "descuento_monto" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- COMPROBANTES: distinguir FACTURA de BOLETA
-- =====================================================================
-- Hasta ahora todo comprobante emitido se trataba como factura. Se añade el
-- tipo para poder emitir boletas (consumidor final con DNI) y filtrar por él
-- en el módulo de Facturas.
--
-- El histórico se conserva como 'Factura': es lo que se venía emitiendo, y
-- también el DEFAULT de la columna, así que las filas existentes quedan
-- correctamente clasificadas sin necesidad de un backfill aparte.

ALTER TABLE "tbl_facturas"
  ADD COLUMN "tipo_comprobante" VARCHAR(20) NOT NULL DEFAULT 'Factura';

-- El listado filtra por tipo de comprobante; el índice evita el scan completo
-- sobre una tabla que solo crece.
CREATE INDEX "tbl_facturas_tipo_comprobante_idx" ON "tbl_facturas"("tipo_comprobante");

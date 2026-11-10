-- N° de operación de los pagos de una factura (transferencia, depósito…).
-- Una factura puede cobrarse en varios pagos: por eso es una lista.
-- AlterTable
ALTER TABLE "tbl_facturas" ADD COLUMN "numeros_operacion" TEXT[] DEFAULT ARRAY[]::TEXT[];

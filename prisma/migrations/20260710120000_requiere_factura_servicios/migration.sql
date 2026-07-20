-- Bandera persistida "requiere factura" a nivel servicio.
-- 1 = el servicio se facturará; 0 = "Sin factura" (excluido de pendientes por
-- facturar y sin emisión de comprobante). Default por módulo al crear:
-- correctivo → 1, emergencia → 0 (se resuelve en los controladores).
-- Los servicios existentes conservan el default 1 (comportamiento previo).
ALTER TABLE "tbl_servicios_proyectos" ADD COLUMN "requiere_factura" INTEGER NOT NULL DEFAULT 1;

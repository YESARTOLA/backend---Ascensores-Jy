-- Contador de ediciones de datos importantes del lead. Cada guardado del
-- formulario de edición con cambios reales suma 1; el límite se aplica en el
-- backend (super_admin edita sin límite). La trazabilidad de cada edición se
-- registra en tbl_auditoria (entidad 'tbl_leads', acción 'EDICION_DATOS').
ALTER TABLE "tbl_leads" ADD COLUMN "ediciones" INTEGER NOT NULL DEFAULT 0;

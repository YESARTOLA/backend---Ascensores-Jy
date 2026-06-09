-- Estado "Descartado" para leads: se registra el motivo del descarte.
-- El motivo se limpia (NULL) si el lead se reactiva a otro estado.
ALTER TABLE "tbl_leads" ADD COLUMN "motivo_descarte" TEXT;

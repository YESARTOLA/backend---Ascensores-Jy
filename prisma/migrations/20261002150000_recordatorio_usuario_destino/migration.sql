-- RECORDATORIOS PARA UN USUARIO CONCRETO
-- =====================================================================
-- Un recordatorio manual (p.ej. el que se registra desde la vista de un
-- servicio o proyecto) pertenece a un usuario: quien lo registró para sí mismo
-- o la persona para quien lo registró. Solo ese usuario lo ve en su módulo de
-- Recordatorios, su campana y su calendario, sea cual sea su rol.
-- Los automáticos quedan con NULL y se siguen rigiendo por rol.
ALTER TABLE "tbl_recordatorios" ADD COLUMN "id_usuario_destino" INTEGER;

CREATE INDEX "tbl_recordatorios_id_usuario_destino_idx" ON "tbl_recordatorios"("id_usuario_destino");

ALTER TABLE "tbl_recordatorios" ADD CONSTRAINT "tbl_recordatorios_id_usuario_destino_fkey"
  FOREIGN KEY ("id_usuario_destino") REFERENCES "tbl_usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Los manuales existentes eran privados de quien los creó: pasan a ser suyos.
UPDATE "tbl_recordatorios" r SET "id_usuario_destino" = r."user_id_registration"
 WHERE r."tipo" = 'manual'
   AND r."id_usuario_destino" IS NULL
   AND EXISTS (SELECT 1 FROM "tbl_usuarios" u WHERE u."id" = r."user_id_registration");

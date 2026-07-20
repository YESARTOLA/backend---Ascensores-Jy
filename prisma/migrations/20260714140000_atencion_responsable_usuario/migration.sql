-- El responsable de una atención rápida ahora referencia a un USUARIO del sistema
-- (antes era texto libre). Se conserva la columna `responsable` para registros
-- antiguos; los nuevos usan id_responsable_usuario.
ALTER TABLE "tbl_atenciones_rapidas" ADD COLUMN "id_responsable_usuario" INTEGER;

ALTER TABLE "tbl_atenciones_rapidas"
  ADD CONSTRAINT "tbl_atenciones_rapidas_id_responsable_usuario_fkey"
  FOREIGN KEY ("id_responsable_usuario") REFERENCES "tbl_usuarios"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

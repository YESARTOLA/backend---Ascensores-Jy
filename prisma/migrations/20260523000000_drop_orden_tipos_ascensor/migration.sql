-- DropColumn: se elimina la columna "orden" de tbl_tipos_ascensor.
-- El orden de listado pasa a ser alfabético por "nombre" (ver controller).
ALTER TABLE "tbl_tipos_ascensor" DROP COLUMN "orden";

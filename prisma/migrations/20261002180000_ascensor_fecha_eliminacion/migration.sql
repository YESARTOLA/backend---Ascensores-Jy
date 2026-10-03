-- ELIMINACIÓN DE ASCENSORES
-- =====================================================================
-- Un ascensor dado de baja puede estar INACTIVO (dejó de operar: conserva su
-- historial y lo ven todos los roles en "Registro: Inactivos") o ELIMINADO
-- (baja en cascada como la de un edificio: se lleva servicios, emergencias,
-- cobros y facturas, y solo lo ve el Super Admin). Los dos quedan con
-- estado = 0; esta marca es lo que los distingue. NULL = no eliminado.
ALTER TABLE "tbl_ascensores" ADD COLUMN "fecha_eliminacion" TIMESTAMPTZ(6);

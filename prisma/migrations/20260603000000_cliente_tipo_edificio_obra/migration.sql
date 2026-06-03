-- Cliente: tipo Edificio/Obra (informativo).
-- Columna aditiva con DEFAULT, por lo que todos los clientes existentes quedan
-- como 'Edificio' automáticamente y ningún código previo se rompe.
ALTER TABLE "tbl_clientes" ADD COLUMN "tipo" VARCHAR(20) NOT NULL DEFAULT 'Edificio';

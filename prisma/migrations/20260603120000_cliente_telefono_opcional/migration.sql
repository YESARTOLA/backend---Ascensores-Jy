-- Cliente: el teléfono deja de ser obligatorio (se quita del formulario de alta;
-- el nombre del edificio / obra pasa a ser el identificador requerido). Cambio
-- no destructivo: los teléfonos ya cargados se conservan.
ALTER TABLE "tbl_clientes" ALTER COLUMN "telefono" DROP NOT NULL;

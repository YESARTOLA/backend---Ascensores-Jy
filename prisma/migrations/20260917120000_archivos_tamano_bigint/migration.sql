-- Peso de los adjuntos sin tope: un Int corta en 2 147 483 647 bytes (~2 GB) y
-- un video de evidencia puede pasarlo. bigint admite hasta 8 EB.
-- Ampliar el tipo es una conversión implícita: no toca los datos existentes.
ALTER TABLE "tbl_archivos" ALTER COLUMN "tamano_bytes" TYPE BIGINT;

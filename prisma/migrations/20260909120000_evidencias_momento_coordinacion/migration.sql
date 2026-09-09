-- Tercera sección de evidencias: "Coordinación".
--
-- Hasta ahora `momento` solo tomaba 'Antes' / 'Despues' (o NULL), que cabían de
-- sobra en VARCHAR(10). La nueva sección usa el valor 'Coordinacion' (12
-- caracteres), así que la columna se amplía a VARCHAR(20) —queda margen para
-- futuras secciones sin volver a tocar el esquema—.
--
-- Ampliar la longitud de un VARCHAR en PostgreSQL no reescribe la tabla ni
-- bloquea lecturas: es un cambio de catálogo. No afecta a las filas existentes.
ALTER TABLE "tbl_servicios_evidencias" ALTER COLUMN "momento" TYPE VARCHAR(20);

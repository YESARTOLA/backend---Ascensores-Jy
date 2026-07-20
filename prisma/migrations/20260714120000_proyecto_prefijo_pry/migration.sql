-- Los Proyectos ahora usan el prefijo de código PRY- (antes compartían SRV- con
-- los servicios). Reetiqueta los proyectos ya registrados que aún tengan SRV-.
-- Idempotente: al no quedar proyectos con SRV-, una segunda ejecución no afecta nada.
UPDATE "tbl_servicios_proyectos"
SET "codigo" = 'PRY-' || substring("codigo" from 5)
WHERE "tipo_registro" = 'proyecto' AND "codigo" LIKE 'SRV-%';

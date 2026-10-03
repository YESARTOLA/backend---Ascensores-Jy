-- ÁREA EXPLÍCITA DEL CLIENTE
-- =====================================================================
-- Hasta ahora el área de un cliente (Servicios / Proyectos) se deducía de su
-- contrato: por eso el contrato era obligatorio al crearlo. Ahora un cliente se
-- puede registrar sin contrato (ni fechas ni documento), así que el área que se
-- elige al inicio del formulario se guarda en su propia columna.
--
-- Valores: 'servicio' | 'proyecto' (mismas claves que el ámbito del usuario y
-- que tbl_servicios_proyectos.tipo_registro). NULL solo queda en los clientes
-- antiguos con contrato en las dos áreas: al editarlos se elige la suya.
ALTER TABLE "tbl_clientes" ADD COLUMN "area" VARCHAR(20);

-- 1) El área de su contrato, si lo tiene en una sola.
UPDATE "tbl_clientes" SET "area" = 'servicio'
 WHERE "contrato_servicio_inicio" IS NOT NULL AND "contrato_servicio_fin" IS NOT NULL
   AND ("contrato_proyecto_inicio" IS NULL OR "contrato_proyecto_fin" IS NULL);

UPDATE "tbl_clientes" SET "area" = 'proyecto'
 WHERE "contrato_proyecto_inicio" IS NOT NULL AND "contrato_proyecto_fin" IS NOT NULL
   AND ("contrato_servicio_inicio" IS NULL OR "contrato_servicio_fin" IS NULL);

-- 2) Sin contrato en ninguna área: la de su actividad, si es de una sola.
UPDATE "tbl_clientes" c SET "area" = s."tipo_registro"
  FROM (
    SELECT "id_cliente", MIN("tipo_registro") AS "tipo_registro"
      FROM "tbl_servicios_proyectos"
     WHERE "estado" = 1 AND "tipo_registro" IN ('servicio', 'proyecto')
     GROUP BY "id_cliente"
    HAVING COUNT(DISTINCT "tipo_registro") = 1
  ) s
 WHERE c."id" = s."id_cliente"
   AND c."area" IS NULL
   AND (c."contrato_servicio_inicio" IS NULL OR c."contrato_servicio_fin" IS NULL)
   AND (c."contrato_proyecto_inicio" IS NULL OR c."contrato_proyecto_fin" IS NULL);

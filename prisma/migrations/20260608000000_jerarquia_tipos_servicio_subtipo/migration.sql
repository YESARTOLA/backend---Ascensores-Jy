-- Reestructuración Servicios / Proyectos: jerarquía padre → subtipo en
-- tbl_tipos_servicio + subtipo en cotizaciones. Backfill derivado de la
-- categoría existente (seguro en cualquier base; no depende de ids concretos).

-- ---------------------------------------------------------------------------
-- 1) Nuevas columnas (nullable durante el backfill)
-- ---------------------------------------------------------------------------
ALTER TABLE "tbl_tipos_servicio" ADD COLUMN "categoria_funcional" VARCHAR(20);
ALTER TABLE "tbl_tipos_servicio" ADD COLUMN "id_padre" INTEGER;
ALTER TABLE "tbl_cotizaciones" ADD COLUMN "id_subtipo_servicio" INTEGER;

-- ---------------------------------------------------------------------------
-- 2) Filas PADRE (categoría funcional). categoria='' es temporal: la columna
--    categoria se elimina al final de esta migración.
-- ---------------------------------------------------------------------------
INSERT INTO "tbl_tipos_servicio" ("nombre","categoria","categoria_funcional","modulo_asociado","estado","date_time_registration")
SELECT 'Servicios', 'Servicios', 'SERVICIOS', NULL, 1, now()
WHERE NOT EXISTS (SELECT 1 FROM "tbl_tipos_servicio" WHERE "categoria_funcional"='SERVICIOS' AND "id_padre" IS NULL);

INSERT INTO "tbl_tipos_servicio" ("nombre","categoria","categoria_funcional","modulo_asociado","estado","date_time_registration")
SELECT 'Proyectos', 'Proyectos', 'PROYECTOS', NULL, 1, now()
WHERE NOT EXISTS (SELECT 1 FROM "tbl_tipos_servicio" WHERE "categoria_funcional"='PROYECTOS' AND "id_padre" IS NULL);

-- ---------------------------------------------------------------------------
-- 3) Clasificar filas existentes como SUBTIPOS bajo el padre correspondiente.
--    Regla (generaliza el mapeo acordado):
--      * PROYECTOS  si modulo_asociado es null y categoria ∈ {Instalación, Proyecto}
--      * SERVICIOS  en cualquier otro caso, con módulo:
--          - el modulo_asociado existente si ya estaba set
--          - si no: Reparación→correctivo, Revisión/Inspección→mantenimiento,
--            Mantenimiento preventivo→mantenimiento, Mantenimiento correctivo→correctivo,
--            Emergencia→emergencia, resto→correctivo (editable luego en la UI)
--    Los subtipos NO llevan categoria_funcional (se hereda del padre).
-- ---------------------------------------------------------------------------
UPDATE "tbl_tipos_servicio" t SET
  "id_padre" = CASE
      WHEN t."modulo_asociado" IS NULL
           AND lower(translate(t."categoria",'áéíóúÁÉÍÓÚ','aeiouAEIOU')) IN ('instalacion','proyecto')
      THEN (SELECT id FROM "tbl_tipos_servicio" WHERE "categoria_funcional"='PROYECTOS' AND "id_padre" IS NULL LIMIT 1)
      ELSE (SELECT id FROM "tbl_tipos_servicio" WHERE "categoria_funcional"='SERVICIOS' AND "id_padre" IS NULL LIMIT 1)
    END,
  "modulo_asociado" = CASE
      WHEN t."modulo_asociado" IS NULL
           AND lower(translate(t."categoria",'áéíóúÁÉÍÓÚ','aeiouAEIOU')) IN ('instalacion','proyecto')
      THEN NULL
      ELSE COALESCE(t."modulo_asociado",
        CASE lower(translate(t."categoria",'áéíóúÁÉÍÓÚ','aeiouAEIOU'))
          WHEN 'reparacion' THEN 'correctivo'
          WHEN 'revision' THEN 'mantenimiento'
          WHEN 'inspeccion' THEN 'mantenimiento'
          WHEN 'mantenimiento preventivo' THEN 'mantenimiento'
          WHEN 'mantenimiento correctivo' THEN 'correctivo'
          WHEN 'emergencia' THEN 'emergencia'
          ELSE 'correctivo'
        END)
    END
WHERE t."categoria_funcional" IS NULL AND t."id_padre" IS NULL;

-- ---------------------------------------------------------------------------
-- 4) Cotizaciones: el tipo actual pasa a ser el SUBTIPO; el padre va en id_tipo_servicio.
--    (En un único UPDATE las expresiones leen los valores originales de la fila.)
-- ---------------------------------------------------------------------------
UPDATE "tbl_cotizaciones" c SET
  "id_subtipo_servicio" = c."id_tipo_servicio",
  "id_tipo_servicio" = COALESCE(
      (SELECT t."id_padre" FROM "tbl_tipos_servicio" t WHERE t.id = c."id_tipo_servicio"),
      c."id_tipo_servicio")
WHERE c."id_subtipo_servicio" IS NULL;

-- ---------------------------------------------------------------------------
-- 5) Normalizar tipo_registro de cada servicio según la categoría funcional de
--    su subtipo (única fuente de verdad). Corrige registros mal clasificados.
-- ---------------------------------------------------------------------------
UPDATE "tbl_servicios_proyectos" s SET "tipo_registro" =
  CASE WHEN (
      SELECT p."categoria_funcional"
      FROM "tbl_tipos_servicio" sub
      JOIN "tbl_tipos_servicio" p ON p.id = sub."id_padre"
      WHERE sub.id = s."id_tipo_servicio"
    ) = 'PROYECTOS' THEN 'proyecto' ELSE 'servicio' END;

-- ---------------------------------------------------------------------------
-- 5.b) Backfill de metadata Correctivos para servicios reclasificados al módulo
--     Correctivos que aún no tienen su fila 1:1 (p. ej. antiguas "Reparaciones"
--     creadas como servicio directo). El módulo Correctivos lee de tbl_correctivos;
--     sin esta fila el servicio quedaría invisible. La fila es una proyección del
--     subtipo (SSoT), no una segunda fuente de verdad.
-- ---------------------------------------------------------------------------
INSERT INTO "tbl_correctivos" ("id_servicio","id_cliente","id_ascensor","falla","nivel_urgencia","estado_correctivo","observaciones","user_id_registration","date_time_registration")
SELECT s.id, s."id_cliente",
       (SELECT sa."id_ascensor" FROM "tbl_servicios_ascensores" sa WHERE sa."id_servicio" = s.id AND sa.estado = 1 ORDER BY sa.id ASC LIMIT 1),
       COALESCE(NULLIF(s.descripcion, ''), s.titulo, 'Correctivo'),
       'media',
       'Reportado',
       'Backfill reestructuración: servicio reclasificado al módulo Correctivos',
       s."user_id_registration",
       now()
FROM "tbl_servicios_proyectos" s
JOIN "tbl_tipos_servicio" sub ON sub.id = s."id_tipo_servicio"
WHERE s.estado = 1
  AND sub."modulo_asociado" = 'correctivo'
  AND EXISTS (SELECT 1 FROM "tbl_servicios_ascensores" sa WHERE sa."id_servicio" = s.id AND sa.estado = 1)
  AND NOT EXISTS (SELECT 1 FROM "tbl_correctivos" c WHERE c."id_servicio" = s.id);

-- ---------------------------------------------------------------------------
-- 6) Eliminar tipos de servicio sin ningún uso real (subtipos huérfanos:
--    catálogo de prueba). Se preserva todo lo referenciado.
-- ---------------------------------------------------------------------------
DELETE FROM "tbl_tipos_servicio_tecnicos"
WHERE "id_tipo_servicio" IN (
  SELECT t.id FROM "tbl_tipos_servicio" t
  WHERE t."id_padre" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "tbl_servicios_proyectos" x WHERE x."id_tipo_servicio" = t.id)
    AND NOT EXISTS (SELECT 1 FROM "tbl_cotizaciones" x WHERE x."id_subtipo_servicio" = t.id OR x."id_tipo_servicio" = t.id)
    AND NOT EXISTS (SELECT 1 FROM "tbl_mantenimientos_planes" x WHERE x."id_tipo_servicio" = t.id)
    AND NOT EXISTS (SELECT 1 FROM "tbl_clientes_precios" x WHERE x."id_tipo_servicio" = t.id)
    AND NOT EXISTS (SELECT 1 FROM "tbl_leads" x WHERE x."id_tipo_servicio_solicitado" = t.id)
);

DELETE FROM "tbl_tipos_servicio" t
WHERE t."id_padre" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "tbl_servicios_proyectos" x WHERE x."id_tipo_servicio" = t.id)
  AND NOT EXISTS (SELECT 1 FROM "tbl_cotizaciones" x WHERE x."id_subtipo_servicio" = t.id OR x."id_tipo_servicio" = t.id)
  AND NOT EXISTS (SELECT 1 FROM "tbl_mantenimientos_planes" x WHERE x."id_tipo_servicio" = t.id)
  AND NOT EXISTS (SELECT 1 FROM "tbl_clientes_precios" x WHERE x."id_tipo_servicio" = t.id)
  AND NOT EXISTS (SELECT 1 FROM "tbl_leads" x WHERE x."id_tipo_servicio_solicitado" = t.id)
  AND NOT EXISTS (SELECT 1 FROM "tbl_tipos_servicio_tecnicos" x WHERE x."id_tipo_servicio" = t.id);

-- ---------------------------------------------------------------------------
-- 7) Restricciones finales e índices
-- ---------------------------------------------------------------------------
ALTER TABLE "tbl_cotizaciones" ALTER COLUMN "id_subtipo_servicio" SET NOT NULL;

ALTER TABLE "tbl_tipos_servicio"
  ADD CONSTRAINT "tbl_tipos_servicio_id_padre_fkey"
  FOREIGN KEY ("id_padre") REFERENCES "tbl_tipos_servicio"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "tbl_cotizaciones"
  ADD CONSTRAINT "tbl_cotizaciones_id_subtipo_servicio_fkey"
  FOREIGN KEY ("id_subtipo_servicio") REFERENCES "tbl_tipos_servicio"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "tbl_tipos_servicio_id_padre_idx" ON "tbl_tipos_servicio"("id_padre");
CREATE INDEX "tbl_tipos_servicio_categoria_funcional_idx" ON "tbl_tipos_servicio"("categoria_funcional");

-- ---------------------------------------------------------------------------
-- 8) Limpieza: eliminar la columna categoria (reemplazada por categoria_funcional
--    en el padre + modulo_asociado en el subtipo).
-- ---------------------------------------------------------------------------
ALTER TABLE "tbl_tipos_servicio" DROP COLUMN "categoria";

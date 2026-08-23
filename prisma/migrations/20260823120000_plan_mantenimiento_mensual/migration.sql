-- PLANES DE MANTENIMIENTO: MODELO MENSUAL
-- =====================================================================
-- Antes: un plan tenía UNA frecuencia para todos sus ascensores, se dimensionaba
-- en "cantidad de mantenimientos" y la unidad de facturación era la OCURRENCIA
-- (una cuota por cada fecha del cronograma, por la suma de los ascensores).
--
-- Ahora: el plan se dimensiona en MESES, cada ascensor lleva SU PROPIA
-- frecuencia, y la unidad de facturación es el MES DEL PLAN: una sola cuota por
-- mes, por `monto_mensual` fijo, con el detalle de todas las visitas del mes.
--
-- El cronograma pasa a estar materializado en tbl_mantenimientos_programacion
-- (una fila por visita), lo que permite verlo completo y OMITIR fechas sueltas.

-- ---------------------------------------------------------------------
-- 1. Plan: duración en meses, monto mensual y moneda
-- ---------------------------------------------------------------------
ALTER TABLE "tbl_mantenimientos_planes"
  ADD COLUMN "duracion_meses" INTEGER,
  ADD COLUMN "monto_mensual"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "moneda"         VARCHAR(10)   NOT NULL DEFAULT 'PEN';

-- ---------------------------------------------------------------------
-- 2. Junction: frecuencia POR ASCENSOR
-- ---------------------------------------------------------------------
ALTER TABLE "tbl_mantenimientos_planes_ascensores"
  ADD COLUMN "frecuencia"             VARCHAR(30),
  ADD COLUMN "frecuencia_dias_custom" INTEGER;

-- ---------------------------------------------------------------------
-- 3. Cuota ↔ mes del plan
-- ---------------------------------------------------------------------
ALTER TABLE "tbl_cobros_cuotas"
  ADD COLUMN "numero_mes" INTEGER;

-- ---------------------------------------------------------------------
-- 4. Cronograma del plan
-- ---------------------------------------------------------------------
CREATE TABLE "tbl_mantenimientos_programacion" (
  "id"                     SERIAL         NOT NULL,
  "id_plan"                INTEGER        NOT NULL,
  "id_plan_ascensor"       INTEGER        NOT NULL,
  "id_ascensor"            INTEGER        NOT NULL,
  "numero_mes"             INTEGER        NOT NULL,
  "ordinal"                INTEGER        NOT NULL,
  "fecha_programada"       DATE           NOT NULL,
  "activo"                 INTEGER        NOT NULL DEFAULT 1,
  "motivo_omision"         VARCHAR(200),
  "id_servicio"            INTEGER,
  "id_evento"              INTEGER,
  "estado"                 INTEGER        NOT NULL DEFAULT 1,
  "user_id_registration"   INTEGER,
  "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "user_id_modification"   INTEGER,
  "date_time_modification" TIMESTAMPTZ(6),

  CONSTRAINT "tbl_mantenimientos_programacion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_mantenimientos_programacion_id_plan_id_ascensor_ordinal_key"
  ON "tbl_mantenimientos_programacion"("id_plan", "id_ascensor", "ordinal");
CREATE INDEX "tbl_mantenimientos_programacion_id_plan_numero_mes_idx"
  ON "tbl_mantenimientos_programacion"("id_plan", "numero_mes");
CREATE INDEX "tbl_mantenimientos_programacion_id_plan_fecha_programada_idx"
  ON "tbl_mantenimientos_programacion"("id_plan", "fecha_programada");
CREATE INDEX "tbl_mantenimientos_programacion_id_servicio_idx"
  ON "tbl_mantenimientos_programacion"("id_servicio");

ALTER TABLE "tbl_mantenimientos_programacion"
  ADD CONSTRAINT "tbl_mantenimientos_programacion_id_plan_fkey"
  FOREIGN KEY ("id_plan") REFERENCES "tbl_mantenimientos_planes"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_mantenimientos_programacion"
  ADD CONSTRAINT "tbl_mantenimientos_programacion_id_plan_ascensor_fkey"
  FOREIGN KEY ("id_plan_ascensor") REFERENCES "tbl_mantenimientos_planes_ascensores"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_mantenimientos_programacion"
  ADD CONSTRAINT "tbl_mantenimientos_programacion_id_ascensor_fkey"
  FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_mantenimientos_programacion"
  ADD CONSTRAINT "tbl_mantenimientos_programacion_id_servicio_fkey"
  FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_mantenimientos_programacion"
  ADD CONSTRAINT "tbl_mantenimientos_programacion_id_evento_fkey"
  FOREIGN KEY ("id_evento") REFERENCES "tbl_calendario_eventos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 5. BACKFILL de los planes existentes
-- ---------------------------------------------------------------------
-- 5.1 Cada ascensor hereda la frecuencia que hoy tiene el plan.
UPDATE "tbl_mantenimientos_planes_ascensores" pa
   SET "frecuencia"             = p."frecuencia",
       "frecuencia_dias_custom" = p."frecuencia_dias_custom"
  FROM "tbl_mantenimientos_planes" p
 WHERE pa."id_plan" = p."id"
   AND pa."frecuencia" IS NULL;

-- 5.2 Moneda del plan: la de su junction (homogénea por construcción).
UPDATE "tbl_mantenimientos_planes" p
   SET "moneda" = COALESCE(sub."moneda", 'PEN')
  FROM (
    SELECT "id_plan", MIN("moneda") AS "moneda"
      FROM "tbl_mantenimientos_planes_ascensores"
     WHERE "estado" = 1
     GROUP BY "id_plan"
  ) sub
 WHERE p."id" = sub."id_plan";

-- 5.3 Duración en meses, derivada de la frecuencia y del número de ocurrencias
--     pactadas. Se conserva el horizonte temporal del plan original:
--       mensual   × 12 → 12 meses    bimestral × 6 → 12 meses
--       trimestral × 4 → 12 meses    quincenal × 24 → 12 meses
--     Los planes sin cantidad (eventuales o abiertos) quedan a 12 meses, el
--     horizonte por defecto que ya usaba la proyección de reportes.
UPDATE "tbl_mantenimientos_planes"
   SET "duracion_meses" = GREATEST(1, CEIL(
         COALESCE("cantidad_mantenimientos", 12)::numeric *
         CASE "frecuencia"
           WHEN 'anual'      THEN 12
           WHEN 'semestral'  THEN 6
           WHEN 'trimestral' THEN 3
           WHEN 'bimestral'  THEN 2
           WHEN 'mensual'    THEN 1
           WHEN 'quincenal'  THEN 0.5
           WHEN 'semanal'    THEN 0.25
           WHEN 'diaria'     THEN 0.0333333333
           WHEN 'custom'     THEN COALESCE("frecuencia_dias_custom", 30)::numeric / 30.4375
           ELSE 1
         END
       ))::integer
 WHERE "duracion_meses" IS NULL;

-- 5.4 Monto mensual equivalente: preserva el valor total del contrato.
--       total = (suma pactada por ocurrencia) × (nº de ocurrencias)
--       mensual = total / meses
--     Un plan mensual conserva exactamente su importe por visita; uno trimestral
--     de 300 a 12 meses pasa a 100/mes (4 × 300 = 1200 = 12 × 100).
UPDATE "tbl_mantenimientos_planes" p
   SET "monto_mensual" = ROUND(
         (COALESCE(sub."suma", 0) * COALESCE(p."cantidad_mantenimientos", p."duracion_meses"))
         / NULLIF(p."duracion_meses", 0), 2)
  FROM (
    SELECT "id_plan", SUM("monto") AS "suma"
      FROM "tbl_mantenimientos_planes_ascensores"
     WHERE "estado" = 1
     GROUP BY "id_plan"
  ) sub
 WHERE p."id" = sub."id_plan"
   AND p."monto_mensual" = 0;

-- 5.5 Cuotas ya emitidas de cobros de plan: se les asigna el mes del plan que
--     contiene su fecha de vencimiento, para que sigan ligadas al cronograma.
--     El mes se calcula sobre la ventana de aniversario de fecha_inicio, igual
--     que utils/programacionPlanMantenimiento.js.
UPDATE "tbl_cobros_cuotas" cu
   SET "numero_mes" = GREATEST(1,
         (EXTRACT(YEAR  FROM AGE(cu."fecha_vencimiento", p."fecha_inicio")) * 12
        + EXTRACT(MONTH FROM AGE(cu."fecha_vencimiento", p."fecha_inicio")))::integer + 1)
  FROM "tbl_cobros" c
  JOIN "tbl_mantenimientos_planes" p ON p."id" = c."id_mantenimiento_plan"
 WHERE cu."id_cobro" = c."id"
   AND c."id_mantenimiento_plan" IS NOT NULL
   AND cu."numero_mes" IS NULL;

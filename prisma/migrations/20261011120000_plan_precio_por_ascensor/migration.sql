-- PLAN DE MANTENIMIENTO CON PRECIO POR ASCENSOR
-- =====================================================================
-- Segunda forma de cobrar un plan. Convive con la de siempre:
--
--   'mensual'      (la de siempre) un monto global por mes con mantenimiento,
--                  sin importar qué ascensores se atiendan ese mes.
--   'por_ascensor' cada ascensor tiene su precio (columna `monto` de
--                  tbl_mantenimientos_planes_ascensores, hasta ahora legado
--                  informativo) y cada mes cobra la suma de los ascensores que
--                  se atienden en él según su frecuencia.
--
-- Todos los planes existentes quedan en 'mensual': nada cambia para ellos.
ALTER TABLE "tbl_mantenimientos_planes"
  ADD COLUMN "modo_precio" VARCHAR(20) NOT NULL DEFAULT 'mensual';

-- Ascensores del mes con los que se aprobó la cuota de un plan: cuáles se
-- facturan y cuáles se excluyeron al aprobar, con el importe de cada uno.
--   [{ "id_ascensor": 1, "codigo": "ASC-1", "facturado": true, "monto": 300 }]
-- NULL = cuota aprobada antes de esta opción: se facturaron todos.
ALTER TABLE "tbl_cobros_cuotas" ADD COLUMN "ascensores_mes" JSONB;

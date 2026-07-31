-- Los mantenimientos generados por un PLAN no se facturan uno a uno: la
-- facturación del plan es única por periodo (una cuota del cobro del plan por el
-- total de todos sus ascensores). Con requiere_factura = 1 (el default histórico)
-- cada servicio del plan se contaba como "pendiente por facturar" en Contabilidad
-- y en el KPI del dashboard, inflando la cifra con N filas por periodo.
--
-- A partir de ahora los servicios de plan nacen con requiere_factura = 0
-- (mantenimientosController._crearServiciosOcurrencia). Este backfill alinea los
-- ya existentes. No toca los servicios que SÍ tienen factura propia emitida
-- (planes del modelo anterior, con cobro por servicio): esos conservan su bandera
-- para no dejar huérfano un comprobante ya emitido.
UPDATE "tbl_servicios_proyectos" s
SET "requiere_factura" = 0
WHERE s."id_mantenimiento_plan" IS NOT NULL
  AND s."requiere_factura" = 1
  AND NOT EXISTS (
    SELECT 1 FROM "tbl_facturas" f
    WHERE f."id_servicio" = s."id" AND f."estado" = 1
  );

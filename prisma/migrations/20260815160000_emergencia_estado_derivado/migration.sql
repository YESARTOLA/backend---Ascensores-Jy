-- El estado de la emergencia pasa a derivarse del servicio que la atiende, en
-- vez de moverse a mano (se quedaba congelado en "Reportada" / "En atención"
-- aunque el técnico ya hubiera terminado). Con ello la columna "Ejecución" del
-- listado desaparece: una sola columna "Estado" cuenta las dos cosas.
--
-- Esto es un backfill de una sola vez del histórico. De aquí en adelante lo
-- mantiene al día utils/estadoServicio.js (estadoEmergenciaDesdeServicio +
-- sincronizarEstadoEmergencia), llamado en cada cambio de estado del servicio;
-- el CASE de abajo replica ese mismo mapeo.
UPDATE "tbl_emergencias" e
SET "estado_emergencia" = CASE
    WHEN s."estado_servicio" = 'Cancelado' THEN 'Cancelada'
    WHEN s."estado_servicio" = 'Cerrado'   THEN 'Cerrada'
    WHEN s."estado_servicio" IN (
      'Finalizado por técnico', 'Finalizado observado', 'En revisión administrativa',
      'A gestión de cobro', 'En cobro', 'Cobrado parcial', 'Cobrado total', 'Facturado'
    ) THEN 'Atendida'
    WHEN s."estado_servicio" IN ('En camino', 'En curso') THEN 'En atención'
    WHEN EXISTS (
      SELECT 1 FROM "tbl_servicios_asignaciones" a
      WHERE a."id_servicio" = s."id" AND a."estado" = 1
    ) THEN 'En atención'
    ELSE 'Reportada'
  END,
  "date_time_modification" = NOW()
FROM "tbl_servicios_proyectos" s
WHERE e."id_servicio" = s."id"
  AND e."estado" = 1;

-- Emergencias que todavía no generaron servicio: no hay nada en marcha.
UPDATE "tbl_emergencias"
SET "estado_emergencia" = 'Reportada', "date_time_modification" = NOW()
WHERE "id_servicio" IS NULL
  AND "estado" = 1
  AND "estado_emergencia" <> 'Reportada';

-- ALERTA DE OBSERVACIÓN TÉCNICA: DESTINATARIO ELEGIBLE
-- =====================================================================
-- Antes, marcar "enviar alerta" en una observación disparaba avisos a un
-- conjunto FIJO de destinos (administración, coordinación y cotización con el
-- detalle; contabilidad solo el aviso). Ahora el técnico elige a quién avisar.
--
-- Dos columnas:
--   · tbl_servicios_observaciones.destinatarios_alerta — CSV de los grupos
--     elegidos, para mostrarlo en la observación y dejarlo auditado.
--   · tbl_recordatorios.rol_destinatario — rol concreto al que va ese aviso.
--     Se emite un recordatorio POR ROL destinatario; sin esta columna, todos
--     los que comparten el tipo 'observacion_alerta' verían la alerta aunque no
--     hubieran sido elegidos.
--
-- Ambas quedan NULL en el histórico, que es exactamente el comportamiento
-- previo: un recordatorio sin rol_destinatario lo sigue rigiendo la matriz de
-- visibilidad por tipo, así que las alertas ya emitidas no cambian de audiencia.

ALTER TABLE "tbl_servicios_observaciones"
  ADD COLUMN "destinatarios_alerta" VARCHAR(200);

ALTER TABLE "tbl_recordatorios"
  ADD COLUMN "rol_destinatario" VARCHAR(30);

-- El listado de recordatorios filtra por este campo en cada consulta.
CREATE INDEX "tbl_recordatorios_rol_destinatario_idx" ON "tbl_recordatorios"("rol_destinatario");

-- La fecha de programación del servicio ya NO se registra al aprobar una
-- cotización. El servicio nace sin fecha y el área correspondiente la registra
-- después (detalle del servicio → "Programar fecha"). Por eso la columna pasa a
-- ser opcional. hora_programada y prioridad ya eran opcionales / con default.
ALTER TABLE "tbl_servicios_proyectos" ALTER COLUMN "fecha_programada" DROP NOT NULL;

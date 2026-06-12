-- Campo libre "Responsable" para las atenciones rápidas (persona a cargo de la
-- atención). Texto opcional, sin relación a técnicos.
ALTER TABLE "tbl_atenciones_rapidas" ADD COLUMN "responsable" VARCHAR(150);

-- Plazo de cierre del servicio por parte del técnico.
--
-- El técnico tiene SERVICIO_CIERRE_PLAZO_DIAS días calendario, contados desde el
-- último día programado del servicio, para registrar el cierre. Vencido el plazo
-- solo puede cerrar si el super administrador habilita ESE servicio.
--
-- Motivo: la alerta de "cotización urgente" del calendario se agenda en la fecha
-- PROGRAMADA del servicio (nunca un domingo, porque no se programa trabajo ese
-- día), no en la fecha real de cierre. Acotar el plazo evita que la alerta
-- aparezca en un día ya muy pasado.
ALTER TABLE "tbl_servicios_proyectos" ADD COLUMN "cierre_fuera_plazo_habilitado" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tbl_servicios_proyectos" ADD COLUMN "cierre_habilitado_por" INTEGER;
ALTER TABLE "tbl_servicios_proyectos" ADD COLUMN "cierre_habilitado_en" TIMESTAMPTZ(6);

-- Parámetro configurable (Configuración › Parámetros del sistema, solo super admin).
INSERT INTO "tbl_configuracion" ("clave", "valor", "tipo", "descripcion", "estado", "date_time_registration")
VALUES (
  'SERVICIO_CIERRE_PLAZO_DIAS',
  '3',
  'number',
  'Días calendario que tiene el técnico, desde el último día programado del servicio, para registrar el cierre. Vencido el plazo, el super administrador debe habilitar el cierre de ese servicio.',
  1,
  NOW()
)
ON CONFLICT ("clave") DO NOTHING;

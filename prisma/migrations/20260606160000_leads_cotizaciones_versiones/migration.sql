-- PDFs de cotización adjuntos al lead, versionados de forma incremental.
-- Independiente de tbl_cotizaciones (el módulo formal exige cliente); aquí se
-- registra el documento que respalda el estado "Cotizado" del lead.
CREATE TABLE "tbl_leads_cotizaciones" (
    "id" SERIAL NOT NULL,
    "id_lead" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "id_archivo" INTEGER NOT NULL,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tbl_leads_cotizaciones_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_leads_cotizaciones_id_lead_version_key" ON "tbl_leads_cotizaciones"("id_lead", "version");

ALTER TABLE "tbl_leads_cotizaciones" ADD CONSTRAINT "tbl_leads_cotizaciones_id_lead_fkey"
    FOREIGN KEY ("id_lead") REFERENCES "tbl_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_leads_cotizaciones" ADD CONSTRAINT "tbl_leads_cotizaciones_id_archivo_fkey"
    FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_leads_cotizaciones" ADD CONSTRAINT "tbl_leads_cotizaciones_user_id_registration_fkey"
    FOREIGN KEY ("user_id_registration") REFERENCES "tbl_usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

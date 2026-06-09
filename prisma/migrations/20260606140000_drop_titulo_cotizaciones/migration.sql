-- Se elimina el campo "Título" de las cotizaciones. El objeto de la cotización
-- ahora se deriva del cliente (nombre del edificio u obra) + tipo de servicio +
-- ascensores; el título del servicio generado al aprobar se arma igual.
ALTER TABLE "tbl_cotizaciones" DROP COLUMN "titulo";

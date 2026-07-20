-- Clasificación por área de los adjuntos del cliente: 'servicio' | 'proyecto'.
-- Los registros existentes se asignan al área de Servicios (comportamiento previo).
ALTER TABLE "tbl_clientes_archivos"
  ADD COLUMN "area" VARCHAR(20) NOT NULL DEFAULT 'servicio';

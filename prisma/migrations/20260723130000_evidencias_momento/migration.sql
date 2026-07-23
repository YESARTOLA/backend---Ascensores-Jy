-- Clasificación de las evidencias del trabajo por momento: "Antes" / "Despues".
--
-- La tarjeta "Evidencias del trabajo" del detalle de servicio se divide en dos
-- secciones (Antes y Despues). Cada evidencia general puede indicar a cuál
-- pertenece. NULL = sin clasificar (legado, fotos de ítem de checklist o cierre);
-- en la UI esas se muestran junto a las de "Despues".
-- Idempotente para no chocar en bases donde ya se aplicó parcialmente.

ALTER TABLE "tbl_servicios_evidencias" ADD COLUMN IF NOT EXISTS "momento" VARCHAR(10);

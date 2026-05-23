-- CreateTable
CREATE TABLE "tbl_roles" (
    "id" SERIAL NOT NULL,
    "codigo" VARCHAR(50) NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "descripcion" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_permisos" (
    "id" SERIAL NOT NULL,
    "codigo" VARCHAR(100) NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "tipo" VARCHAR(50),
    "recurso" VARCHAR(100),
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_permisos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_roles_permisos" (
    "id" SERIAL NOT NULL,
    "id_rol" INTEGER NOT NULL,
    "id_permiso" INTEGER NOT NULL,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_roles_permisos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_usuarios" (
    "id" SERIAL NOT NULL,
    "nombres" VARCHAR(150) NOT NULL,
    "correo" VARCHAR(150) NOT NULL,
    "contrasena" VARCHAR(255) NOT NULL,
    "id_rol" INTEGER NOT NULL,
    "id_tecnico" INTEGER,
    "telefono" VARCHAR(30),
    "ultimo_login" TIMESTAMPTZ(6),
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_clientes" (
    "id" SERIAL NOT NULL,
    "tipo_documento" VARCHAR(20) NOT NULL,
    "numero_documento" VARCHAR(30),
    "nombre" VARCHAR(200) NOT NULL,
    "nombre_edificio" VARCHAR(200),
    "telefono" VARCHAR(30) NOT NULL,
    "whatsapp" VARCHAR(30),
    "correo" VARCHAR(150),
    "direccion" TEXT,
    "distrito" VARCHAR(100) NOT NULL,
    "latitud" DECIMAL(10,7),
    "longitud" DECIMAL(10,7),
    "contacto_principal_nombre" VARCHAR(150),
    "contacto_principal_correo" VARCHAR(150),
    "contacto_principal_telefono" VARCHAR(30),
    "contacto_cobranzas_nombre" VARCHAR(150),
    "contacto_cobranzas_correo" VARCHAR(150),
    "contacto_cobranzas_telefono" VARCHAR(30),
    "contacto_admin_nombre" VARCHAR(150),
    "contacto_admin_correo" VARCHAR(150),
    "contacto_admin_telefono" VARCHAR(30),
    "observaciones" TEXT,
    "contrato_inicio" DATE,
    "contrato_fin" DATE,
    "id_archivo_contrato" INTEGER,
    "clasificacion" VARCHAR(20),
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_clientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_clientes_precios" (
    "id" SERIAL NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "id_tipo_servicio" INTEGER NOT NULL,
    "precio" DECIMAL(12,2) NOT NULL,
    "moneda" VARCHAR(10) NOT NULL DEFAULT 'PEN',
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_clientes_precios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_clientes_archivos" (
    "id" SERIAL NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "id_archivo" INTEGER NOT NULL,
    "descripcion" VARCHAR(200),
    "orden" INTEGER NOT NULL DEFAULT 0,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_clientes_archivos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_ascensores" (
    "id" SERIAL NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "codigo" VARCHAR(50) NOT NULL,
    "ubicacion" TEXT,
    "tipo" VARCHAR(50),
    "marca" VARCHAR(100),
    "modelo" VARCHAR(100),
    "capacidad" VARCHAR(50),
    "pisos" INTEGER,
    "anio_aproximado" INTEGER,
    "estado_operativo" VARCHAR(50) NOT NULL DEFAULT 'Operativo',
    "fecha_instalacion" DATE,
    "proximo_mantenimiento" DATE,
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_ascensores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_tecnicos" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "telefono" VARCHAR(30),
    "documento" VARCHAR(30),
    "especialidades" TEXT,
    "estado_operativo" VARCHAR(50) NOT NULL DEFAULT 'Disponible',
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_tecnicos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_tipos_ascensor" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(50) NOT NULL,
    "descripcion" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_tipos_ascensor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_tipos_servicio" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "categoria" VARCHAR(50) NOT NULL,
    "modulo_asociado" VARCHAR(30),
    "descripcion" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_tipos_servicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_tipos_servicio_tecnicos" (
    "id" SERIAL NOT NULL,
    "id_tipo_servicio" INTEGER NOT NULL,
    "id_tecnico" INTEGER NOT NULL,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_tipos_servicio_tecnicos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_proyectos" (
    "id" SERIAL NOT NULL,
    "codigo" VARCHAR(50) NOT NULL,
    "tipo_registro" VARCHAR(20) NOT NULL DEFAULT 'servicio',
    "id_tipo_servicio" INTEGER NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "id_mantenimiento_plan" INTEGER,
    "id_cotizacion" INTEGER,
    "origen" VARCHAR(50) NOT NULL DEFAULT 'directo',
    "titulo" VARCHAR(200) NOT NULL,
    "descripcion" TEXT,
    "fecha_programada" DATE NOT NULL,
    "hora_programada" VARCHAR(10),
    "fecha_estimada_entrega" DATE,
    "prioridad" VARCHAR(20) NOT NULL DEFAULT 'media',
    "estado_servicio" VARCHAR(50) NOT NULL DEFAULT 'Pendiente',
    "precio_interno" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "moneda" VARCHAR(10) NOT NULL DEFAULT 'PEN',
    "sin_cobro" INTEGER NOT NULL DEFAULT 0,
    "es_mantenimiento_gratuito" INTEGER NOT NULL DEFAULT 0,
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_proyectos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_observaciones" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "texto" TEXT NOT NULL,
    "id_archivo" INTEGER,
    "registrada_por" INTEGER,
    "atendida" INTEGER NOT NULL DEFAULT 0,
    "atendida_por" INTEGER,
    "fecha_atendida" TIMESTAMPTZ(6),
    "genera_alerta" INTEGER NOT NULL DEFAULT 0,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_observaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_ascensores" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_ascensor" INTEGER NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "moneda" VARCHAR(10) NOT NULL DEFAULT 'PEN',
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_ascensores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_asignaciones" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_tecnico" INTEGER NOT NULL,
    "rol_asignacion" VARCHAR(50) NOT NULL DEFAULT 'Apoyo',
    "responsable_principal" INTEGER NOT NULL DEFAULT 0,
    "responsable_documentacion" INTEGER NOT NULL DEFAULT 0,
    "responsable_checklist" INTEGER NOT NULL DEFAULT 0,
    "estado_asignacion" VARCHAR(30) NOT NULL DEFAULT 'activa',
    "fecha_asignacion" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asignado_por" INTEGER,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_asignaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_checklists_salida" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_tecnico_responsable" INTEGER NOT NULL,
    "estado_checklist" VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
    "observaciones" TEXT,
    "fecha_completado" TIMESTAMPTZ(6),
    "validado_por" INTEGER,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_checklists_salida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_checklists_salida_items" (
    "id" SERIAL NOT NULL,
    "id_checklist" INTEGER NOT NULL,
    "tipo_item" VARCHAR(30) NOT NULL DEFAULT 'Herramienta',
    "nombre" VARCHAR(200) NOT NULL,
    "cantidad" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unidad" VARCHAR(30) NOT NULL DEFAULT 'Unidad',
    "estado_item" VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_checklists_salida_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_guias" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_tecnico" INTEGER NOT NULL,
    "codigo_guia" VARCHAR(50),
    "id_archivo" INTEGER,
    "observaciones_tecnicas" TEXT,
    "estado_guia" VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
    "fecha_carga" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_guias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_evidencias" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_tecnico" INTEGER NOT NULL,
    "id_archivo" INTEGER,
    "tipo_evidencia" VARCHAR(30) NOT NULL DEFAULT 'Foto',
    "descripcion" TEXT,
    "fecha_carga" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_evidencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_realizados" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "id_tecnico_principal" INTEGER,
    "id_responsable_documentacion" INTEGER,
    "fecha_realizacion" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observaciones_tecnicas" TEXT,
    "descargo_tecnico" TEXT,
    "numero_ot" VARCHAR(50),
    "id_archivo_ot" INTEGER,
    "estado_administrativo" VARCHAR(50) NOT NULL DEFAULT 'Pendiente revisión',
    "estado_contable" VARCHAR(50) NOT NULL DEFAULT 'Pendiente',
    "estado_cobro" VARCHAR(50) NOT NULL DEFAULT 'Pendiente de iniciar',
    "estado_facturacion" VARCHAR(50) NOT NULL DEFAULT 'Sin factura',
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_realizados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_entregas" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "tipo_entrega" VARCHAR(50) NOT NULL,
    "fecha_entrega" DATE NOT NULL,
    "id_responsable_usuario" INTEGER,
    "descripcion" TEXT,
    "id_archivo" INTEGER,
    "estado_entrega" VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_entregas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_mantenimientos_planes" (
    "id" SERIAL NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "id_ascensor" INTEGER NOT NULL,
    "id_tipo_servicio" INTEGER NOT NULL,
    "tipo_plan" VARCHAR(20) NOT NULL DEFAULT 'continuo',
    "frecuencia" VARCHAR(30),
    "frecuencia_dias_custom" INTEGER,
    "cantidad_mantenimientos" INTEGER,
    "cantidad_mantenimientos_gratuitos" INTEGER NOT NULL DEFAULT 0,
    "fecha_inicio" DATE NOT NULL,
    "hora_programada" VARCHAR(10),
    "estado_plan" VARCHAR(30) NOT NULL DEFAULT 'activo',
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_mantenimientos_planes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_emergencias" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER,
    "id_cliente" INTEGER NOT NULL,
    "id_ascensor" INTEGER NOT NULL,
    "motivo" TEXT NOT NULL,
    "nivel_urgencia" VARCHAR(20) NOT NULL DEFAULT 'alta',
    "fecha_reporte" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado_emergencia" VARCHAR(30) NOT NULL DEFAULT 'Reportada',
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_emergencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_correctivos" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER,
    "id_cliente" INTEGER NOT NULL,
    "id_ascensor" INTEGER NOT NULL,
    "falla" TEXT NOT NULL,
    "nivel_urgencia" VARCHAR(20) NOT NULL DEFAULT 'media',
    "fecha_reporte" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado_correctivo" VARCHAR(30) NOT NULL DEFAULT 'Reportado',
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_correctivos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_atenciones_rapidas" (
    "id" SERIAL NOT NULL,
    "nombre_contacto" VARCHAR(150) NOT NULL,
    "telefono" VARCHAR(30) NOT NULL,
    "mensaje_rapido" TEXT,
    "tipo_solicitud" VARCHAR(100),
    "nivel_urgencia" VARCHAR(20) NOT NULL DEFAULT 'media',
    "estado_atencion" VARCHAR(30) NOT NULL DEFAULT 'nueva',
    "id_cliente" INTEGER,
    "id_ascensor" INTEGER,
    "id_tecnico_asignado" INTEGER,
    "id_servicio_convertido" INTEGER,
    "observaciones" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_atenciones_rapidas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_leads" (
    "id" SERIAL NOT NULL,
    "nombre_contacto" VARCHAR(150) NOT NULL,
    "telefono" VARCHAR(30) NOT NULL,
    "canal" VARCHAR(50),
    "id_tipo_servicio_solicitado" INTEGER,
    "cliente_existente" INTEGER NOT NULL DEFAULT 0,
    "id_cliente" INTEGER,
    "estado_lead" VARCHAR(30) NOT NULL DEFAULT 'nuevo',
    "observaciones" TEXT,
    "id_servicio_convertido" INTEGER,
    "rol_codigo_registrador" VARCHAR(50),
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_calendario_eventos" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER,
    "id_mantenimiento_plan" INTEGER,
    "id_emergencia" INTEGER,
    "titulo" VARCHAR(200) NOT NULL,
    "tipo_evento" VARCHAR(30) NOT NULL DEFAULT 'servicio',
    "fecha_inicio" TIMESTAMPTZ(6) NOT NULL,
    "fecha_fin" TIMESTAMPTZ(6),
    "estado_evento" VARCHAR(30) NOT NULL DEFAULT 'programado',
    "color" VARCHAR(20),
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_calendario_eventos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cobros" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "monto_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "moneda" VARCHAR(10) NOT NULL DEFAULT 'PEN',
    "total_abonado" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "saldo_pendiente" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "numero_cuotas" INTEGER NOT NULL DEFAULT 1,
    "cuotas_pagadas" INTEGER NOT NULL DEFAULT 0,
    "cuotas_faltantes" INTEGER NOT NULL DEFAULT 1,
    "fecha_proximo_abono" DATE,
    "fecha_ultimo_abono" DATE,
    "estado_cobro" VARCHAR(50) NOT NULL DEFAULT 'Pendiente de iniciar',
    "id_responsable_usuario" INTEGER,
    "observaciones" TEXT,
    "saldo_variable" BOOLEAN NOT NULL DEFAULT false,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cobros_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cobros_cuotas" (
    "id" SERIAL NOT NULL,
    "id_cobro" INTEGER NOT NULL,
    "numero_cuota" INTEGER NOT NULL,
    "fecha_vencimiento" DATE NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "monto_pagado" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "estado_cuota" VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
    "fecha_pago" DATE,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cobros_cuotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_pagos" (
    "id" SERIAL NOT NULL,
    "id_cobro" INTEGER NOT NULL,
    "numero_abono" INTEGER NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "fecha_pago" DATE NOT NULL,
    "metodo_pago" VARCHAR(30) NOT NULL DEFAULT 'Efectivo',
    "id_archivo_comprobante" INTEGER,
    "id_cuenta_bancaria" INTEGER,
    "observaciones" TEXT,
    "registrado_por" INTEGER,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_pagos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cobros_recordatorios" (
    "id" SERIAL NOT NULL,
    "id_cobro" INTEGER NOT NULL,
    "canal" VARCHAR(30) NOT NULL DEFAULT 'whatsapp',
    "mensaje" TEXT NOT NULL,
    "enviado_por" INTEGER,
    "fecha_envio" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cobros_recordatorios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_facturas" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_cobro" INTEGER,
    "id_cuota" INTEGER,
    "id_cliente" INTEGER NOT NULL,
    "numero_factura" VARCHAR(50) NOT NULL,
    "fecha_emision" DATE NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "id_archivo" INTEGER,
    "estado_factura" VARCHAR(30) NOT NULL DEFAULT 'Emitida',
    "registrado_por" INTEGER,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_facturas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_archivos" (
    "id" SERIAL NOT NULL,
    "nombre_original" VARCHAR(255) NOT NULL,
    "ruta_almacenamiento" TEXT NOT NULL,
    "mime_type" VARCHAR(100),
    "tamano_bytes" INTEGER,
    "subido_por" INTEGER,
    "fecha_subida" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_archivos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_clientes_historial" (
    "id" SERIAL NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "id_servicio" INTEGER,
    "tipo_evento" VARCHAR(50) NOT NULL,
    "descripcion" TEXT NOT NULL,
    "fecha_evento" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_por" INTEGER,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_clientes_historial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_ascensores_historial" (
    "id" SERIAL NOT NULL,
    "id_ascensor" INTEGER NOT NULL,
    "id_servicio" INTEGER,
    "tipo_evento" VARCHAR(50) NOT NULL,
    "descripcion" TEXT NOT NULL,
    "fecha_evento" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_por" INTEGER,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_ascensores_historial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_estados_historial" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "estado_anterior" VARCHAR(50),
    "estado_nuevo" VARCHAR(50) NOT NULL,
    "cambiado_por" INTEGER,
    "observaciones" TEXT,
    "fecha_cambio" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_estados_historial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_auditoria" (
    "id" SERIAL NOT NULL,
    "id_usuario" INTEGER,
    "entidad" VARCHAR(100) NOT NULL,
    "id_entidad" INTEGER,
    "accion" VARCHAR(50) NOT NULL,
    "valor_anterior" JSONB,
    "valor_nuevo" JSONB,
    "ip" VARCHAR(50),
    "fecha_evento" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_recordatorios" (
    "id" SERIAL NOT NULL,
    "titulo" VARCHAR(200) NOT NULL,
    "descripcion" TEXT,
    "tipo" VARCHAR(30) NOT NULL,
    "origen" VARCHAR(20) NOT NULL DEFAULT 'manual',
    "fecha_recordatorio" TIMESTAMPTZ(6) NOT NULL,
    "prioridad" VARCHAR(20) NOT NULL DEFAULT 'media',
    "estado_recordatorio" VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    "color" VARCHAR(20),
    "id_servicio" INTEGER,
    "id_mantenimiento_plan" INTEGER,
    "id_emergencia" INTEGER,
    "id_cobro" INTEGER,
    "id_cuota" INTEGER,
    "fecha_atendido" TIMESTAMPTZ(6),
    "atendido_por" INTEGER,
    "fecha_lectura" TIMESTAMPTZ(6),
    "leido_por" INTEGER,
    "notas_seguimiento" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_recordatorios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cotizaciones" (
    "id" SERIAL NOT NULL,
    "codigo" VARCHAR(50) NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "id_lead" INTEGER,
    "id_tipo_servicio" INTEGER NOT NULL,
    "titulo" VARCHAR(200) NOT NULL,
    "descripcion" TEXT,
    "estado_global" VARCHAR(30) NOT NULL DEFAULT 'Cotizado',
    "version_activa" INTEGER NOT NULL DEFAULT 1,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cotizaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cotizaciones_archivos" (
    "id" SERIAL NOT NULL,
    "id_cotizacion" INTEGER NOT NULL,
    "id_archivo" INTEGER NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cotizaciones_archivos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cotizaciones_versiones" (
    "id" SERIAL NOT NULL,
    "id_cotizacion" INTEGER NOT NULL,
    "numero_version" INTEGER NOT NULL,
    "fecha_envio" DATE,
    "fecha_validez" DATE NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igv" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igv_tasa" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "monto_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "moneda" VARCHAR(10) NOT NULL DEFAULT 'PEN',
    "estado_version" VARCHAR(30) NOT NULL DEFAULT 'Cotizado',
    "motivo_cambio" TEXT,
    "observaciones" TEXT,
    "terminos" TEXT,
    "id_archivo_pdf" INTEGER,
    "fecha_aprobacion" TIMESTAMPTZ(6),
    "aprobada_por" INTEGER,
    "id_archivo_respaldo" INTEGER,
    "motivo_rechazo" TEXT,
    "fecha_rechazo" TIMESTAMPTZ(6),
    "rechazada_por" INTEGER,
    "tiene_cuotas" BOOLEAN NOT NULL DEFAULT false,
    "plan_cuotas" JSONB,
    "saldo_variable" BOOLEAN NOT NULL DEFAULT false,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cotizaciones_versiones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cotizaciones_items" (
    "id" SERIAL NOT NULL,
    "id_version" INTEGER NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "descripcion" TEXT NOT NULL,
    "cantidad" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unidad" VARCHAR(30) NOT NULL DEFAULT 'Unidad',
    "precio_unitario" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "descuento_porcentaje" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "importe" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cotizaciones_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cotizaciones_ascensores" (
    "id" SERIAL NOT NULL,
    "id_cotizacion" INTEGER NOT NULL,
    "id_ascensor" INTEGER,
    "ascensor_nuevo" JSONB,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cotizaciones_ascensores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_cuentas_bancarias" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "banco" VARCHAR(80) NOT NULL,
    "tipo_cuenta" VARCHAR(30) NOT NULL,
    "moneda" VARCHAR(10) NOT NULL DEFAULT 'PEN',
    "numero_cuenta" VARCHAR(50) NOT NULL,
    "cci" VARCHAR(50),
    "titular" VARCHAR(150) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_cuentas_bancarias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_configuracion" (
    "id" SERIAL NOT NULL,
    "clave" VARCHAR(80) NOT NULL,
    "valor" TEXT NOT NULL,
    "tipo" VARCHAR(20) NOT NULL DEFAULT 'string',
    "descripcion" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_configuracion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_checklist_plantillas" (
    "id" SERIAL NOT NULL,
    "categoria" VARCHAR(30) NOT NULL,
    "titulo" VARCHAR(150) NOT NULL,
    "descripcion" TEXT,
    "activa" INTEGER NOT NULL DEFAULT 1,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_checklist_plantillas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_checklist_plantilla_items" (
    "id" SERIAL NOT NULL,
    "id_plantilla" INTEGER NOT NULL,
    "grupo" VARCHAR(80),
    "texto" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_checklist_plantilla_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_finalizacion_checklist" (
    "id" SERIAL NOT NULL,
    "id_servicio" INTEGER NOT NULL,
    "id_plantilla" INTEGER NOT NULL,
    "completado_por" INTEGER,
    "id_archivo_pdf" INTEGER,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_finalizacion_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_servicios_finalizacion_respuestas" (
    "id" SERIAL NOT NULL,
    "id_checklist" INTEGER NOT NULL,
    "id_item" INTEGER NOT NULL,
    "respuesta" VARCHAR(10) NOT NULL,
    "nota" TEXT,
    "estado" INTEGER NOT NULL DEFAULT 1,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "tbl_servicios_finalizacion_respuestas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_roles_codigo_key" ON "tbl_roles"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_permisos_codigo_key" ON "tbl_permisos"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_roles_permisos_id_rol_id_permiso_key" ON "tbl_roles_permisos"("id_rol", "id_permiso");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_usuarios_correo_key" ON "tbl_usuarios"("correo");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_usuarios_id_tecnico_key" ON "tbl_usuarios"("id_tecnico");

-- CreateIndex
CREATE INDEX "tbl_clientes_precios_id_cliente_idx" ON "tbl_clientes_precios"("id_cliente");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_clientes_precios_id_cliente_id_tipo_servicio_key" ON "tbl_clientes_precios"("id_cliente", "id_tipo_servicio");

-- CreateIndex
CREATE INDEX "tbl_clientes_archivos_id_cliente_idx" ON "tbl_clientes_archivos"("id_cliente");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_ascensores_codigo_key" ON "tbl_ascensores"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_tipos_ascensor_nombre_key" ON "tbl_tipos_ascensor"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_tipos_servicio_tecnicos_id_tipo_servicio_id_tecnico_key" ON "tbl_tipos_servicio_tecnicos"("id_tipo_servicio", "id_tecnico");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_servicios_proyectos_codigo_key" ON "tbl_servicios_proyectos"("codigo");

-- CreateIndex
CREATE INDEX "tbl_servicios_observaciones_id_servicio_idx" ON "tbl_servicios_observaciones"("id_servicio");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_servicios_ascensores_id_servicio_id_ascensor_key" ON "tbl_servicios_ascensores"("id_servicio", "id_ascensor");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_servicios_asignaciones_id_servicio_id_tecnico_key" ON "tbl_servicios_asignaciones"("id_servicio", "id_tecnico");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_checklists_salida_id_servicio_key" ON "tbl_checklists_salida"("id_servicio");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_servicios_realizados_id_servicio_key" ON "tbl_servicios_realizados"("id_servicio");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_emergencias_id_servicio_key" ON "tbl_emergencias"("id_servicio");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_correctivos_id_servicio_key" ON "tbl_correctivos"("id_servicio");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_cobros_id_servicio_key" ON "tbl_cobros"("id_servicio");

-- CreateIndex
CREATE INDEX "tbl_recordatorios_fecha_recordatorio_idx" ON "tbl_recordatorios"("fecha_recordatorio");

-- CreateIndex
CREATE INDEX "tbl_recordatorios_estado_recordatorio_fecha_recordatorio_idx" ON "tbl_recordatorios"("estado_recordatorio", "fecha_recordatorio");

-- CreateIndex
CREATE INDEX "tbl_recordatorios_tipo_idx" ON "tbl_recordatorios"("tipo");

-- CreateIndex
CREATE INDEX "tbl_recordatorios_id_servicio_idx" ON "tbl_recordatorios"("id_servicio");

-- CreateIndex
CREATE INDEX "tbl_recordatorios_id_mantenimiento_plan_idx" ON "tbl_recordatorios"("id_mantenimiento_plan");

-- CreateIndex
CREATE INDEX "tbl_recordatorios_id_emergencia_idx" ON "tbl_recordatorios"("id_emergencia");

-- CreateIndex
CREATE INDEX "tbl_recordatorios_id_cobro_idx" ON "tbl_recordatorios"("id_cobro");

-- CreateIndex
CREATE INDEX "tbl_recordatorios_id_cuota_idx" ON "tbl_recordatorios"("id_cuota");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_cotizaciones_codigo_key" ON "tbl_cotizaciones"("codigo");

-- CreateIndex
CREATE INDEX "tbl_cotizaciones_id_cliente_idx" ON "tbl_cotizaciones"("id_cliente");

-- CreateIndex
CREATE INDEX "tbl_cotizaciones_estado_global_idx" ON "tbl_cotizaciones"("estado_global");

-- CreateIndex
CREATE INDEX "tbl_cotizaciones_codigo_idx" ON "tbl_cotizaciones"("codigo");

-- CreateIndex
CREATE INDEX "tbl_cotizaciones_archivos_id_cotizacion_idx" ON "tbl_cotizaciones_archivos"("id_cotizacion");

-- CreateIndex
CREATE INDEX "tbl_cotizaciones_versiones_estado_version_idx" ON "tbl_cotizaciones_versiones"("estado_version");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_cotizaciones_versiones_id_cotizacion_numero_version_key" ON "tbl_cotizaciones_versiones"("id_cotizacion", "numero_version");

-- CreateIndex
CREATE INDEX "tbl_cotizaciones_ascensores_id_cotizacion_idx" ON "tbl_cotizaciones_ascensores"("id_cotizacion");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_configuracion_clave_key" ON "tbl_configuracion"("clave");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_checklist_plantillas_categoria_key" ON "tbl_checklist_plantillas"("categoria");

-- CreateIndex
CREATE INDEX "tbl_checklist_plantilla_items_id_plantilla_idx" ON "tbl_checklist_plantilla_items"("id_plantilla");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_servicios_finalizacion_checklist_id_servicio_key" ON "tbl_servicios_finalizacion_checklist"("id_servicio");

-- CreateIndex
CREATE INDEX "tbl_servicios_finalizacion_respuestas_id_checklist_idx" ON "tbl_servicios_finalizacion_respuestas"("id_checklist");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_servicios_finalizacion_respuestas_id_checklist_id_item_key" ON "tbl_servicios_finalizacion_respuestas"("id_checklist", "id_item");

-- AddForeignKey
ALTER TABLE "tbl_roles_permisos" ADD CONSTRAINT "tbl_roles_permisos_id_rol_fkey" FOREIGN KEY ("id_rol") REFERENCES "tbl_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_roles_permisos" ADD CONSTRAINT "tbl_roles_permisos_id_permiso_fkey" FOREIGN KEY ("id_permiso") REFERENCES "tbl_permisos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_usuarios" ADD CONSTRAINT "tbl_usuarios_id_rol_fkey" FOREIGN KEY ("id_rol") REFERENCES "tbl_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_usuarios" ADD CONSTRAINT "tbl_usuarios_id_tecnico_fkey" FOREIGN KEY ("id_tecnico") REFERENCES "tbl_tecnicos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_clientes" ADD CONSTRAINT "tbl_clientes_id_archivo_contrato_fkey" FOREIGN KEY ("id_archivo_contrato") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_clientes_precios" ADD CONSTRAINT "tbl_clientes_precios_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_clientes_precios" ADD CONSTRAINT "tbl_clientes_precios_id_tipo_servicio_fkey" FOREIGN KEY ("id_tipo_servicio") REFERENCES "tbl_tipos_servicio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_clientes_archivos" ADD CONSTRAINT "tbl_clientes_archivos_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_clientes_archivos" ADD CONSTRAINT "tbl_clientes_archivos_id_archivo_fkey" FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ascensores" ADD CONSTRAINT "tbl_ascensores_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_tipos_servicio_tecnicos" ADD CONSTRAINT "tbl_tipos_servicio_tecnicos_id_tipo_servicio_fkey" FOREIGN KEY ("id_tipo_servicio") REFERENCES "tbl_tipos_servicio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_tipos_servicio_tecnicos" ADD CONSTRAINT "tbl_tipos_servicio_tecnicos_id_tecnico_fkey" FOREIGN KEY ("id_tecnico") REFERENCES "tbl_tecnicos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_proyectos" ADD CONSTRAINT "tbl_servicios_proyectos_id_tipo_servicio_fkey" FOREIGN KEY ("id_tipo_servicio") REFERENCES "tbl_tipos_servicio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_proyectos" ADD CONSTRAINT "tbl_servicios_proyectos_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_proyectos" ADD CONSTRAINT "tbl_servicios_proyectos_id_mantenimiento_plan_fkey" FOREIGN KEY ("id_mantenimiento_plan") REFERENCES "tbl_mantenimientos_planes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_proyectos" ADD CONSTRAINT "tbl_servicios_proyectos_id_cotizacion_fkey" FOREIGN KEY ("id_cotizacion") REFERENCES "tbl_cotizaciones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_observaciones" ADD CONSTRAINT "tbl_servicios_observaciones_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_observaciones" ADD CONSTRAINT "tbl_servicios_observaciones_id_archivo_fkey" FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_ascensores" ADD CONSTRAINT "tbl_servicios_ascensores_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_ascensores" ADD CONSTRAINT "tbl_servicios_ascensores_id_ascensor_fkey" FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_asignaciones" ADD CONSTRAINT "tbl_servicios_asignaciones_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_asignaciones" ADD CONSTRAINT "tbl_servicios_asignaciones_id_tecnico_fkey" FOREIGN KEY ("id_tecnico") REFERENCES "tbl_tecnicos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_checklists_salida" ADD CONSTRAINT "tbl_checklists_salida_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_checklists_salida" ADD CONSTRAINT "tbl_checklists_salida_id_tecnico_responsable_fkey" FOREIGN KEY ("id_tecnico_responsable") REFERENCES "tbl_tecnicos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_checklists_salida_items" ADD CONSTRAINT "tbl_checklists_salida_items_id_checklist_fkey" FOREIGN KEY ("id_checklist") REFERENCES "tbl_checklists_salida"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_guias" ADD CONSTRAINT "tbl_servicios_guias_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_guias" ADD CONSTRAINT "tbl_servicios_guias_id_tecnico_fkey" FOREIGN KEY ("id_tecnico") REFERENCES "tbl_tecnicos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_guias" ADD CONSTRAINT "tbl_servicios_guias_id_archivo_fkey" FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_evidencias" ADD CONSTRAINT "tbl_servicios_evidencias_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_evidencias" ADD CONSTRAINT "tbl_servicios_evidencias_id_tecnico_fkey" FOREIGN KEY ("id_tecnico") REFERENCES "tbl_tecnicos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_evidencias" ADD CONSTRAINT "tbl_servicios_evidencias_id_archivo_fkey" FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_realizados" ADD CONSTRAINT "tbl_servicios_realizados_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_realizados" ADD CONSTRAINT "tbl_servicios_realizados_id_archivo_ot_fkey" FOREIGN KEY ("id_archivo_ot") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_entregas" ADD CONSTRAINT "tbl_entregas_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_entregas" ADD CONSTRAINT "tbl_entregas_id_archivo_fkey" FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mantenimientos_planes" ADD CONSTRAINT "tbl_mantenimientos_planes_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mantenimientos_planes" ADD CONSTRAINT "tbl_mantenimientos_planes_id_ascensor_fkey" FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mantenimientos_planes" ADD CONSTRAINT "tbl_mantenimientos_planes_id_tipo_servicio_fkey" FOREIGN KEY ("id_tipo_servicio") REFERENCES "tbl_tipos_servicio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_emergencias" ADD CONSTRAINT "tbl_emergencias_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_emergencias" ADD CONSTRAINT "tbl_emergencias_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_emergencias" ADD CONSTRAINT "tbl_emergencias_id_ascensor_fkey" FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_correctivos" ADD CONSTRAINT "tbl_correctivos_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_correctivos" ADD CONSTRAINT "tbl_correctivos_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_correctivos" ADD CONSTRAINT "tbl_correctivos_id_ascensor_fkey" FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_atenciones_rapidas" ADD CONSTRAINT "tbl_atenciones_rapidas_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_atenciones_rapidas" ADD CONSTRAINT "tbl_atenciones_rapidas_id_ascensor_fkey" FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_leads" ADD CONSTRAINT "tbl_leads_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_leads" ADD CONSTRAINT "tbl_leads_id_tipo_servicio_solicitado_fkey" FOREIGN KEY ("id_tipo_servicio_solicitado") REFERENCES "tbl_tipos_servicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_leads" ADD CONSTRAINT "tbl_leads_user_id_registration_fkey" FOREIGN KEY ("user_id_registration") REFERENCES "tbl_usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_calendario_eventos" ADD CONSTRAINT "tbl_calendario_eventos_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_calendario_eventos" ADD CONSTRAINT "tbl_calendario_eventos_id_mantenimiento_plan_fkey" FOREIGN KEY ("id_mantenimiento_plan") REFERENCES "tbl_mantenimientos_planes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_calendario_eventos" ADD CONSTRAINT "tbl_calendario_eventos_id_emergencia_fkey" FOREIGN KEY ("id_emergencia") REFERENCES "tbl_emergencias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cobros" ADD CONSTRAINT "tbl_cobros_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cobros" ADD CONSTRAINT "tbl_cobros_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cobros_cuotas" ADD CONSTRAINT "tbl_cobros_cuotas_id_cobro_fkey" FOREIGN KEY ("id_cobro") REFERENCES "tbl_cobros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_pagos" ADD CONSTRAINT "tbl_pagos_id_cobro_fkey" FOREIGN KEY ("id_cobro") REFERENCES "tbl_cobros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_pagos" ADD CONSTRAINT "tbl_pagos_id_archivo_comprobante_fkey" FOREIGN KEY ("id_archivo_comprobante") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_pagos" ADD CONSTRAINT "tbl_pagos_id_cuenta_bancaria_fkey" FOREIGN KEY ("id_cuenta_bancaria") REFERENCES "tbl_cuentas_bancarias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cobros_recordatorios" ADD CONSTRAINT "tbl_cobros_recordatorios_id_cobro_fkey" FOREIGN KEY ("id_cobro") REFERENCES "tbl_cobros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_facturas" ADD CONSTRAINT "tbl_facturas_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_facturas" ADD CONSTRAINT "tbl_facturas_id_cobro_fkey" FOREIGN KEY ("id_cobro") REFERENCES "tbl_cobros"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_facturas" ADD CONSTRAINT "tbl_facturas_id_cuota_fkey" FOREIGN KEY ("id_cuota") REFERENCES "tbl_cobros_cuotas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_facturas" ADD CONSTRAINT "tbl_facturas_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_facturas" ADD CONSTRAINT "tbl_facturas_id_archivo_fkey" FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_clientes_historial" ADD CONSTRAINT "tbl_clientes_historial_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ascensores_historial" ADD CONSTRAINT "tbl_ascensores_historial_id_ascensor_fkey" FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_estados_historial" ADD CONSTRAINT "tbl_servicios_estados_historial_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_recordatorios" ADD CONSTRAINT "tbl_recordatorios_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_recordatorios" ADD CONSTRAINT "tbl_recordatorios_id_mantenimiento_plan_fkey" FOREIGN KEY ("id_mantenimiento_plan") REFERENCES "tbl_mantenimientos_planes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_recordatorios" ADD CONSTRAINT "tbl_recordatorios_id_emergencia_fkey" FOREIGN KEY ("id_emergencia") REFERENCES "tbl_emergencias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_recordatorios" ADD CONSTRAINT "tbl_recordatorios_id_cobro_fkey" FOREIGN KEY ("id_cobro") REFERENCES "tbl_cobros"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_recordatorios" ADD CONSTRAINT "tbl_recordatorios_id_cuota_fkey" FOREIGN KEY ("id_cuota") REFERENCES "tbl_cobros_cuotas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones" ADD CONSTRAINT "tbl_cotizaciones_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "tbl_clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones" ADD CONSTRAINT "tbl_cotizaciones_id_lead_fkey" FOREIGN KEY ("id_lead") REFERENCES "tbl_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones" ADD CONSTRAINT "tbl_cotizaciones_id_tipo_servicio_fkey" FOREIGN KEY ("id_tipo_servicio") REFERENCES "tbl_tipos_servicio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones_archivos" ADD CONSTRAINT "tbl_cotizaciones_archivos_id_cotizacion_fkey" FOREIGN KEY ("id_cotizacion") REFERENCES "tbl_cotizaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones_archivos" ADD CONSTRAINT "tbl_cotizaciones_archivos_id_archivo_fkey" FOREIGN KEY ("id_archivo") REFERENCES "tbl_archivos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones_versiones" ADD CONSTRAINT "tbl_cotizaciones_versiones_id_cotizacion_fkey" FOREIGN KEY ("id_cotizacion") REFERENCES "tbl_cotizaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones_versiones" ADD CONSTRAINT "tbl_cotizaciones_versiones_id_archivo_pdf_fkey" FOREIGN KEY ("id_archivo_pdf") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones_versiones" ADD CONSTRAINT "tbl_cotizaciones_versiones_id_archivo_respaldo_fkey" FOREIGN KEY ("id_archivo_respaldo") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones_items" ADD CONSTRAINT "tbl_cotizaciones_items_id_version_fkey" FOREIGN KEY ("id_version") REFERENCES "tbl_cotizaciones_versiones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones_ascensores" ADD CONSTRAINT "tbl_cotizaciones_ascensores_id_cotizacion_fkey" FOREIGN KEY ("id_cotizacion") REFERENCES "tbl_cotizaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_cotizaciones_ascensores" ADD CONSTRAINT "tbl_cotizaciones_ascensores_id_ascensor_fkey" FOREIGN KEY ("id_ascensor") REFERENCES "tbl_ascensores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_checklist_plantilla_items" ADD CONSTRAINT "tbl_checklist_plantilla_items_id_plantilla_fkey" FOREIGN KEY ("id_plantilla") REFERENCES "tbl_checklist_plantillas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_finalizacion_checklist" ADD CONSTRAINT "tbl_servicios_finalizacion_checklist_id_servicio_fkey" FOREIGN KEY ("id_servicio") REFERENCES "tbl_servicios_proyectos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_finalizacion_checklist" ADD CONSTRAINT "tbl_servicios_finalizacion_checklist_id_plantilla_fkey" FOREIGN KEY ("id_plantilla") REFERENCES "tbl_checklist_plantillas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_finalizacion_checklist" ADD CONSTRAINT "tbl_servicios_finalizacion_checklist_id_archivo_pdf_fkey" FOREIGN KEY ("id_archivo_pdf") REFERENCES "tbl_archivos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_finalizacion_respuestas" ADD CONSTRAINT "tbl_servicios_finalizacion_respuestas_id_checklist_fkey" FOREIGN KEY ("id_checklist") REFERENCES "tbl_servicios_finalizacion_checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_servicios_finalizacion_respuestas" ADD CONSTRAINT "tbl_servicios_finalizacion_respuestas_id_item_fkey" FOREIGN KEY ("id_item") REFERENCES "tbl_checklist_plantilla_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


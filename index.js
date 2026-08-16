require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Lima';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

// Confiar en el proxy de Railway (X-Forwarded-*) — necesario para HTTPS y rate limits
app.set('trust proxy', 1);

// CORS — admite múltiples orígenes separados por coma en CORS_ORIGIN.
// "*" o vacío permite todos (útil para entornos no productivos).
const corsOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || corsOrigins.includes('*') || corsOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error(`Origen no permitido por CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Archivos: el frontend pide `/uploads/<tipo>/<yyyy>/<mm>/<file>`. El backend
// genera una URL firmada de Wasabi y 302-redirige al cliente. El navegador
// (o un <img>) sigue el redirect transparentemente.
const storage = require('./utils/storage');
app.get('/uploads/*', async (req, res) => {
  try {
    const key = storage.keyDesdeRuta(req.path); // quita el "/" inicial
    // `?download=1` (opcional con `?n=<nombre>`) fuerza Content-Disposition: attachment
    // para descargar en lugar de reproducir/abrir inline. Útil para videos grandes
    // donde no queremos cargarlos en memoria en el navegador antes de guardar.
    const descargar = req.query.download === '1' || req.query.download === 'true';
    const nombreDescarga = descargar ? (String(req.query.n || '').trim() || 'archivo') : undefined;

    // Driver LOCAL: servir el archivo directamente desde disco (sin redirect).
    if (storage.esLocal()) {
      const filePath = storage.rutaAbsoluta(key);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
      if (descargar) return res.download(filePath, nombreDescarga || path.basename(filePath));
      return res.sendFile(filePath);
    }

    // Driver WASABI: 302 a la URL firmada; el navegador sigue el redirect.
    const url = await storage.urlPresigned(key, {
      expiresIn: Number(process.env.WASABI_URL_TTL) || 3600,
      nombreDescarga
    });
    res.redirect(302, url);
  } catch (err) {
    console.error('[uploads] error resolviendo archivo:', err.message);
    res.status(404).json({ error: 'Archivo no encontrado' });
  }
});

// Health check (raíz y /api para compatibilidad con healthchecks de Railway)
const healthHandler = (_req, res) =>
  res.json({ status: 'ok', tz: process.env.TZ, now: new Date().toISOString() });
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// Confinamiento de roles acotados a un solo módulo (p. ej. Central de ventas →
// Leads): lista blanca aplicada antes de montar la API, para que ningún endpoint
// —presente o futuro— quede accesible por omisión. Ver middleware/confinamientoMiddleware.
const { confinarRoles } = require('./middleware/confinamientoMiddleware');
app.use('/api', confinarRoles);

// Rutas
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/usuarios', require('./routes/usuariosRoutes'));
app.use('/api/clientes', require('./routes/clientesRoutes'));
app.use('/api/edificios', require('./routes/edificiosRoutes'));
app.use('/api/ascensores', require('./routes/ascensoresRoutes'));
app.use('/api/tecnicos', require('./routes/tecnicosRoutes'));
app.use('/api/tipos-servicio', require('./routes/tiposServicioRoutes'));
app.use('/api/tipos-ascensor', require('./routes/tiposAscensorRoutes'));
app.use('/api/ubigeo', require('./routes/ubigeoRoutes'));
app.use('/api/servicios', require('./routes/serviciosRoutes'));
app.use('/api/checklists', require('./routes/checklistRoutes'));
app.use('/api/checklist-plantillas', require('./routes/checklistPlantillasRoutes'));
app.use('/api/cobros', require('./routes/cobrosRoutes'));
app.use('/api/facturas', require('./routes/facturasRoutes'));
app.use('/api/emergencias', require('./routes/emergenciasRoutes'));
app.use('/api/correctivos', require('./routes/correctivosRoutes'));
app.use('/api/mantenimientos', require('./routes/mantenimientosRoutes'));
app.use('/api/leads', require('./routes/leadsRoutes'));
app.use('/api/atenciones-rapidas', require('./routes/atencionesRapidasRoutes'));
app.use('/api/calendario', require('./routes/calendarioRoutes'));
app.use('/api/recordatorios', require('./routes/recordatoriosRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/reportes', require('./routes/reportesRoutes'));
app.use('/api/auditoria', require('./routes/auditoriaRoutes'));
app.use('/api/entregas', require('./routes/entregasRoutes'));
app.use('/api/archivos', require('./routes/archivosRoutes'));
app.use('/api/cotizaciones', require('./routes/cotizacionesRoutes'));
app.use('/api/cuentas-bancarias', require('./routes/cuentasBancariasRoutes'));
app.use('/api/configuracion', require('./routes/configuracionRoutes'));
app.use('/api', require('./routes/evidenciasGuiasRoutes'));

// 404 JSON
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint no encontrado' }));

// Manejador global de errores
app.use((err, _req, res, _next) => {
  console.error('Error global:', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Error interno del servidor' });
});

// Bind a 0.0.0.0 para que Railway pueda hacer health check
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ascensores Jy] Backend escuchando en puerto ${PORT} | TZ=${process.env.TZ} | NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  // Asegura que las claves base de configuración existan en BD (idempotente).
  require('./utils/configuracion').asegurarDefaults()
    .catch(err => console.warn('[configuracion] No se pudieron asegurar defaults:', err.message));
});

// Timeouts para soportar uploads grandes (videos de evidencia hasta cientos de MB
// en conexiones lentas). Node 18+ trae requestTimeout=300s por defecto, que se
// quedaba corto para subidas móviles. headersTimeout debe ser mayor que requestTimeout.
const SERVER_REQUEST_TIMEOUT_MS = Number(process.env.SERVER_REQUEST_TIMEOUT_MS) || 15 * 60 * 1000;
server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
server.headersTimeout = SERVER_REQUEST_TIMEOUT_MS + 60 * 1000;
server.keepAliveTimeout = 65 * 1000; // > timeout de keep-alive del proxy de Railway

// Graceful shutdown (Railway envía SIGTERM antes de reciclar el contenedor)
const shutdown = (signal) => {
  console.log(`[Ascensores Jy] ${signal} recibido — cerrando servidor...`);
  server.close(() => {
    console.log('[Ascensores Jy] Servidor cerrado limpiamente');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

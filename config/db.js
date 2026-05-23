const { Pool } = require('pg');
require('dotenv').config();

// Asegurar timezone consistente: backend procesa en UTC,
// el cliente renderiza con su zona horaria real (sin desfases en Railway).
process.env.TZ = process.env.TZ || 'America/Lima';

// Prioriza DATABASE_URL (Railway, Heroku, etc.). Si no existe, cae a las
// variables individuales (DB_HOST, DB_USER, …) para desarrollo local.
const config = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      // SSL solo si la URL apunta a un host remoto (no localhost/Railway internal).
      ssl:
        process.env.DB_SSL === 'true' ||
        (process.env.DATABASE_URL.includes('rlwy.net') && !process.env.DATABASE_URL.includes('railway.internal'))
          ? { rejectUnauthorized: false }
          : false
    }
  : {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    };

const pool = new Pool(config);

pool.on('error', (err) => {
  console.error('[pg.Pool] Error inesperado en cliente inactivo:', err);
});

module.exports = pool;

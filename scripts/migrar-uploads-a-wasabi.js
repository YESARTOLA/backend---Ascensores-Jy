/**
 * Migra todos los archivos físicos en `backend/uploads/` hacia Wasabi.
 * Para cada archivo:
 *   - Calcula la key S3 manteniendo el path relativo desde `backend/uploads/` con prefijo `uploads/`.
 *   - Sube el archivo si no existe ya en Wasabi.
 *   - Una vez subido y verificado, elimina el archivo local.
 *
 * Idempotente: si el objeto ya existe en Wasabi, sólo borra el local (no re-sube).
 * Modo dry-run: `node scripts/migrar-uploads-a-wasabi.js --dry`
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const mime = (() => {
  // No queremos depender de un paquete extra: tabla mínima derivada de extensión.
  const tabla = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.zip': 'application/zip',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return (file) => tabla[path.extname(file).toLowerCase()] || 'application/octet-stream';
})();

const { subirObjeto, existeObjeto, BUCKET } = require('../utils/storage');

const DRY = process.argv.includes('--dry');
const ROOT = path.join(__dirname, '..', 'uploads');

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function keyParaArchivo(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  return `uploads/${rel}`;
}

(async () => {
  console.log(`[migrar] origen=${ROOT}`);
  console.log(`[migrar] bucket=${BUCKET}${DRY ? ' (DRY RUN)' : ''}`);
  let subidos = 0, omitidos = 0, eliminados = 0, errores = 0;
  for (const abs of walk(ROOT)) {
    const key = keyParaArchivo(abs);
    try {
      const yaExiste = await existeObjeto(key);
      if (yaExiste) {
        omitidos++;
        console.log(`  · ya en Wasabi   ${key}`);
      } else {
        const buf = fs.readFileSync(abs);
        if (!DRY) {
          await subirObjeto({ key, body: buf, contentType: mime(abs) });
        }
        subidos++;
        console.log(`  ↑ subido        ${key} (${buf.length} B)`);
      }
      // Verificación + borrado local
      if (!DRY) {
        const confirm = await existeObjeto(key);
        if (confirm) {
          fs.unlinkSync(abs);
          eliminados++;
        } else {
          console.warn(`  ! no confirmado tras subir: ${key}`);
        }
      }
    } catch (err) {
      errores++;
      console.error(`  ✗ error en ${abs}:`, err.message);
    }
  }

  // Limpia carpetas vacías
  if (!DRY) {
    function rmEmpty(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) rmEmpty(path.join(dir, entry.name));
      }
      try {
        if (fs.readdirSync(dir).length === 0 && dir !== ROOT) fs.rmdirSync(dir);
      } catch {}
    }
    rmEmpty(ROOT);
  }

  console.log(`\n[migrar] resumen: subidos=${subidos} omitidos=${omitidos} eliminados=${eliminados} errores=${errores}`);
  process.exit(errores > 0 ? 1 : 0);
})();

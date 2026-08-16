const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const configuracion = require('../utils/configuracion');

/**
 * Lista todas las claves de configuración activas.
 * Restringido a super_admin y admin (puede contener datos sensibles como RUC, contacto).
 */
const listar = async (req, res) => {
  try {
    if (!['super_admin', 'admin'].includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const filas = await prisma.tbl_configuracion.findMany({
      where: { estado: 1 },
      orderBy: { clave: 'asc' }
    });
    res.json({ data: filas });
  } catch (err) {
    console.error('[configuracion.listar]', err);
    res.status(500).json({ error: 'Error al listar configuración' });
  }
};

/**
 * Lee una clave específica (acceso amplio: cualquier usuario autenticado puede leer).
 * Útil para que el frontend obtenga IGV_RATE u otros sin necesidad de privilegios.
 */
const obtener = async (req, res) => {
  try {
    const clave = String(req.params.clave || '');
    if (!configuracion.DEFAULTS[clave]) {
      return res.status(404).json({ error: 'Clave no registrada' });
    }
    const valor = await configuracion.obtener(clave);
    res.json({ data: { clave, valor } });
  } catch (err) {
    console.error('[configuracion.obtener]', err);
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
};

// Claves que SOLO edita el super administrador (el resto: super_admin/admin).
// SERVICIO_CIERRE_PLAZO_DIAS define el plazo del técnico para cerrar un servicio
// y es el mismo rol que luego habilita los cierres vencidos caso por caso.
const CLAVES_SOLO_SUPER_ADMIN = ['SERVICIO_CIERRE_PLAZO_DIAS'];

/**
 * Actualiza una clave. Solo super_admin/admin (algunas claves, solo super_admin).
 */
const actualizar = async (req, res) => {
  try {
    if (!['super_admin', 'admin'].includes(req.user.rol_codigo)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const clave = String(req.params.clave || '');
    if (CLAVES_SOLO_SUPER_ADMIN.includes(clave) && req.user.rol_codigo !== 'super_admin') {
      return res.status(403).json({ error: 'Solo el super administrador puede modificar este parámetro' });
    }
    const valor = req.body?.valor;
    if (valor === undefined || valor === null) return res.status(400).json({ error: 'Valor obligatorio' });

    const previo = await prisma.tbl_configuracion.findUnique({ where: { clave } });
    if (!previo) return res.status(404).json({ error: 'Clave no encontrada' });

    const actualizada = await prisma.tbl_configuracion.update({
      where: { clave },
      data: {
        valor: String(valor),
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    configuracion.invalidar(clave);
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_configuracion', id_entidad: actualizada.id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: actualizada, ip: req.ip
    });
    res.json({ data: actualizada });
  } catch (err) {
    console.error('[configuracion.actualizar]', err);
    res.status(500).json({ error: 'Error al actualizar configuración' });
  }
};

module.exports = { listar, obtener, actualizar };

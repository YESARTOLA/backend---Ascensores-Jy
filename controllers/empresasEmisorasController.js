const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');

// Mismos roles que editan la configuración del sistema.
const ROLES_GESTION = ['super_admin', 'admin'];

function puedeGestionar(req) {
  return ROLES_GESTION.includes(req.user.rol_codigo);
}

function textoONull(v) {
  const t = String(v ?? '').trim();
  return t || null;
}

function validarPayload(d) {
  const razon_social = String(d.razon_social || '').trim();
  const ruc = String(d.ruc || '').trim();
  const telefono = String(d.telefono || '').trim();
  const correo = String(d.correo || '').trim();

  if (!razon_social) return 'Razón social obligatoria';
  if (razon_social.length > 200) return 'La razón social excede 200 caracteres';
  if (!/^\d{11}$/.test(ruc)) return 'El RUC debe tener 11 dígitos';
  if (telefono.length > 50) return 'El teléfono excede 50 caracteres';
  if (correo && (correo.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo))) return 'Correo inválido';
  return null;
}

// Solo una empresa activa puede ser la predeterminada: al marcar una, se
// desmarcan las demás dentro de la misma transacción.
async function desmarcarOtrasPredeterminadas(tx, idConservar, userId) {
  await tx.tbl_empresas_emisoras.updateMany({
    where: { es_predeterminada: true, id: { not: idConservar } },
    data: { es_predeterminada: false, user_id_modification: userId, date_time_modification: new Date() }
  });
}

/**
 * Lista las empresas activas, la predeterminada primero. Lectura abierta a
 * cualquier usuario autenticado: razón social y RUC son los datos públicos que
 * se imprimen en los PDF, y el formulario de cotización los necesita.
 */
const listar = async (_req, res) => {
  try {
    const empresas = await prisma.tbl_empresas_emisoras.findMany({
      where: { estado: 1 },
      orderBy: [{ es_predeterminada: 'desc' }, { razon_social: 'asc' }]
    });
    res.json({ data: empresas });
  } catch (err) {
    console.error('[empresasEmisoras.listar]', err);
    res.status(500).json({ error: 'Error al listar empresas emisoras' });
  }
};

const crear = async (req, res) => {
  try {
    if (!puedeGestionar(req)) return res.status(403).json({ error: 'No autorizado' });
    const d = req.body || {};
    const err = validarPayload(d);
    if (err) return res.status(400).json({ error: err });

    const empresa = await prisma.$transaction(async (tx) => {
      // La primera empresa activa es predeterminada aunque no se marque.
      const activas = await tx.tbl_empresas_emisoras.count({ where: { estado: 1 } });
      const predeterminada = Boolean(d.es_predeterminada) || activas === 0;
      const creada = await tx.tbl_empresas_emisoras.create({
        data: {
          razon_social: String(d.razon_social).trim(),
          ruc: String(d.ruc).trim(),
          direccion: textoONull(d.direccion),
          telefono: textoONull(d.telefono),
          correo: textoONull(d.correo),
          es_predeterminada: predeterminada,
          user_id_registration: req.user.id
        }
      });
      if (predeterminada) await desmarcarOtrasPredeterminadas(tx, creada.id, req.user.id);
      return creada;
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_empresas_emisoras', id_entidad: empresa.id,
      accion: 'CREATE', valor_nuevo: empresa, ip: req.ip
    });
    res.status(201).json({ data: empresa });
  } catch (err) {
    console.error('[empresasEmisoras.crear]', err);
    res.status(500).json({ error: 'Error al crear la empresa emisora' });
  }
};

const actualizar = async (req, res) => {
  try {
    if (!puedeGestionar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const d = req.body || {};
    const previo = await prisma.tbl_empresas_emisoras.findUnique({ where: { id } });
    if (!previo || previo.estado !== 1) return res.status(404).json({ error: 'Empresa no encontrada' });

    const err = validarPayload({ ...previo, ...d });
    if (err) return res.status(400).json({ error: err });

    const enviaPredeterminada = Object.prototype.hasOwnProperty.call(d, 'es_predeterminada');
    if (enviaPredeterminada && !d.es_predeterminada && previo.es_predeterminada) {
      return res.status(400).json({ error: 'Siempre debe haber una empresa predeterminada: marca otra como predeterminada.' });
    }
    const marcarPredeterminada = enviaPredeterminada && Boolean(d.es_predeterminada) && !previo.es_predeterminada;

    const empresa = await prisma.$transaction(async (tx) => {
      const actualizada = await tx.tbl_empresas_emisoras.update({
        where: { id },
        data: {
          razon_social: d.razon_social !== undefined ? String(d.razon_social).trim() : previo.razon_social,
          ruc: d.ruc !== undefined ? String(d.ruc).trim() : previo.ruc,
          direccion: d.direccion !== undefined ? textoONull(d.direccion) : previo.direccion,
          telefono: d.telefono !== undefined ? textoONull(d.telefono) : previo.telefono,
          correo: d.correo !== undefined ? textoONull(d.correo) : previo.correo,
          ...(marcarPredeterminada ? { es_predeterminada: true } : {}),
          user_id_modification: req.user.id,
          date_time_modification: new Date()
        }
      });
      if (marcarPredeterminada) await desmarcarOtrasPredeterminadas(tx, id, req.user.id);
      return actualizada;
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_empresas_emisoras', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: empresa, ip: req.ip
    });
    res.json({ data: empresa });
  } catch (err) {
    console.error('[empresasEmisoras.actualizar]', err);
    res.status(500).json({ error: 'Error al actualizar la empresa emisora' });
  }
};

/**
 * Soft-delete: estado = 0. Deja de ofrecerse en cotizaciones nuevas; las ya
 * emitidas con ella siguen imprimiéndola (utils/empresaEmisora.js).
 */
const eliminar = async (req, res) => {
  try {
    if (!puedeGestionar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const previo = await prisma.tbl_empresas_emisoras.findUnique({ where: { id } });
    if (!previo || previo.estado !== 1) return res.status(404).json({ error: 'Empresa no encontrada' });
    if (previo.es_predeterminada) {
      return res.status(400).json({ error: 'No se puede eliminar la empresa predeterminada: marca otra como predeterminada primero.' });
    }
    const empresa = await prisma.tbl_empresas_emisoras.update({
      where: { id },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_empresas_emisoras', id_entidad: id,
      accion: 'DELETE', valor_anterior: previo, valor_nuevo: empresa, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[empresasEmisoras.eliminar]', err);
    res.status(500).json({ error: 'Error al eliminar la empresa emisora' });
  }
};

module.exports = { listar, crear, actualizar, eliminar };

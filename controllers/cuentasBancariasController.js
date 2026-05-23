const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const {
  TIPOS_CUENTA, MONEDAS, METODOS_PAGO,
  TIPOS_CUENTA_CODIGOS, MONEDAS_CODIGOS
} = require('../utils/catalogosBancarios');

const ROLES_GESTION = ['super_admin', 'admin', 'contabilidad'];

function puedeGestionar(req) {
  return ROLES_GESTION.includes(req.user.rol_codigo);
}

function validarPayload(d) {
  const nombre = String(d.nombre || '').trim();
  const banco = String(d.banco || '').trim();
  const tipo_cuenta = String(d.tipo_cuenta || '').trim();
  const moneda = String(d.moneda || '').trim();
  const numero_cuenta = String(d.numero_cuenta || '').trim();
  const titular = String(d.titular || '').trim();

  if (!nombre) return 'Nombre de la cuenta obligatorio';
  if (nombre.length > 120) return 'Nombre de la cuenta excede 120 caracteres';
  if (!banco) return 'Banco obligatorio';
  if (!tipo_cuenta) return 'Tipo de cuenta obligatorio';
  if (!TIPOS_CUENTA_CODIGOS.includes(tipo_cuenta)) {
    return `Tipo de cuenta inválido. Valores permitidos: ${TIPOS_CUENTA_CODIGOS.join(', ')}`;
  }
  if (!moneda) return 'Moneda obligatoria';
  if (!MONEDAS_CODIGOS.includes(moneda)) {
    return `Moneda inválida. Valores permitidos: ${MONEDAS_CODIGOS.join(', ')}`;
  }
  if (!numero_cuenta) return 'Número de cuenta obligatorio';
  if (!titular) return 'Titular obligatorio';
  return null;
}

/**
 * Lista cuentas bancarias activas. Lectura abierta a cualquier usuario
 * autenticado: el PDF de cotización las necesita y otros roles podrían
 * compartir esa misma vista.
 */
const listar = async (_req, res) => {
  try {
    const cuentas = await prisma.tbl_cuentas_bancarias.findMany({
      where: { estado: 1 },
      orderBy: [{ orden: 'asc' }, { id: 'asc' }]
    });
    res.json({ data: cuentas });
  } catch (err) {
    console.error('[cuentasBancarias.listar]', err);
    res.status(500).json({ error: 'Error al listar cuentas bancarias' });
  }
};

const catalogos = (_req, res) => {
  res.json({ data: { tipos_cuenta: TIPOS_CUENTA, monedas: MONEDAS, metodos_pago: METODOS_PAGO } });
};

const crear = async (req, res) => {
  try {
    if (!puedeGestionar(req)) return res.status(403).json({ error: 'No autorizado' });
    const err = validarPayload(req.body);
    if (err) return res.status(400).json({ error: err });

    const orden = Number.isFinite(Number(req.body.orden)) ? Number(req.body.orden) : 0;
    const cuenta = await prisma.tbl_cuentas_bancarias.create({
      data: {
        nombre: String(req.body.nombre).trim(),
        banco: String(req.body.banco).trim(),
        tipo_cuenta: String(req.body.tipo_cuenta).trim(),
        moneda: String(req.body.moneda).trim(),
        numero_cuenta: String(req.body.numero_cuenta).trim(),
        cci: req.body.cci ? String(req.body.cci).trim() : null,
        titular: String(req.body.titular).trim(),
        orden,
        user_id_registration: req.user.id
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cuentas_bancarias', id_entidad: cuenta.id,
      accion: 'CREATE', valor_nuevo: cuenta, ip: req.ip
    });
    res.status(201).json({ data: cuenta });
  } catch (err) {
    console.error('[cuentasBancarias.crear]', err);
    res.status(500).json({ error: 'Error al crear cuenta bancaria' });
  }
};

const actualizar = async (req, res) => {
  try {
    if (!puedeGestionar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const previo = await prisma.tbl_cuentas_bancarias.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Cuenta no encontrada' });

    const err = validarPayload({ ...previo, ...req.body });
    if (err) return res.status(400).json({ error: err });

    const cuenta = await prisma.tbl_cuentas_bancarias.update({
      where: { id },
      data: {
        nombre: req.body.nombre !== undefined ? String(req.body.nombre).trim() : previo.nombre,
        banco: req.body.banco !== undefined ? String(req.body.banco).trim() : previo.banco,
        tipo_cuenta: req.body.tipo_cuenta !== undefined ? String(req.body.tipo_cuenta).trim() : previo.tipo_cuenta,
        moneda: req.body.moneda !== undefined ? String(req.body.moneda).trim() : previo.moneda,
        numero_cuenta: req.body.numero_cuenta !== undefined ? String(req.body.numero_cuenta).trim() : previo.numero_cuenta,
        cci: req.body.cci !== undefined ? (req.body.cci ? String(req.body.cci).trim() : null) : previo.cci,
        titular: req.body.titular !== undefined ? String(req.body.titular).trim() : previo.titular,
        orden: req.body.orden !== undefined && Number.isFinite(Number(req.body.orden))
          ? Number(req.body.orden) : previo.orden,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cuentas_bancarias', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: cuenta, ip: req.ip
    });
    res.json({ data: cuenta });
  } catch (err) {
    console.error('[cuentasBancarias.actualizar]', err);
    res.status(500).json({ error: 'Error al actualizar cuenta bancaria' });
  }
};

/**
 * Soft-delete: estado = 0. La cuenta deja de aparecer en el listado y en
 * los PDFs futuros, pero queda el rastro auditado.
 */
const eliminar = async (req, res) => {
  try {
    if (!puedeGestionar(req)) return res.status(403).json({ error: 'No autorizado' });
    const id = Number(req.params.id);
    const previo = await prisma.tbl_cuentas_bancarias.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const cuenta = await prisma.tbl_cuentas_bancarias.update({
      where: { id },
      data: { estado: 0, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_cuentas_bancarias', id_entidad: id,
      accion: 'DELETE', valor_anterior: previo, valor_nuevo: cuenta, ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[cuentasBancarias.eliminar]', err);
    res.status(500).json({ error: 'Error al eliminar cuenta bancaria' });
  }
};

module.exports = { listar, catalogos, crear, actualizar, eliminar };

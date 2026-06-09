const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { TIPOS_EDIFICIO, normalizarTipoEdificio } = require('../utils/catalogosEdificios');

const trimOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

/**
 * Devuelve `{ lat, lng }` numéricos si el par es válido, o `null` si cualquiera
 * está ausente o fuera de rango.
 */
const parseCoordenadas = (lat, lng) => {
  if (lat === undefined || lat === null || lat === ''
   || lng === undefined || lng === null || lng === '') return null;
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null;
  if (nLat < -90 || nLat > 90) return null;
  if (nLng < -180 || nLng > 180) return null;
  return { lat: nLat, lng: nLng };
};

// Catálogo de tipos de edificio (Edificio / Obra): alimenta el select del form,
// el badge y las etiquetas dinámicas de nombre/dirección del frontend.
const listarTipos = (_req, res) => {
  res.json({ data: TIPOS_EDIFICIO });
};

// Distritos distintos registrados en edificios activos (para datalist/filtro).
const listarDistritos = async (_req, res) => {
  try {
    const filas = await prisma.tbl_edificios.findMany({
      where: { estado: 1 },
      select: { distrito: true },
      distinct: ['distrito'],
      orderBy: { distrito: 'asc' }
    });
    res.json({ data: filas.map(f => f.distrito).filter(Boolean) });
  } catch (err) {
    console.error('[edificios.listarDistritos]', err);
    res.status(500).json({ error: 'Error al listar distritos' });
  }
};

// Edificios de un cliente (o búsqueda global por nombre/distrito con ?q).
const listar = async (req, res) => {
  try {
    const { id_cliente, q } = req.query;
    const where = { estado: 1 };
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (q) where.OR = [
      { nombre: { contains: q, mode: 'insensitive' } },
      { distrito: { contains: q, mode: 'insensitive' } }
    ];
    const data = await prisma.tbl_edificios.findMany({
      where,
      orderBy: { id: 'desc' },
      include: {
        cliente: { select: { id: true, nombre: true } },
        _count: { select: { ascensores: true } }
      }
    });
    res.json({ data });
  } catch (err) {
    console.error('[edificios.listar]', err);
    res.status(500).json({ error: 'Error al listar edificios' });
  }
};

const obtener = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const edificio = await prisma.tbl_edificios.findUnique({
      where: { id },
      include: {
        cliente: { select: { id: true, nombre: true } },
        ascensores: { where: { estado: 1 }, orderBy: { id: 'desc' } }
      }
    });
    if (!edificio) return res.status(404).json({ error: 'Edificio no encontrado' });
    res.json({ data: edificio });
  } catch (err) {
    console.error('[edificios.obtener]', err);
    res.status(500).json({ error: 'Error al obtener edificio' });
  }
};

const crear = async (req, res) => {
  try {
    const d = req.body;
    if (!d.id_cliente) return res.status(400).json({ error: 'Cliente obligatorio' });
    const cliente = await prisma.tbl_clientes.findUnique({ where: { id: Number(d.id_cliente) } });
    if (!cliente || cliente.estado !== 1) return res.status(400).json({ error: 'Cliente no encontrado' });
    if (!d.nombre || !String(d.nombre).trim()) return res.status(400).json({ error: 'El nombre del edificio / obra es obligatorio' });
    if (!d.distrito || !String(d.distrito).trim()) return res.status(400).json({ error: 'Distrito obligatorio' });
    const coords = parseCoordenadas(d.latitud, d.longitud);
    if (!coords) return res.status(400).json({ error: 'Ubicación obligatoria: seleccione un punto en el mapa' });

    const edificio = await prisma.tbl_edificios.create({
      data: {
        id_cliente: Number(d.id_cliente),
        tipo: normalizarTipoEdificio(d.tipo),
        nombre: String(d.nombre).trim(),
        direccion: trimOrNull(d.direccion),
        distrito: String(d.distrito).trim(),
        latitud: coords.lat,
        longitud: coords.lng,
        observaciones: trimOrNull(d.observaciones),
        user_id_registration: req.user.id
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_edificios', id_entidad: edificio.id,
      accion: 'CREATE', valor_nuevo: edificio, ip: req.ip
    });
    res.status(201).json({ data: edificio });
  } catch (err) {
    console.error('[edificios.crear]', err);
    res.status(500).json({ error: 'Error al crear edificio' });
  }
};

const actualizar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = req.body;
    const previo = await prisma.tbl_edificios.findUnique({ where: { id } });
    if (!previo) return res.status(404).json({ error: 'Edificio no encontrado' });

    if (Object.prototype.hasOwnProperty.call(d, 'nombre') && !String(d.nombre || '').trim()) {
      return res.status(400).json({ error: 'El nombre del edificio / obra es obligatorio' });
    }
    let distrito = previo.distrito;
    if (Object.prototype.hasOwnProperty.call(d, 'distrito')) {
      const valor = String(d.distrito || '').trim();
      if (!valor) return res.status(400).json({ error: 'Distrito obligatorio' });
      distrito = valor;
    }
    // Coordenadas: se actualizan solo si el form envía el par; no se permite
    // borrar la ubicación una vez registrada.
    let latitud = previo.latitud;
    let longitud = previo.longitud;
    if (Object.prototype.hasOwnProperty.call(d, 'latitud') || Object.prototype.hasOwnProperty.call(d, 'longitud')) {
      const coords = parseCoordenadas(d.latitud, d.longitud);
      if (!coords) return res.status(400).json({ error: 'Coordenadas inválidas: seleccione un punto en el mapa' });
      latitud = coords.lat;
      longitud = coords.lng;
    }

    const edificio = await prisma.tbl_edificios.update({
      where: { id },
      data: {
        tipo: Object.prototype.hasOwnProperty.call(d, 'tipo') ? normalizarTipoEdificio(d.tipo) : previo.tipo,
        nombre: Object.prototype.hasOwnProperty.call(d, 'nombre') ? String(d.nombre).trim() : previo.nombre,
        direccion: Object.prototype.hasOwnProperty.call(d, 'direccion') ? trimOrNull(d.direccion) : previo.direccion,
        distrito,
        latitud,
        longitud,
        observaciones: Object.prototype.hasOwnProperty.call(d, 'observaciones') ? trimOrNull(d.observaciones) : previo.observaciones,
        user_id_modification: req.user.id,
        date_time_modification: new Date()
      }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_edificios', id_entidad: id,
      accion: 'UPDATE', valor_anterior: previo, valor_nuevo: edificio, ip: req.ip
    });
    res.json({ data: edificio });
  } catch (err) {
    console.error('[edificios.actualizar]', err);
    res.status(500).json({ error: 'Error al actualizar edificio' });
  }
};

const cambiarEstado = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body;
    // No permitir desactivar un edificio con ascensores activos (quedarían
    // huérfanos de ubicación visible).
    if (Number(estado) === 0) {
      const ascensoresActivos = await prisma.tbl_ascensores.count({ where: { id_edificio: id, estado: 1 } });
      if (ascensoresActivos > 0) {
        return res.status(400).json({ error: 'No se puede desactivar: el edificio tiene ascensores activos' });
      }
    }
    const edificio = await prisma.tbl_edificios.update({
      where: { id },
      data: { estado: Number(estado), user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_edificios', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_nuevo: { estado: Number(estado) }, ip: req.ip
    });
    res.json({ data: edificio });
  } catch (err) {
    console.error('[edificios.cambiarEstado]', err);
    res.status(500).json({ error: 'Error al cambiar estado del edificio' });
  }
};

module.exports = { listarTipos, listarDistritos, listar, obtener, crear, actualizar, cambiarEstado };

const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { TIPOS_EDIFICIO, normalizarTipoEdificio } = require('../utils/catalogosEdificios');
const { TIPO_REGISTRO } = require('../utils/clasificacionServicio');
const { bajaEdificioCascadaEnTx, calcularImpactoEdificio } = require('../utils/bajaEdificioCascada');
const { purgarObjetosWasabi, liberarTecnicos } = require('../utils/reversionEliminacion');
const { whereEstadoDesdeFiltro } = require('../utils/filtroEstadoRegistro');
const { veTodoPorEdificio } = require('../utils/visibilidadEdificio');

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
// Además de cliente y conteo de ascensores, deriva por edificio:
//   - tipos_ascensores: tipos distintos de sus ascensores activos (para buscar)
//   - tiene_servicios / tiene_proyectos: si alguno de sus ascensores participa en
//     un servicio o proyecto (tbl_servicios_proyectos.tipo_registro), para filtrar.
const listar = async (req, res) => {
  try {
    const { id_cliente, q, estado } = req.query;
    // El filtro por estado es exclusivo del Super Admin (es el único que ve los
    // edificios eliminados, para poder reactivarlos). Para el resto de roles se
    // ignora y siempre se devuelven los activos.
    const where = whereEstadoDesdeFiltro(veTodoPorEdificio(req.user) ? estado : undefined);
    if (id_cliente) where.id_cliente = Number(id_cliente);
    if (q) where.OR = [
      { nombre: { contains: q, mode: 'insensitive' } },
      { distrito: { contains: q, mode: 'insensitive' } }
    ];
    const filas = await prisma.tbl_edificios.findMany({
      where,
      orderBy: { id: 'desc' },
      include: {
        cliente: { select: { id: true, nombre: true } },
        _count: { select: { ascensores: true } },
        ascensores: {
          where: { estado: 1 },
          select: {
            tipo: true,
            servicios_ascensores: {
              where: { estado: 1, servicio: { estado: 1 } },
              select: { servicio: { select: { tipo_registro: true } } }
            }
          }
        }
      }
    });
    // Derivar campos a partir de los ascensores y descartar el detalle pesado.
    const data = filas.map(({ ascensores, ...edificio }) => {
      const tiposAscensores = [...new Set(ascensores.map(a => a.tipo).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'es'));
      let tieneServicios = false;
      let tieneProyectos = false;
      for (const a of ascensores) {
        for (const sa of a.servicios_ascensores) {
          const tr = sa.servicio?.tipo_registro;
          if (tr === TIPO_REGISTRO.SERVICIO) tieneServicios = true;
          else if (tr === TIPO_REGISTRO.PROYECTO) tieneProyectos = true;
        }
        if (tieneServicios && tieneProyectos) break;
      }
      return { ...edificio, tipos_ascensores: tiposAscensores, tiene_servicios: tieneServicios, tiene_proyectos: tieneProyectos };
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
    const estado = Number(req.body.estado);
    // Baja/alta lógica: el registro nunca se borra, solo alterna `estado`.
    if (estado !== 0 && estado !== 1) {
      return res.status(400).json({ error: 'Estado inválido: use 0 (desactivar) o 1 (reactivar)' });
    }
    const previo = await prisma.tbl_edificios.findUnique({ where: { id }, select: { id: true } });
    if (!previo) return res.status(404).json({ error: 'Edificio no encontrado' });

    // Eliminar (baja lógica) arrastra en cascada ascensores, planes, servicios
    // pendientes, emergencias, correctivos y atenciones rápidas abiertas,
    // conservando todo el historial ejecutado o cobrado. La regla completa vive
    // en utils/bajaEdificioCascada.js. Todo en una transacción.
    if (estado === 0) {
      const { wasabiKeys, tecnicoIds, resumen } = await prisma.$transaction(
        tx => bajaEdificioCascadaEnTx(tx, id, req.user.id, req.ip),
        { timeout: 30000 }
      );
      await registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_edificios', id_entidad: id,
        accion: 'DELETE', valor_nuevo: { estado, impacto: resumen }, ip: req.ip
      });
      await purgarObjetosWasabi(wasabiKeys);
      await liberarTecnicos(tecnicoIds, -1);
      const edificio = await prisma.tbl_edificios.findUnique({ where: { id } });
      return res.json({ data: edificio, impacto: resumen });
    }

    // Reactivar solo reabre el edificio: sus ascensores, planes y servicios
    // dados de baja no se resucitan automáticamente (se reactivan uno a uno si
    // se requiere), porque al reabrirlo no hay garantía de su estado real.
    const edificio = await prisma.tbl_edificios.update({
      where: { id },
      data: { estado, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_edificios', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_nuevo: { estado }, ip: req.ip
    });
    res.json({ data: edificio });
  } catch (err) {
    console.error('[edificios.cambiarEstado]', err);
    res.status(500).json({ error: 'Error al cambiar estado del edificio' });
  }
};

// [MERGE] Cambio de estado (activar/inactivar) masivo de todos los edificios de
// un cliente. Endpoint traído del repo remoto; usado desde la ficha del cliente.
const cambiarEstadoPorCliente = async (req, res) => {
  try {
    const idCliente = Number(req.params.idCliente);
    const estado = Number(req.body.estado) === 1 ? 1 : 0;
    const cliente = await prisma.tbl_clientes.findUnique({ where: { id: idCliente }, select: { id: true } });
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Solo se tocan los edificios que cambian de estado (evita auditoría de ruido).
    const aCambiar = await prisma.tbl_edificios.findMany({
      where: { id_cliente: idCliente, estado: estado === 1 ? 0 : 1 },
      select: { id: true }
    });
    if (aCambiar.length === 0) return res.json({ data: { afectados: 0 } });

    const ids = aCambiar.map(e => e.id);

    // Eliminar en masa usa exactamente la misma cascada que eliminar uno a uno:
    // este endpoint no puede ser una puerta trasera que deje ascensores,
    // servicios o emergencias vivos colgando de un edificio eliminado.
    if (estado === 0) {
      const wasabiKeys = [];
      const tecnicoIds = [];
      const resumenes = new Map();
      await prisma.$transaction(async (tx) => {
        for (const id of ids) {
          const r = await bajaEdificioCascadaEnTx(tx, id, req.user.id, req.ip);
          wasabiKeys.push(...r.wasabiKeys);
          tecnicoIds.push(...r.tecnicoIds);
          resumenes.set(id, r.resumen);
        }
      }, { timeout: 60000 });
      await Promise.all(ids.map(id => registrarAuditoria({
        id_usuario: req.user.id, entidad: 'tbl_edificios', id_entidad: id,
        accion: 'DELETE', valor_nuevo: { estado, impacto: resumenes.get(id) }, ip: req.ip
      })));
      await purgarObjetosWasabi(wasabiKeys);
      await liberarTecnicos(tecnicoIds, -1);
      return res.json({ data: { afectados: ids.length } });
    }

    await prisma.tbl_edificios.updateMany({
      where: { id: { in: ids } },
      data: { estado, user_id_modification: req.user.id, date_time_modification: new Date() }
    });
    await Promise.all(ids.map(id => registrarAuditoria({
      id_usuario: req.user.id, entidad: 'tbl_edificios', id_entidad: id,
      accion: 'STATUS_CHANGE', valor_nuevo: { estado }, ip: req.ip
    })));
    res.json({ data: { afectados: ids.length } });
  } catch (err) {
    console.error('[edificios.cambiarEstadoPorCliente]', err);
    res.status(500).json({ error: 'Error al cambiar el estado de los edificios del cliente' });
  }
};

// Vista previa del impacto de eliminar un edificio: alimenta el modal de doble
// confirmación para que el usuario vea exactamente qué se da de baja y qué se
// conserva ANTES de escribir la palabra clave. Solo lee, no muta nada, y usa la
// misma selección que ejecuta la cascada.
const impactoEliminacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const edificio = await prisma.tbl_edificios.findUnique({
      where: { id }, select: { id: true, nombre: true, estado: true }
    });
    if (!edificio) return res.status(404).json({ error: 'Edificio no encontrado' });
    const impacto = await calcularImpactoEdificio(prisma, id);
    res.json({ data: { edificio, ...impacto } });
  } catch (err) {
    console.error('[edificios.impactoEliminacion]', err);
    res.status(500).json({ error: 'Error al calcular el impacto de la eliminación' });
  }
};

module.exports = {
  listarTipos,
  listarDistritos,
  listar,
  obtener,
  crear,
  actualizar,
  cambiarEstado,
  cambiarEstadoPorCliente,
  impactoEliminacion
};

/**
 * Fusiona los DOS planes de mantenimiento de Gardenias (GAR-1 = plan #2,
 * GAR-2 = plan #104) en UN SOLO plan multi-ascensor con total 800/periodo
 * (400 por ascensor), bajo el modelo nuevo de facturación por periodo (un cobro
 * por plan que crece por periodo aprobado).
 *
 * Qué hace (idempotente, marcado con [FUSION-GARDENIAS-v1]):
 *   1. Configura el precio del subtipo Mantenimiento en GAR-1 y GAR-2 a 400 PEN
 *      (tbl_ascensores_precios) — no existían.
 *   2. Crea el plan nuevo VÍA API (POST /mantenimientos) para reutilizar EXACTA
 *      la lógica de creación: cobro único vacío, materialización de la 1ª
 *      ocurrencia (2 servicios) y eventos futuros.
 *   3. Da de baja LÓGICA a los planes viejos (2 y 104): estado_plan='inactivo' y
 *      baja lógica de sus eventos de calendario futuros NO materializados.
 *      NO toca sus servicios pasados ni sus cobros/facturas históricos.
 *
 * Uso:
 *   node scripts/fusionarGardenias.js
 * Variables opcionales:
 *   API_BASE        (default http://localhost:4000)
 *   FECHA_INICIO    (YYYY-MM-DD; default: hoy en Lima)
 *
 * IMPORTANTE: el backend debe estar corriendo (usa la API para crear el plan).
 * Corre primero en la copia local antes de producción.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { registrarAuditoria } = require('../utils/auditoria');
const { ymdLima } = require('../utils/tiempo');

const CLIENTE = 49;              // JUNTA DE PROPIETARIOS LAS GARDENIAS
const TIPO_SERVICIO = 22;        // Servicio Mantenimiento
const ASC = [3, 4];             // GAR-1, GAR-2
const MONTO_POR_ASCENSOR = 400;  // total 800/periodo
const MONEDA = 'PEN';
const PLANES_VIEJOS = [2, 104];
const MARCADOR = '[FUSION-GARDENIAS-v1]';
const API_BASE = process.env.API_BASE || 'http://localhost:4000';

function tokenSuperadmin() {
  if (!process.env.JWT_SECRET) throw new Error('Falta JWT_SECRET en el entorno');
  return jwt.sign(
    { id: 1, correo: 'superadmin@ascensoresjy.com', id_rol: 1, rol_codigo: 'super_admin',
      id_tecnico: null, acceso_servicios: 1, acceso_proyectos: 1, acceso_edificios: 1, acceso_obras: 1 },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
}

(async () => {
  // 0. Verificaciones básicas
  const cliente = await prisma.tbl_clientes.findUnique({ where: { id: CLIENTE }, select: { id: true, nombre: true } });
  if (!cliente) throw new Error(`Cliente ${CLIENTE} no encontrado`);
  const ascensores = await prisma.tbl_ascensores.findMany({ where: { id: { in: ASC }, estado: 1 }, select: { id: true, codigo: true } });
  if (ascensores.length !== ASC.length) throw new Error('No se encontraron ambos ascensores GAR-1/GAR-2 activos');
  console.log(`Cliente: ${cliente.nombre} · ascensores: ${ascensores.map(a => a.codigo).join(', ')}`);

  // 1. Idempotencia: ¿ya existe el plan fusionado?
  const existente = await prisma.tbl_mantenimientos_planes.findFirst({
    where: { id_cliente: CLIENTE, estado: 1, observaciones: { contains: MARCADOR } },
    select: { id: true }
  });
  if (existente) {
    console.log(`Ya existe el plan fusionado (#${existente.id}). Nada que hacer.`);
    await prisma.$disconnect();
    return;
  }

  // 2. Precio 400 por ascensor para el subtipo (upsert)
  for (const idAsc of ASC) {
    await prisma.tbl_ascensores_precios.upsert({
      where: { id_ascensor_id_tipo_servicio: { id_ascensor: idAsc, id_tipo_servicio: TIPO_SERVICIO } },
      update: { precio: MONTO_POR_ASCENSOR, moneda: MONEDA, estado: 1 },
      create: { id_ascensor: idAsc, id_tipo_servicio: TIPO_SERVICIO, precio: MONTO_POR_ASCENSOR, moneda: MONEDA, estado: 1 }
    });
  }
  console.log(`Precios configurados: ${MONTO_POR_ASCENSOR} ${MONEDA} c/u.`);

  // 3. Crear el plan nuevo VÍA API (reutiliza la lógica real de creación)
  const fechaInicio = process.env.FECHA_INICIO || ymdLima(new Date());
  const payload = {
    id_cliente: CLIENTE,
    id_tipo_servicio: TIPO_SERVICIO,
    ascensores: ASC.map(id => ({ id_ascensor: id })),
    tipo_plan: 'continuo',
    frecuencia: 'mensual',
    cantidad_mantenimientos: 7,
    cantidad_mantenimientos_gratuitos: 0,
    fecha_inicio: fechaInicio,
    hora_programada: '09:00',
    observaciones: `${MARCADOR} Fusión de los planes GAR-1 (#2) y GAR-2 (#104) en un solo plan multi-ascensor (400 c/u, total 800/periodo).`
  };
  const res = await fetch(`${API_BASE}/api/mantenimientos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenSuperadmin()}` },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Fallo al crear el plan (HTTP ${res.status}): ${body.error || JSON.stringify(body)}`);
  const nuevoPlan = body.data?.plan || body.data;
  console.log(`Plan nuevo creado: #${nuevoPlan.id} (${nuevoPlan.servicios?.length ?? '?'} servicios 1ª ocurrencia, ${nuevoPlan.eventos_futuros ?? '?'} eventos futuros).`);

  // 4. Baja lógica de los planes viejos (sin tocar servicios/cobros históricos)
  await prisma.$transaction(async (tx) => {
    await tx.tbl_mantenimientos_planes.updateMany({
      where: { id: { in: PLANES_VIEJOS } },
      data: { estado_plan: 'inactivo', date_time_modification: new Date() }
    });
    // Solo eventos de calendario FUTUROS no materializados (sin servicio): baja lógica.
    const evt = await tx.tbl_calendario_eventos.updateMany({
      where: { id_mantenimiento_plan: { in: PLANES_VIEJOS }, id_servicio: null, estado: 1 },
      data: { estado: 0, date_time_modification: new Date() }
    });
    console.log(`Planes viejos ${PLANES_VIEJOS.join(', ')} inactivados; ${evt.count} eventos futuros dados de baja.`);
  });

  await registrarAuditoria({
    id_usuario: 1, entidad: 'tbl_mantenimientos_planes', id_entidad: nuevoPlan.id,
    accion: 'CREATE',
    valor_nuevo: { fusion: MARCADOR, plan_nuevo: nuevoPlan.id, reemplaza: PLANES_VIEJOS, ascensores: ASC, monto_por_ascensor: MONTO_POR_ASCENSOR }
  });

  console.log('\n✔ Fusión Gardenias completada.');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('Error en la fusión:', e.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});

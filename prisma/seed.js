/**
 * SEED COMPLETO Ascensores Jy
 * Genera data 100% integrada de inicio a fin cubriendo TODOS los estados
 * de servicios, cobros, facturas, checklists, emergencias, leads, atenciones,
 * entregas, mantenimientos, evidencias, guías, recordatorios y auditoría.
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { ESTADO_GUIA_ADJUNTA, ESTADO_GUIA_OBSERVADA } = require('../utils/estadoGuia');
const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────
// Utilidades de fecha
// ─────────────────────────────────────────────────────────────────────
const HOY = new Date(); HOY.setHours(0, 0, 0, 0);
const dias = (n) => new Date(Date.now() + n * 24 * 3600 * 1000);
const iso = (d) => d.toISOString().substring(0, 10);
const hoyStr = iso(HOY);

// ─────────────────────────────────────────────────────────────────────
// Helpers de auditoría e historial
// ─────────────────────────────────────────────────────────────────────
async function audit(entidad, id_entidad, accion, valor_nuevo = null, id_usuario = 1) {
  await prisma.tbl_auditoria.create({
    data: { id_usuario, entidad, id_entidad, accion, valor_nuevo, ip: '127.0.0.1' }
  });
}

async function transicionEstado(id_servicio, estados, id_usuario = 1, baseDate = new Date()) {
  // estados = ['Pendiente', 'Asignado', ...]
  let prev = null;
  for (let i = 0; i < estados.length; i++) {
    const cuando = new Date(baseDate.getTime() + i * 60 * 60 * 1000); // 1h entre transiciones
    await prisma.tbl_servicios_estados_historial.create({
      data: {
        id_servicio,
        estado_anterior: prev,
        estado_nuevo: estados[i],
        cambiado_por: id_usuario,
        fecha_cambio: cuando
      }
    });
    prev = estados[i];
  }
}

async function eventoCalendario(servicio, fecha, hora, tipoEvento = 'servicio', color = '#0ea5e9') {
  await prisma.tbl_calendario_eventos.create({
    data: {
      id_servicio: servicio.id,
      titulo: `${servicio.codigo} – ${servicio.titulo}`,
      tipo_evento: tipoEvento,
      fecha_inicio: new Date(`${fecha}T${hora || '09:00'}:00`),
      estado_evento: servicio.estado_servicio === 'Cancelado' ? 'cancelado'
        : servicio.estado_servicio.startsWith('Finalizado') || ['Cerrado', 'Cobrado total', 'Facturado'].includes(servicio.estado_servicio) ? 'finalizado'
        : 'programado',
      color
    }
  });
}

async function historialCliente(id_cliente, id_servicio, tipo_evento, descripcion, fecha = new Date()) {
  await prisma.tbl_clientes_historial.create({
    data: { id_cliente, id_servicio, tipo_evento, descripcion, fecha_evento: fecha, creado_por: 1 }
  });
}

async function historialAscensor(id_ascensor, id_servicio, tipo_evento, descripcion, fecha = new Date()) {
  await prisma.tbl_ascensores_historial.create({
    data: { id_ascensor, id_servicio, tipo_evento, descripcion, fecha_evento: fecha, creado_por: 1 }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Roles y permisos
// ─────────────────────────────────────────────────────────────────────
async function upsertRol(codigo, nombre, descripcion) {
  return prisma.tbl_roles.upsert({
    where: { codigo }, update: { nombre, descripcion },
    create: { codigo, nombre, descripcion }
  });
}

async function upsertPermiso(codigo, nombre, recurso, tipo) {
  return prisma.tbl_permisos.upsert({
    where: { codigo }, update: { nombre, recurso, tipo },
    create: { codigo, nombre, recurso, tipo }
  });
}

async function main() {
  console.log('🌱 Iniciando seed Ascensores Jy (completo)…');

  // ─── ROLES ────────────────────────────────────────────────────────
  const rolSuper = await upsertRol('super_admin', 'Super Administrador', 'Control total');
  const rolAdmin = await upsertRol('admin', 'Administrador', 'Operación');
  const rolCoord = await upsertRol('coordinador', 'Coordinador', 'Coordinación diaria');
  const rolTec = await upsertRol('tecnico', 'Técnico', 'Ejecución técnica en campo');
  const rolCont = await upsertRol('contabilidad', 'Contabilidad', 'Cobros y facturación');

  // ─── PERMISOS ─────────────────────────────────────────────────────
  const recursos = [
    ['clientes', 'Clientes'], ['ascensores', 'Ascensores'], ['tecnicos', 'Técnicos'],
    ['tipos_servicio', 'Tipos de servicio'], ['servicios', 'Servicios/Proyectos'],
    ['cobros', 'Gestión de cobros'], ['facturas', 'Facturas'],
    ['emergencias', 'Emergencias'], ['mantenimientos', 'Mantenimientos'],
    ['leads', 'Leads'], ['atenciones_rapidas', 'Atención rápida'],
    ['calendario', 'Calendario'], ['reportes', 'Reportes'],
    ['usuarios', 'Usuarios'], ['auditoria', 'Auditoría'], ['entregas', 'Entregas']
  ];
  const acciones = ['ver', 'crear', 'editar', 'eliminar'];
  const permisos = [];
  for (const [rec, nomRec] of recursos) {
    for (const acc of acciones) {
      permisos.push(await upsertPermiso(`${rec}.${acc}`, `${acc} ${nomRec}`, rec, acc));
    }
  }
  permisos.push(await upsertPermiso('precios.ver', 'Ver precios internos', 'precios', 'ver'));

  async function asignarPermisos(idRol, codigos) {
    for (const cod of codigos) {
      const p = permisos.find(x => x.codigo === cod);
      if (!p) continue;
      await prisma.tbl_roles_permisos.upsert({
        where: { id_rol_id_permiso: { id_rol: idRol, id_permiso: p.id } },
        update: { estado: 1 },
        create: { id_rol: idRol, id_permiso: p.id }
      });
    }
  }

  await asignarPermisos(rolSuper.id, permisos.map(p => p.codigo));
  await asignarPermisos(rolAdmin.id, permisos.filter(p => !p.codigo.startsWith('usuarios.') || p.codigo === 'usuarios.ver').map(p => p.codigo));
  await asignarPermisos(rolCoord.id, [
    'clientes.ver', 'clientes.crear', 'clientes.editar',
    'ascensores.ver', 'ascensores.crear', 'ascensores.editar',
    'tecnicos.ver', 'tipos_servicio.ver',
    'servicios.ver', 'servicios.crear', 'servicios.editar',
    'emergencias.ver', 'emergencias.crear', 'emergencias.editar',
    'mantenimientos.ver', 'mantenimientos.crear', 'mantenimientos.editar',
    'leads.ver', 'leads.crear', 'leads.editar',
    'atenciones_rapidas.ver', 'atenciones_rapidas.crear', 'atenciones_rapidas.editar',
    'calendario.ver', 'reportes.ver', 'entregas.ver'
  ]);
  await asignarPermisos(rolTec.id, [
    'clientes.ver', 'ascensores.ver', 'servicios.ver', 'servicios.editar',
    'calendario.ver'
  ]);
  await asignarPermisos(rolCont.id, [
    'clientes.ver', 'ascensores.ver', 'tipos_servicio.ver',
    'servicios.ver', 'cobros.ver', 'cobros.crear', 'cobros.editar',
    'facturas.ver', 'facturas.crear', 'facturas.editar',
    'reportes.ver', 'precios.ver',
    'emergencias.ver', 'mantenimientos.ver', 'entregas.ver'
  ]);

  // ─── TÉCNICOS ─────────────────────────────────────────────────────
  const tecs = [
    { nombre: 'Carlos Medina', telefono: '987111111', documento: '40111222', especialidades: 'Mantenimiento preventivo, reparación eléctrica', estado_operativo: 'Disponible' },
    { nombre: 'Juan Pérez', telefono: '987222222', documento: '40222333', especialidades: 'Emergencias, reparación mecánica', estado_operativo: 'En servicio' },
    { nombre: 'Marco Salazar', telefono: '987333333', documento: '40333444', especialidades: 'Instalación, revisión técnica', estado_operativo: 'Disponible' },
    { nombre: 'Diego Flores', telefono: '987444444', documento: '40444555', especialidades: 'Mantenimiento preventivo, emergencias', estado_operativo: 'Ocupado' },
    { nombre: 'Andrés Castro', telefono: '987555555', documento: '40555666', especialidades: 'Reparación eléctrica, inspecciones', estado_operativo: 'Disponible' },
    { nombre: 'Roberto Vargas', telefono: '987666666', documento: '40666777', especialidades: 'Especialista en proyectos grandes', estado_operativo: 'Suspendido', observaciones: 'Suspendido por incumplimiento de protocolo en abr-2026' },
    { nombre: 'Esteban Quispe', telefono: '987777777', documento: '40777888', especialidades: 'Ex-técnico, ya no presta servicios', estado_operativo: 'Inactivo', observaciones: 'Desvinculado en 2025, mantenido para historial' }
  ];
  const tecnicos = [];
  for (const t of tecs) {
    let tec = await prisma.tbl_tecnicos.findFirst({ where: { nombre: t.nombre } });
    if (!tec) tec = await prisma.tbl_tecnicos.create({ data: t });
    tecnicos.push(tec);
  }

  // ─── USUARIOS ─────────────────────────────────────────────────────
  const hash = (pwd) => bcrypt.hashSync(pwd, 10);
  const usuariosDemo = [
    { nombres: 'Super Admin', correo: 'superadmin@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolSuper.id },
    { nombres: 'Administrador Operativo', correo: 'admin@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolAdmin.id },
    { nombres: 'Coordinadora Lucía', correo: 'coordinador@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolCoord.id },
    { nombres: 'Contabilidad Sofía', correo: 'contabilidad@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolCont.id },
    { nombres: 'Carlos Medina', correo: 'carlos@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolTec.id, id_tecnico: tecnicos[0].id },
    { nombres: 'Juan Pérez', correo: 'juan@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolTec.id, id_tecnico: tecnicos[1].id },
    { nombres: 'Marco Salazar', correo: 'marco@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolTec.id, id_tecnico: tecnicos[2].id },
    { nombres: 'Diego Flores', correo: 'diego@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolTec.id, id_tecnico: tecnicos[3].id },
    { nombres: 'Andrés Castro', correo: 'andres@ascensoresjy.com', contrasena: hash('admin123'), id_rol: rolTec.id, id_tecnico: tecnicos[4].id }
  ];
  for (const u of usuariosDemo) {
    const exists = await prisma.tbl_usuarios.findUnique({ where: { correo: u.correo } });
    if (!exists) await prisma.tbl_usuarios.create({ data: u });
  }
  const usrSuper = await prisma.tbl_usuarios.findUnique({ where: { correo: 'superadmin@ascensoresjy.com' } });
  const usrAdmin = await prisma.tbl_usuarios.findUnique({ where: { correo: 'admin@ascensoresjy.com' } });
  const usrCoord = await prisma.tbl_usuarios.findUnique({ where: { correo: 'coordinador@ascensoresjy.com' } });
  const usrCont = await prisma.tbl_usuarios.findUnique({ where: { correo: 'contabilidad@ascensoresjy.com' } });

  // ─── TIPOS DE ASCENSOR ────────────────────────────────────────────
  // Catálogo gestionable desde la pantalla "Tipos de ascensor". Se siembra
  // un set inicial alineado con los tipos previamente hardcodeados; admins
  // pueden agregar, editar o desactivar más.
  const tiposAscensor = [
    { nombre: 'Pasajeros',      orden: 10, descripcion: 'Ascensor para transporte de pasajeros' },
    { nombre: 'Camillero',      orden: 20, descripcion: 'Ascensor adaptado para camillas / uso hospitalario' },
    { nombre: 'Carga',          orden: 30, descripcion: 'Ascensor destinado a transporte de carga' },
    { nombre: 'Panorámico',     orden: 40, descripcion: 'Ascensor con cabina panorámica' },
    { nombre: 'Discapacitados', orden: 50, descripcion: 'Ascensor con accesibilidad para personas con discapacidad' },
    { nombre: 'Otros',          orden: 99, descripcion: 'Otros tipos no clasificados' }
  ];
  for (const t of tiposAscensor) {
    const existe = await prisma.tbl_tipos_ascensor.findFirst({ where: { nombre: t.nombre } });
    if (!existe) await prisma.tbl_tipos_ascensor.create({ data: t });
  }
  // Asegurar que tipos ya existentes en ascensores (pero no en el catálogo)
  // queden registrados, para que el dropdown no esconda valores legítimos
  // de datos heredados.
  const existentesAscensores = await prisma.tbl_ascensores.findMany({
    where: { estado: 1, tipo: { not: null } },
    select: { tipo: true },
    distinct: ['tipo']
  });
  for (const fila of existentesAscensores) {
    if (!fila.tipo) continue;
    const yaEsta = await prisma.tbl_tipos_ascensor.findFirst({ where: { nombre: fila.tipo } });
    if (!yaEsta) await prisma.tbl_tipos_ascensor.create({ data: { nombre: fila.tipo, orden: 90 } });
  }

  // ─── TIPOS DE SERVICIO ────────────────────────────────────────────
  const tiposServicio = [
    { nombre: 'Mantenimiento preventivo mensual', categoria: 'Mantenimiento preventivo', descripcion: 'Mantenimiento programado mensual con rutinas estándar' },
    { nombre: 'Mantenimiento correctivo', categoria: 'Mantenimiento correctivo', descripcion: 'Corrección de fallas detectadas' },
    { nombre: 'Reparación eléctrica', categoria: 'Reparación', descripcion: 'Reparación de sistemas eléctricos y control' },
    { nombre: 'Reparación mecánica', categoria: 'Reparación', descripcion: 'Reparación mecánica de tracción y poleas' },
    { nombre: 'Emergencia ascensor', categoria: 'Emergencia', descripcion: 'Atención de emergencia 24/7' },
    { nombre: 'Revisión técnica', categoria: 'Revisión', descripcion: 'Revisión técnica programada' },
    { nombre: 'Inspección anual', categoria: 'Inspección', descripcion: 'Inspección anual obligatoria' },
    { nombre: 'Instalación nueva', categoria: 'Instalación', descripcion: 'Instalación de equipo nuevo' },
    { nombre: 'Proyecto ascensor', categoria: 'Proyecto', descripcion: 'Proyecto integral llave en mano' }
  ];
  const tipos = [];
  for (const t of tiposServicio) {
    let tip = await prisma.tbl_tipos_servicio.findFirst({ where: { nombre: t.nombre } });
    if (!tip) tip = await prisma.tbl_tipos_servicio.create({ data: t });
    tipos.push(tip);
  }

  // Vincular técnicos a tipos de servicio (tabla puente)
  const vinculaciones = [
    [0, 0], [0, 4], [3, 0], [3, 4], // mantenimiento + emergencias
    [1, 1], [1, 3], [4, 1], // correctivo y mecánica
    [0, 2], [4, 2], // eléctrica
    [2, 5], [2, 6], [2, 7], [2, 8], // revisión, inspección, instalación, proyecto
    [4, 5], [4, 6]
  ];
  for (const [tec, tip] of vinculaciones) {
    await prisma.tbl_tipos_servicio_tecnicos.upsert({
      where: { id_tipo_servicio_id_tecnico: { id_tipo_servicio: tipos[tip].id, id_tecnico: tecnicos[tec].id } },
      update: { estado: 1 },
      create: { id_tipo_servicio: tipos[tip].id, id_tecnico: tecnicos[tec].id }
    });
  }

  // ─── CLIENTES ─────────────────────────────────────────────────────
  const clientesDemo = [
    { tipo_documento: 'RUC', numero_documento: '20547896321', nombre: 'Edificio Las Palmeras', telefono: '987654321', whatsapp: '987654321', correo: 'administracion@laspalmeras.pe', distrito: 'Miraflores', direccion: 'Av. Pardo 450', contacto_principal_nombre: 'Luis Ramírez', observaciones: 'Cliente premium - 2 ascensores' },
    { tipo_documento: 'RUC', numero_documento: '20458963217', nombre: 'Clínica San Rafael', telefono: '976543210', whatsapp: '976543210', correo: 'mantenimiento@sanrafael.pe', distrito: 'San Isidro', direccion: 'Av. Javier Prado 1250', contacto_principal_nombre: 'Karla Mendoza', observaciones: 'Hospitalario - prioridad alta' },
    { tipo_documento: 'RUC', numero_documento: '20632547891', nombre: 'Condominio Vista Norte', telefono: '965432109', whatsapp: '965432109', correo: 'admin@vistanorte.pe', distrito: 'Los Olivos', direccion: 'Av. Universitaria 3350', contacto_principal_nombre: 'Miguel Torres' },
    { tipo_documento: 'RUC', numero_documento: '20147896523', nombre: 'Galería Comercial Centro Lima', telefono: '954321098', whatsapp: '954321098', correo: 'galeria@centrolima.pe', distrito: 'Cercado de Lima', direccion: 'Jr. Ayacucho 780', contacto_principal_nombre: 'Rosa Quispe' },
    { tipo_documento: 'RUC', numero_documento: '20789632145', nombre: 'Hotel Costa Marina', telefono: '943210987', whatsapp: '943210987', correo: 'mantenimiento@costamarina.com', distrito: 'Miraflores', direccion: 'Malecón Cisneros 1180', contacto_principal_nombre: 'Daniela Salinas', observaciones: 'Hotel 4 estrellas, 2 ascensores' },
    { tipo_documento: 'RUC', numero_documento: '20369852741', nombre: 'Banco Crédito - Sucursal San Borja', telefono: '932109876', whatsapp: '932109876', correo: 'inmuebles@bcp.pe', distrito: 'San Borja', direccion: 'Av. Aviación 2450', contacto_principal_nombre: 'Jorge Alarcón', observaciones: 'Contrato anual de mantenimiento' },
    { tipo_documento: 'RUC', numero_documento: '20963258741', nombre: 'Universidad Pacífico Norte', telefono: '921098765', whatsapp: '921098765', correo: 'logistica@upn.edu.pe', distrito: 'Santiago de Surco', direccion: 'Av. Primavera 870', contacto_principal_nombre: 'Patricia Rivera', observaciones: '2 ascensores nuevos en proyecto' },
    { tipo_documento: 'RUC', numero_documento: '20741852963', nombre: 'Plaza Comercial Aurora', telefono: '910987654', whatsapp: '910987654', correo: 'admon@plazaurora.pe', distrito: 'La Molina', direccion: 'Av. Javier Prado Este 4250', contacto_principal_nombre: 'Fernando Quiroz' }
  ];
  const clientes = [];
  for (const c of clientesDemo) {
    let cl = await prisma.tbl_clientes.findFirst({ where: { numero_documento: c.numero_documento } });
    if (!cl) {
      cl = await prisma.tbl_clientes.create({ data: { ...c, user_id_registration: usrAdmin.id } });
      await audit('tbl_clientes', cl.id, 'CREATE', cl, usrAdmin.id);
    }
    clientes.push(cl);
  }

  // ─── ASCENSORES ───────────────────────────────────────────────────
  const ascensoresDemo = [
    { codigo: 'ASC-JY-001', id_cliente: clientes[0].id, tipo: 'Pasajeros', marca: 'Otis', modelo: 'Gen2', estado_operativo: 'Operativo', ubicacion: 'Torre A', capacidad: '8 personas', pisos: 12, anio_aproximado: 2018, fecha_instalacion: new Date('2018-06-15'), proximo_mantenimiento: dias(15) },
    { codigo: 'ASC-JY-002', id_cliente: clientes[0].id, tipo: 'Pasajeros', marca: 'Schindler', modelo: '3300', estado_operativo: 'En observación', ubicacion: 'Torre B', capacidad: '6 personas', pisos: 10, anio_aproximado: 2017, fecha_instalacion: new Date('2017-09-10'), proximo_mantenimiento: dias(5), observaciones: 'Ruido detectado en sistema de poleas' },
    { codigo: 'ASC-JY-003', id_cliente: clientes[1].id, tipo: 'Camillero', marca: 'Mitsubishi', modelo: 'NexWay', estado_operativo: 'Operativo', ubicacion: 'Zona hospitalización', capacidad: '12 personas', pisos: 6, anio_aproximado: 2019, fecha_instalacion: new Date('2019-03-22'), proximo_mantenimiento: dias(20) },
    { codigo: 'ASC-JY-004', id_cliente: clientes[2].id, tipo: 'Pasajeros', marca: 'Hyundai', modelo: 'LXVF', estado_operativo: 'Operativo', ubicacion: 'Torre 1', capacidad: '8 personas', pisos: 15, anio_aproximado: 2020, fecha_instalacion: new Date('2020-01-12'), proximo_mantenimiento: dias(2) },
    { codigo: 'ASC-JY-005', id_cliente: clientes[3].id, tipo: 'Carga', marca: 'ThyssenKrupp', modelo: 'Evolution', estado_operativo: 'Fuera de servicio', ubicacion: 'Zona almacén', capacidad: '1500 kg', pisos: 4, anio_aproximado: 2015, fecha_instalacion: new Date('2015-07-30'), observaciones: 'Fuera de servicio por falla mayor en motor' },
    { codigo: 'ASC-JY-006', id_cliente: clientes[4].id, tipo: 'Pasajeros', marca: 'KONE', modelo: 'MonoSpace', estado_operativo: 'Operativo', ubicacion: 'Lobby principal', capacidad: '10 personas', pisos: 14, anio_aproximado: 2021, fecha_instalacion: new Date('2021-04-05'), proximo_mantenimiento: dias(10) },
    { codigo: 'ASC-JY-007', id_cliente: clientes[4].id, tipo: 'Pasajeros', marca: 'KONE', modelo: 'MiniSpace', estado_operativo: 'En reparación', ubicacion: 'Ala sur', capacidad: '6 personas', pisos: 8, anio_aproximado: 2019, fecha_instalacion: new Date('2019-11-18'), observaciones: 'Reparación de cable de tracción en curso' },
    { codigo: 'ASC-JY-008', id_cliente: clientes[5].id, tipo: 'Pasajeros', marca: 'Otis', modelo: 'SkyRise', estado_operativo: 'Operativo', ubicacion: 'Sucursal San Borja', capacidad: '10 personas', pisos: 6, anio_aproximado: 2022, fecha_instalacion: new Date('2022-02-08'), proximo_mantenimiento: dias(25) },
    { codigo: 'ASC-JY-009', id_cliente: clientes[6].id, tipo: 'Pasajeros', marca: 'Schindler', modelo: '5500', estado_operativo: 'Operativo', ubicacion: 'Edificio A', capacidad: '13 personas', pisos: 9, anio_aproximado: 2022, fecha_instalacion: new Date('2022-08-20'), proximo_mantenimiento: dias(8) },
    { codigo: 'ASC-JY-010', id_cliente: clientes[6].id, tipo: 'Pasajeros', marca: 'Mitsubishi', modelo: 'DiamondTrac', estado_operativo: 'En instalación', ubicacion: 'Edificio B', capacidad: '15 personas', pisos: 10, anio_aproximado: 2026, observaciones: 'Proyecto de instalación en curso' },
    { codigo: 'ASC-JY-011', id_cliente: clientes[7].id, tipo: 'Pasajeros', marca: 'Hyundai', modelo: 'Luxen', estado_operativo: 'Operativo', ubicacion: 'Bloque comercial', capacidad: '8 personas', pisos: 5, anio_aproximado: 2020, fecha_instalacion: new Date('2020-10-12'), proximo_mantenimiento: dias(30) },
    { codigo: 'ASC-JY-012', id_cliente: clientes[7].id, tipo: 'Pasajeros', marca: 'Otis', modelo: 'Gen2 Premier', estado_operativo: 'Inactivo', ubicacion: 'Bloque oficinas', capacidad: '10 personas', pisos: 7, anio_aproximado: 2014, observaciones: 'Inactivo por antigüedad, pendiente reemplazo' }
  ];
  const ascensores = [];
  for (const a of ascensoresDemo) {
    let asc = await prisma.tbl_ascensores.findUnique({ where: { codigo: a.codigo } });
    if (!asc) {
      asc = await prisma.tbl_ascensores.create({ data: { ...a, user_id_registration: usrAdmin.id } });
      await prisma.tbl_ascensores_historial.create({
        data: { id_ascensor: asc.id, tipo_evento: 'creacion', descripcion: `Ascensor ${asc.codigo} registrado`, creado_por: usrAdmin.id }
      });
      await audit('tbl_ascensores', asc.id, 'CREATE', asc, usrAdmin.id);
    }
    ascensores.push(asc);
  }

  // ─── HELPERS DE SERVICIO ──────────────────────────────────────────
  async function crearServicio({
    codigo, id_cliente, id_ascensor, id_tipo, titulo, descripcion,
    fecha, hora = '09:00', estado, precio, origen = 'directo',
    tipo_registro = 'servicio', sin_cobro = 0, prioridad = 'media',
    id_mantenimiento_plan = null, fecha_estimada_entrega = null
  }) {
    let serv = await prisma.tbl_servicios_proyectos.findUnique({ where: { codigo } });
    if (serv) return serv;
    serv = await prisma.tbl_servicios_proyectos.create({
      data: {
        codigo, tipo_registro,
        id_tipo_servicio: id_tipo, id_cliente,
        id_mantenimiento_plan,
        origen, titulo, descripcion,
        fecha_programada: new Date(fecha), hora_programada: hora,
        fecha_estimada_entrega: fecha_estimada_entrega ? new Date(fecha_estimada_entrega) : null,
        prioridad, estado_servicio: estado,
        precio_interno: precio, moneda: 'PEN',
        sin_cobro,
        user_id_registration: usrAdmin.id,
        ascensores: {
          create: [{
            id_ascensor,
            monto: precio || 0,
            moneda: 'PEN',
            user_id_registration: usrAdmin.id
          }]
        }
      }
    });
    if (estado !== 'Borrador') {
      await eventoCalendario(serv, fecha, hora);
      await historialCliente(id_cliente, serv.id, 'servicio_creado', `Servicio ${codigo} creado`);
      await historialAscensor(id_ascensor, serv.id, 'servicio_creado', `Servicio ${codigo} creado`);
    }
    await audit('tbl_servicios_proyectos', serv.id, 'CREATE', serv, usrAdmin.id);
    return serv;
  }

  async function asignar(servicio, asignaciones, items = [], estadoChecklist = null) {
    const existe = await prisma.tbl_servicios_asignaciones.findFirst({ where: { id_servicio: servicio.id } });
    if (existe) return null;
    for (const a of asignaciones) {
      await prisma.tbl_servicios_asignaciones.create({
        data: {
          id_servicio: servicio.id, id_tecnico: a.id_tecnico,
          rol_asignacion: a.rol || 'Apoyo',
          responsable_principal: a.principal ? 1 : 0,
          responsable_documentacion: a.documentacion ? 1 : 0,
          responsable_checklist: a.checklist ? 1 : 0,
          asignado_por: usrAdmin.id
        }
      });
    }
    if (items.length === 0) return null;
    const tecChk = asignaciones.find(a => a.checklist) || asignaciones[0];
    const completado = ['Completo', 'Aprobado'].includes(estadoChecklist);
    const checklist = await prisma.tbl_checklists_salida.create({
      data: {
        id_servicio: servicio.id, id_tecnico_responsable: tecChk.id_tecnico,
        estado_checklist: estadoChecklist || 'Completo',
        fecha_completado: completado ? new Date() : null,
        validado_por: estadoChecklist === 'Aprobado' ? usrAdmin.id : null
      }
    });
    for (const it of items) {
      await prisma.tbl_checklists_salida_items.create({
        data: {
          id_checklist: checklist.id, tipo_item: it.tipo, nombre: it.nombre,
          cantidad: it.cantidad, unidad: it.unidad,
          estado_item: it.estado || (completado ? 'Confirmado' : 'Pendiente'),
          observaciones: it.observaciones || null
        }
      });
    }
    return checklist;
  }

  async function crearServicioRealizado(servicio, {
    obs = 'Servicio finalizado correctamente',
    descargo = null, id_tecnico_principal = null, id_resp_doc = null,
    estado_administrativo = 'Revisado',
    estado_contable = 'Revisado',
    estado_cobro = 'Pendiente de iniciar',
    estado_facturacion = 'Sin factura',
    fecha_realizacion = null
  } = {}) {
    const ex = await prisma.tbl_servicios_realizados.findUnique({ where: { id_servicio: servicio.id } });
    if (ex) return ex;
    const asig = await prisma.tbl_servicios_asignaciones.findFirst({
      where: { id_servicio: servicio.id, responsable_documentacion: 1 }
    });
    return prisma.tbl_servicios_realizados.create({
      data: {
        id_servicio: servicio.id, id_cliente: servicio.id_cliente,
        id_tecnico_principal: id_tecnico_principal || asig?.id_tecnico || null,
        id_responsable_documentacion: id_resp_doc || asig?.id_tecnico || null,
        observaciones_tecnicas: obs, descargo_tecnico: descargo,
        estado_administrativo, estado_contable, estado_cobro, estado_facturacion,
        fecha_realizacion: fecha_realizacion || new Date()
      }
    });
  }

  async function crearGuia(servicio, { codigo_guia, observaciones, archivo, estado = ESTADO_GUIA_ADJUNTA } = {}) {
    const asig = await prisma.tbl_servicios_asignaciones.findFirst({
      where: { id_servicio: servicio.id, responsable_documentacion: 1 }
    });
    const id_tecnico = asig?.id_tecnico;
    if (!id_tecnico) return null;
    let id_archivo = null;
    if (archivo) {
      const f = await prisma.tbl_archivos.create({ data: archivo });
      id_archivo = f.id;
    }
    return prisma.tbl_servicios_guias.create({
      data: {
        id_servicio: servicio.id, id_tecnico,
        codigo_guia: codigo_guia || `G-${servicio.codigo}`,
        id_archivo, observaciones_tecnicas: observaciones,
        estado_guia: estado
      }
    });
  }

  async function crearEvidencias(servicio, lista) {
    const asig = await prisma.tbl_servicios_asignaciones.findFirst({ where: { id_servicio: servicio.id } });
    const id_tecnico = asig?.id_tecnico;
    if (!id_tecnico) return;
    for (const e of lista) {
      let id_archivo = null;
      if (e.archivo) {
        const f = await prisma.tbl_archivos.create({ data: e.archivo });
        id_archivo = f.id;
      }
      await prisma.tbl_servicios_evidencias.create({
        data: {
          id_servicio: servicio.id, id_tecnico, id_archivo,
          tipo_evidencia: e.tipo || 'Foto', descripcion: e.descripcion
        }
      });
    }
  }

  async function crearCobro(servicio, {
    monto, abonado = 0, cuotas = 1, cuotas_pagadas = 0,
    fecha_proximo = null, fecha_ultimo = null, estado_cobro,
    pagos = [], cuotasDetalle = [], notas = null
  }) {
    const ex = await prisma.tbl_cobros.findUnique({ where: { id_servicio: servicio.id } });
    if (ex) return ex;
    const saldo = Math.max(0, monto - abonado);
    const cobro = await prisma.tbl_cobros.create({
      data: {
        id_servicio: servicio.id, id_cliente: servicio.id_cliente,
        monto_total: monto, saldo_pendiente: saldo, total_abonado: abonado,
        numero_cuotas: cuotas, cuotas_pagadas, cuotas_faltantes: cuotas - cuotas_pagadas,
        fecha_proximo_abono: fecha_proximo ? new Date(fecha_proximo) : null,
        fecha_ultimo_abono: fecha_ultimo ? new Date(fecha_ultimo) : null,
        estado_cobro, moneda: 'PEN', observaciones: notas,
        id_responsable_usuario: usrCont.id
      }
    });
    let nro = 1;
    for (const p of pagos) {
      let id_archivo_comprobante = null;
      if (p.comprobante) {
        const f = await prisma.tbl_archivos.create({ data: p.comprobante });
        id_archivo_comprobante = f.id;
      }
      await prisma.tbl_pagos.create({
        data: {
          id_cobro: cobro.id, numero_abono: nro++, monto: p.monto,
          fecha_pago: new Date(p.fecha), metodo_pago: p.metodo || 'Transferencia',
          id_archivo_comprobante, observaciones: p.notas, registrado_por: usrCont.id
        }
      });
    }
    for (const cu of cuotasDetalle) {
      await prisma.tbl_cobros_cuotas.create({
        data: {
          id_cobro: cobro.id, numero_cuota: cu.n,
          fecha_vencimiento: new Date(cu.vence), monto: cu.monto,
          monto_pagado: cu.pagado || 0,
          estado_cuota: cu.estado || 'Pendiente',
          fecha_pago: cu.fecha_pago ? new Date(cu.fecha_pago) : null
        }
      });
    }
    return cobro;
  }

  async function crearFactura(servicio, cobro, { numero, fecha, monto, estado = 'Emitida', archivo = null } = {}) {
    const ex = await prisma.tbl_facturas.findFirst({ where: { id_servicio: servicio.id, numero_factura: numero } });
    if (ex) return ex;
    let id_archivo = null;
    if (archivo) {
      const f = await prisma.tbl_archivos.create({ data: archivo });
      id_archivo = f.id;
    }
    const fact = await prisma.tbl_facturas.create({
      data: {
        id_servicio: servicio.id, id_cobro: cobro?.id || null, id_cliente: servicio.id_cliente,
        numero_factura: numero, fecha_emision: new Date(fecha),
        monto, id_archivo, estado_factura: estado, registrado_por: usrCont.id
      }
    });
    await audit('tbl_facturas', fact.id, 'CREATE', fact, usrCont.id);
    return fact;
  }

  async function crearEntrega(servicio, { tipo, fecha, descripcion, estado = 'Entregada', archivo = null }) {
    let id_archivo = null;
    if (archivo) {
      const f = await prisma.tbl_archivos.create({ data: archivo });
      id_archivo = f.id;
    }
    return prisma.tbl_entregas.create({
      data: {
        id_servicio: servicio.id, tipo_entrega: tipo,
        fecha_entrega: new Date(fecha),
        id_responsable_usuario: usrAdmin.id,
        descripcion, id_archivo, estado_entrega: estado,
        user_id_registration: usrAdmin.id
      }
    });
  }

  async function crearRecordatorio(cobro, mensaje, fecha = new Date()) {
    await prisma.tbl_cobros_recordatorios.create({
      data: {
        id_cobro: cobro.id, canal: 'whatsapp', mensaje,
        enviado_por: usrCont.id, fecha_envio: fecha
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // SERVICIOS — COBERTURA COMPLETA DE ESTADOS
  // ═════════════════════════════════════════════════════════════════

  // ── 1. BORRADOR ─────────────────────────────────────────────────
  const sBorrador = await crearServicio({
    codigo: 'SRV-2026-000001', id_cliente: clientes[7].id, id_ascensor: ascensores[10].id,
    id_tipo: tipos[5].id, titulo: 'Borrador – revisión preventiva semestral',
    descripcion: 'Servicio en borrador, pendiente de confirmar fecha con el cliente',
    fecha: iso(dias(20)), hora: '10:00', estado: 'Borrador', precio: 480.00
  });
  await transicionEstado(sBorrador.id, ['Borrador'], usrAdmin.id, dias(-1));

  // ── 2. PENDIENTE (sin asignar todavía) ───────────────────────────
  const sPendiente = await crearServicio({
    codigo: 'SRV-2026-000002', id_cliente: clientes[0].id, id_ascensor: ascensores[0].id,
    id_tipo: tipos[0].id, titulo: 'Mantenimiento mensual Torre A',
    descripcion: 'Mantenimiento preventivo mensual programado',
    fecha: hoyStr, hora: '09:00', estado: 'Pendiente', precio: 350.00
  });
  await transicionEstado(sPendiente.id, ['Pendiente'], usrAdmin.id, dias(-2));

  // ── 3. ASIGNADO (sin checklist todavía) ──────────────────────────
  const sAsignado = await crearServicio({
    codigo: 'SRV-2026-000003', id_cliente: clientes[1].id, id_ascensor: ascensores[2].id,
    id_tipo: tipos[5].id, titulo: 'Revisión técnica camillero',
    descripcion: 'Revisión anual programada',
    fecha: iso(dias(1)), hora: '14:00', estado: 'Asignado', precio: 480.00
  });
  await asignar(sAsignado, [
    { id_tecnico: tecnicos[2].id, principal: true, documentacion: true, checklist: true, rol: 'Responsable principal' }
  ]);
  await transicionEstado(sAsignado.id, ['Pendiente', 'Asignado'], usrAdmin.id, dias(-1));

  // ── 4. CHECKLIST DE SALIDA PENDIENTE ─────────────────────────────
  const sChecklistPend = await crearServicio({
    codigo: 'SRV-2026-000004', id_cliente: clientes[5].id, id_ascensor: ascensores[7].id,
    id_tipo: tipos[2].id, titulo: 'Reparación eléctrica panel de control',
    descripcion: 'Falla en tarjeta de control reportada por usuario',
    fecha: iso(dias(2)), hora: '11:00', estado: 'Checklist de salida pendiente', precio: 720.00,
    prioridad: 'alta'
  });
  await asignar(sChecklistPend, [
    { id_tecnico: tecnicos[0].id, principal: true, documentacion: true, checklist: true, rol: 'Responsable principal' },
    { id_tecnico: tecnicos[4].id, rol: 'Apoyo técnico' }
  ], [
    { tipo: 'Herramienta', nombre: 'Multímetro digital Fluke', cantidad: 1, unidad: 'Unidad', estado: 'Pendiente' },
    { tipo: 'Repuesto', nombre: 'Tarjeta de control 220V', cantidad: 1, unidad: 'Unidad', estado: 'Pendiente' },
    { tipo: 'Material', nombre: 'Cinta aislante', cantidad: 2, unidad: 'Unidad', estado: 'Pendiente' }
  ], 'En llenado');
  await transicionEstado(sChecklistPend.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente'], usrAdmin.id, dias(-1));

  // ── 5. LISTO PARA SALIDA ─────────────────────────────────────────
  const sListoSalida = await crearServicio({
    codigo: 'SRV-2026-000005', id_cliente: clientes[2].id, id_ascensor: ascensores[3].id,
    id_tipo: tipos[0].id, titulo: 'Mantenimiento preventivo Torre 1',
    descripcion: 'Mantenimiento mensual programado',
    fecha: hoyStr, hora: '15:00', estado: 'Listo para salida', precio: 320.00
  });
  await asignar(sListoSalida, [
    { id_tecnico: tecnicos[3].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Herramienta', nombre: 'Caja de herramientas estándar', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' },
    { tipo: 'Material', nombre: 'Aceite hidráulico', cantidad: 2, unidad: 'Litro', estado: 'Confirmado' },
    { tipo: 'Material', nombre: 'Grasa para rieles', cantidad: 1, unidad: 'Bolsa', estado: 'Confirmado' }
  ], 'Completo');
  await transicionEstado(sListoSalida.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida'], usrAdmin.id, dias(-1));

  // ── 6. EN CAMINO ─────────────────────────────────────────────────
  const sEnCamino = await crearServicio({
    codigo: 'SRV-2026-000006', id_cliente: clientes[4].id, id_ascensor: ascensores[5].id,
    id_tipo: tipos[1].id, titulo: 'Mantenimiento correctivo Lobby',
    descripcion: 'Corrección de ruido detectado en rutina previa',
    fecha: hoyStr, hora: '10:30', estado: 'En camino', precio: 540.00,
    prioridad: 'alta'
  });
  await asignar(sEnCamino, [
    { id_tecnico: tecnicos[1].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Equipo', nombre: 'Estetoscopio mecánico', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' },
    { tipo: 'Repuesto', nombre: 'Cojinetes de polea', cantidad: 2, unidad: 'Unidad', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sEnCamino.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino'], usrAdmin.id, dias(-1));
  await prisma.tbl_tecnicos.update({ where: { id: tecnicos[1].id }, data: { estado_operativo: 'Ocupado' } });

  // ── 7. EN CURSO (1) ──────────────────────────────────────────────
  const sEnCurso1 = await crearServicio({
    codigo: 'SRV-2026-000007', id_cliente: clientes[3].id, id_ascensor: ascensores[4].id,
    id_tipo: tipos[4].id, titulo: 'Emergencia ascensor de carga',
    descripcion: 'Ascensor detenido entre pisos con personas adentro',
    fecha: hoyStr, hora: '11:30', estado: 'En curso', precio: 850.00,
    origen: 'emergencia', prioridad: 'alta'
  });
  await asignar(sEnCurso1, [
    { id_tecnico: tecnicos[1].id, principal: true, documentacion: true, checklist: true, rol: 'Responsable principal' }
  ], [
    { tipo: 'Herramienta', nombre: 'Llaves stilson', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' },
    { tipo: 'Repuesto', nombre: 'Cable de control', cantidad: 5, unidad: 'Metro', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sEnCurso1.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso'], usrAdmin.id, dias(-1));

  // ── 8. EN CURSO (2) ──────────────────────────────────────────────
  const sEnCurso2 = await crearServicio({
    codigo: 'SRV-2026-000008', id_cliente: clientes[4].id, id_ascensor: ascensores[6].id,
    id_tipo: tipos[3].id, titulo: 'Reparación mecánica ala sur',
    descripcion: 'Reemplazo de cable de tracción',
    fecha: hoyStr, hora: '08:00', estado: 'En curso', precio: 1800.00, prioridad: 'alta'
  });
  await asignar(sEnCurso2, [
    { id_tecnico: tecnicos[3].id, principal: true, documentacion: true, checklist: true },
    { id_tecnico: tecnicos[4].id, rol: 'Especialista' }
  ], [
    { tipo: 'Repuesto', nombre: 'Cable de tracción 6mm', cantidad: 30, unidad: 'Metro', estado: 'Confirmado' },
    { tipo: 'Herramienta', nombre: 'Tensor hidráulico', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sEnCurso2.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso'], usrAdmin.id, dias(-1));
  await prisma.tbl_tecnicos.update({ where: { id: tecnicos[3].id }, data: { estado_operativo: 'En servicio' } });

  // ── 9. FINALIZADO POR TÉCNICO (sin revisar) ──────────────────────
  const sFinalizado = await crearServicio({
    codigo: 'SRV-2026-000009', id_cliente: clientes[5].id, id_ascensor: ascensores[7].id,
    id_tipo: tipos[0].id, titulo: 'Mantenimiento sucursal San Borja',
    descripcion: 'Rutina mensual estándar',
    fecha: iso(dias(-1)), hora: '09:00', estado: 'Finalizado por técnico', precio: 420.00
  });
  await asignar(sFinalizado, [
    { id_tecnico: tecnicos[0].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Material', nombre: 'Limpiador industrial', cantidad: 1, unidad: 'Litro', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sFinalizado.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico'], usrAdmin.id, dias(-2));
  await crearGuia(sFinalizado, { codigo_guia: 'G-2026-009', observaciones: 'Mantenimiento completado, sin incidentes.', archivo: { nombre_original: 'guia-009.pdf', ruta_almacenamiento: '/uploads/documents/guia-009.pdf', mime_type: 'application/pdf', tamano_bytes: 145200, subido_por: usrAdmin.id } });
  await crearEvidencias(sFinalizado, [
    { tipo: 'Foto', descripcion: 'Sala de máquinas antes', archivo: { nombre_original: 'antes-009.jpg', ruta_almacenamiento: '/uploads/documents/antes-009.jpg', mime_type: 'image/jpeg', tamano_bytes: 220000, subido_por: usrAdmin.id } },
    { tipo: 'Foto', descripcion: 'Sala de máquinas después', archivo: { nombre_original: 'despues-009.jpg', ruta_almacenamiento: '/uploads/documents/despues-009.jpg', mime_type: 'image/jpeg', tamano_bytes: 215000, subido_por: usrAdmin.id } }
  ]);
  await crearServicioRealizado(sFinalizado, {
    estado_administrativo: 'Pendiente revisión', estado_contable: 'Pendiente',
    fecha_realizacion: dias(-1)
  });

  // ── 10. FINALIZADO OBSERVADO ─────────────────────────────────────
  const sFinObservado = await crearServicio({
    codigo: 'SRV-2026-000010', id_cliente: clientes[2].id, id_ascensor: ascensores[3].id,
    id_tipo: tipos[1].id, titulo: 'Corrección emergencia nocturna',
    descripcion: 'Atendido en horario nocturno, técnico no pudo subir guía',
    fecha: iso(dias(-3)), hora: '22:00', estado: 'Finalizado observado', precio: 680.00,
    prioridad: 'alta'
  });
  await asignar(sFinObservado, [
    { id_tecnico: tecnicos[1].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Herramienta', nombre: 'Linterna industrial', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' }
  ], 'Completo');
  await transicionEstado(sFinObservado.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado observado'], usrAdmin.id, dias(-3));
  await crearGuia(sFinObservado, { codigo_guia: 'G-2026-010', observaciones: 'Finalizado sin guía formal por urgencia nocturna. Admin autorizó cierre observado.', estado: ESTADO_GUIA_OBSERVADA });
  await crearServicioRealizado(sFinObservado, {
    obs: 'Atención de emergencia, ascensor reactivado. Observación: sin guía formal por horario.',
    estado_administrativo: 'Observado', estado_contable: 'Pendiente',
    fecha_realizacion: dias(-3)
  });

  // ── 11. EN REVISIÓN ADMINISTRATIVA (1) ───────────────────────────
  const sRevision1 = await crearServicio({
    codigo: 'SRV-2026-000011', id_cliente: clientes[6].id, id_ascensor: ascensores[8].id,
    id_tipo: tipos[5].id, titulo: 'Revisión técnica Edificio A',
    descripcion: 'Revisión semestral universidad',
    fecha: iso(dias(-2)), hora: '08:30', estado: 'En revisión administrativa', precio: 560.00
  });
  await asignar(sRevision1, [
    { id_tecnico: tecnicos[2].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Herramienta', nombre: 'Equipo de medición láser', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sRevision1.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa'], usrAdmin.id, dias(-2));
  await crearGuia(sRevision1, { codigo_guia: 'G-2026-011', observaciones: 'Revisión completada conforme.', archivo: { nombre_original: 'guia-011.pdf', ruta_almacenamiento: '/uploads/documents/guia-011.pdf', mime_type: 'application/pdf', tamano_bytes: 178000, subido_por: usrAdmin.id } });
  await crearServicioRealizado(sRevision1, {
    estado_administrativo: 'Pendiente revisión', estado_contable: 'Pendiente',
    fecha_realizacion: dias(-2)
  });
  await crearCobro(sRevision1, { monto: 560, estado_cobro: 'Pendiente de iniciar', fecha_proximo: iso(dias(15)) });

  // ── 12. EN REVISIÓN ADMINISTRATIVA (2) ───────────────────────────
  const sRevision2 = await crearServicio({
    codigo: 'SRV-2026-000012', id_cliente: clientes[0].id, id_ascensor: ascensores[1].id,
    id_tipo: tipos[1].id, titulo: 'Mantenimiento correctivo Torre B',
    descripcion: 'Reparación de ruido en poleas Torre B',
    fecha: iso(dias(-4)), hora: '14:00', estado: 'En revisión administrativa', precio: 920.00
  });
  await asignar(sRevision2, [
    { id_tecnico: tecnicos[0].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Repuesto', nombre: 'Rodamientos SKF', cantidad: 4, unidad: 'Unidad', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sRevision2.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa'], usrAdmin.id, dias(-4));
  await crearGuia(sRevision2, { codigo_guia: 'G-2026-012', observaciones: 'Rodamientos reemplazados. Ruido eliminado.' });
  await crearServicioRealizado(sRevision2, {
    obs: 'Reemplazo de rodamientos completado. Verificado funcionamiento.',
    estado_administrativo: 'Pendiente revisión', estado_contable: 'Pendiente',
    fecha_realizacion: dias(-4)
  });
  await crearCobro(sRevision2, { monto: 920, estado_cobro: 'Pendiente de iniciar', fecha_proximo: iso(dias(20)) });

  // ── 13. A GESTIÓN DE COBRO (revisado, sin abonos aún) ────────────
  const sGestion = await crearServicio({
    codigo: 'SRV-2026-000013', id_cliente: clientes[1].id, id_ascensor: ascensores[2].id,
    id_tipo: tipos[6].id, titulo: 'Inspección anual hospital',
    descripcion: 'Inspección anual obligatoria de seguridad',
    fecha: iso(dias(-7)), hora: '10:00', estado: 'A gestión de cobro', precio: 750.00
  });
  await asignar(sGestion, [
    { id_tecnico: tecnicos[2].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Herramienta', nombre: 'Equipo de inspección', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sGestion.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro'], usrAdmin.id, dias(-7));
  await crearGuia(sGestion, { codigo_guia: 'G-2026-013', observaciones: 'Inspección conforme.' });
  await crearServicioRealizado(sGestion, {
    estado_cobro: 'Pendiente de iniciar', fecha_realizacion: dias(-7)
  });
  await crearCobro(sGestion, { monto: 750, estado_cobro: 'Pendiente de iniciar', fecha_proximo: iso(dias(7)) });

  // ── 14. EN COBRO (En gestión, sin pagos aún) ─────────────────────
  const sEnCobro = await crearServicio({
    codigo: 'SRV-2026-000014', id_cliente: clientes[2].id, id_ascensor: ascensores[3].id,
    id_tipo: tipos[0].id, titulo: 'Mantenimiento mensual Torre 1',
    descripcion: 'Rutina mensual estándar',
    fecha: iso(dias(-10)), hora: '11:00', estado: 'En cobro', precio: 350.00
  });
  await asignar(sEnCobro, [
    { id_tecnico: tecnicos[3].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Material', nombre: 'Lubricante de rieles', cantidad: 1, unidad: 'Litro', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sEnCobro.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro'], usrAdmin.id, dias(-10));
  await crearGuia(sEnCobro, { codigo_guia: 'G-2026-014', observaciones: 'Mantenimiento completo.' });
  await crearServicioRealizado(sEnCobro, { estado_cobro: 'En gestión', fecha_realizacion: dias(-10) });
  const cobroEnCobro = await crearCobro(sEnCobro, {
    monto: 350, cuotas: 1, estado_cobro: 'En gestión',
    fecha_proximo: iso(dias(3))
  });

  // ── 15. COBRADO PARCIAL (con pago parcial) ───────────────────────
  const sParcial = await crearServicio({
    codigo: 'SRV-2026-000015', id_cliente: clientes[0].id, id_ascensor: ascensores[0].id,
    id_tipo: tipos[3].id, titulo: 'Reparación mecánica Torre A',
    descripcion: 'Reparación de motor reportado anteriormente',
    fecha: iso(dias(-30)), hora: '09:00', estado: 'Cobrado parcial', precio: 1200.00
  });
  await asignar(sParcial, [
    { id_tecnico: tecnicos[0].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Repuesto', nombre: 'Motor de respaldo', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sParcial.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro', 'Cobrado parcial'], usrAdmin.id, dias(-30));
  await crearGuia(sParcial, { codigo_guia: 'G-2026-015', observaciones: 'Reparación completada satisfactoriamente.', archivo: { nombre_original: 'guia-015.pdf', ruta_almacenamiento: '/uploads/documents/guia-015.pdf', mime_type: 'application/pdf', tamano_bytes: 198000, subido_por: usrAdmin.id } });
  await crearServicioRealizado(sParcial, { estado_cobro: 'Parcialmente pagado', fecha_realizacion: dias(-30) });
  const cobroParcial = await crearCobro(sParcial, {
    monto: 1200, abonado: 400, cuotas: 3, cuotas_pagadas: 1,
    estado_cobro: 'Parcialmente pagado',
    fecha_proximo: iso(dias(10)), fecha_ultimo: iso(dias(-15)),
    pagos: [{ monto: 400, fecha: iso(dias(-15)), metodo: 'Transferencia', notas: 'Pago primera cuota' }],
    cuotasDetalle: [
      { n: 1, vence: iso(dias(-20)), monto: 400, pagado: 400, estado: 'Pagada', fecha_pago: iso(dias(-15)) },
      { n: 2, vence: iso(dias(10)), monto: 400, estado: 'Pendiente' },
      { n: 3, vence: iso(dias(40)), monto: 400, estado: 'Pendiente' }
    ]
  });

  // ── 16. VENCIDO (saldo > 0, fecha próximo abono pasada < 30 días) ─
  const sVencido = await crearServicio({
    codigo: 'SRV-2026-000016', id_cliente: clientes[3].id, id_ascensor: ascensores[4].id,
    id_tipo: tipos[1].id, titulo: 'Reparación motor carga',
    descripcion: 'Reparación mayor reportada como urgente',
    fecha: iso(dias(-25)), hora: '08:00', estado: 'En cobro', precio: 1500.00
  });
  await asignar(sVencido, [
    { id_tecnico: tecnicos[1].id, principal: true, documentacion: true, checklist: true }
  ], [{ tipo: 'Repuesto', nombre: 'Repuestos motor', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' }], 'Aprobado');
  await transicionEstado(sVencido.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro'], usrAdmin.id, dias(-25));
  await crearGuia(sVencido, { codigo_guia: 'G-2026-016', observaciones: 'Reparación completa.' });
  await crearServicioRealizado(sVencido, { estado_cobro: 'Vencido', fecha_realizacion: dias(-25) });
  const cobroVencido = await crearCobro(sVencido, {
    monto: 1500, cuotas: 1, estado_cobro: 'Vencido',
    fecha_proximo: iso(dias(-7)) // venció hace 7 días
  });

  // ── 17. EN MORA (saldo > 0, vencido >= 30 días, con recordatorios) ─
  const sMora = await crearServicio({
    codigo: 'SRV-2026-000017', id_cliente: clientes[3].id, id_ascensor: ascensores[4].id,
    id_tipo: tipos[3].id, titulo: 'Reparación mecánica galería',
    descripcion: 'Reparación reportada hace tiempo, cobro en mora',
    fecha: iso(dias(-90)), hora: '10:00', estado: 'En cobro', precio: 1800.00
  });
  await asignar(sMora, [
    { id_tecnico: tecnicos[1].id, principal: true, documentacion: true, checklist: true }
  ], [{ tipo: 'Repuesto', nombre: 'Sistema de frenado', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' }], 'Aprobado');
  await transicionEstado(sMora.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro'], usrAdmin.id, dias(-90));
  await crearGuia(sMora, { codigo_guia: 'G-2026-017', observaciones: 'Reparación completa.' });
  await crearServicioRealizado(sMora, { estado_cobro: 'En mora', fecha_realizacion: dias(-90) });
  const cobroMora = await crearCobro(sMora, {
    monto: 1800, cuotas: 1, estado_cobro: 'En mora',
    fecha_proximo: iso(dias(-45)), // 45 días vencido
    notas: 'Cliente con problemas de pago, varios recordatorios enviados'
  });
  await crearRecordatorio(cobroMora, 'Hola, somos Ascensores Jy. Le recordamos saldo pendiente de S/ 1800.00 vencido hace 30 días. Por favor confirmar fecha de pago.', dias(-15));
  await crearRecordatorio(cobroMora, 'Hola, somos Ascensores Jy. Saldo pendiente S/ 1800.00. Por favor regularizar.', dias(-7));
  await crearRecordatorio(cobroMora, 'Recordatorio: saldo pendiente S/ 1800.00 acumulando mora. Solicitamos respuesta urgente.', dias(-2));

  // ── 18. COBRADO TOTAL (sin factura aún) ──────────────────────────
  const sCobradoTotal = await crearServicio({
    codigo: 'SRV-2026-000018', id_cliente: clientes[4].id, id_ascensor: ascensores[5].id,
    id_tipo: tipos[6].id, titulo: 'Inspección anual hotel',
    descripcion: 'Inspección anual obligatoria',
    fecha: iso(dias(-20)), hora: '11:00', estado: 'Cobrado total', precio: 680.00
  });
  await asignar(sCobradoTotal, [
    { id_tecnico: tecnicos[2].id, principal: true, documentacion: true, checklist: true }
  ], [{ tipo: 'Herramienta', nombre: 'Equipo de inspección', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' }], 'Aprobado');
  await transicionEstado(sCobradoTotal.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro', 'Cobrado total'], usrAdmin.id, dias(-20));
  await crearGuia(sCobradoTotal, { codigo_guia: 'G-2026-018', observaciones: 'Inspección conforme y aprobada.', archivo: { nombre_original: 'guia-018.pdf', ruta_almacenamiento: '/uploads/documents/guia-018.pdf', mime_type: 'application/pdf', tamano_bytes: 165000, subido_por: usrAdmin.id } });
  await crearServicioRealizado(sCobradoTotal, { estado_cobro: 'Pagado', estado_facturacion: 'Pendiente de emitir', fecha_realizacion: dias(-20) });
  await crearCobro(sCobradoTotal, {
    monto: 680, abonado: 680, cuotas: 1, cuotas_pagadas: 1,
    estado_cobro: 'Pagado', fecha_ultimo: iso(dias(-5)),
    pagos: [{ monto: 680, fecha: iso(dias(-5)), metodo: 'Transferencia', notas: 'Pago único completo' }],
    cuotasDetalle: [{ n: 1, vence: iso(dias(-10)), monto: 680, pagado: 680, estado: 'Pagada', fecha_pago: iso(dias(-5)) }]
  });

  // ── 19. FACTURADO (pagado + factura emitida) ─────────────────────
  const sFacturado = await crearServicio({
    codigo: 'SRV-2026-000019', id_cliente: clientes[5].id, id_ascensor: ascensores[7].id,
    id_tipo: tipos[0].id, titulo: 'Mantenimiento Banco San Borja',
    descripcion: 'Mantenimiento mensual programado',
    fecha: iso(dias(-15)), hora: '08:00', estado: 'Facturado', precio: 420.00
  });
  await asignar(sFacturado, [
    { id_tecnico: tecnicos[0].id, principal: true, documentacion: true, checklist: true }
  ], [{ tipo: 'Material', nombre: 'Suministros estándar', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' }], 'Aprobado');
  await transicionEstado(sFacturado.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro', 'Cobrado total', 'Facturado'], usrAdmin.id, dias(-15));
  await crearGuia(sFacturado, { codigo_guia: 'G-2026-019', observaciones: 'Mantenimiento conforme.' });
  await crearServicioRealizado(sFacturado, { estado_cobro: 'Pagado', estado_facturacion: 'Facturado', fecha_realizacion: dias(-15) });
  const cobroFacturado = await crearCobro(sFacturado, {
    monto: 420, abonado: 420, cuotas: 1, cuotas_pagadas: 1,
    estado_cobro: 'Pagado', fecha_ultimo: iso(dias(-7)),
    pagos: [{ monto: 420, fecha: iso(dias(-7)), metodo: 'Transferencia' }]
  });
  await crearFactura(sFacturado, cobroFacturado, {
    numero: 'F001-000456', fecha: iso(dias(-6)), monto: 420, estado: 'Emitida',
    archivo: { nombre_original: 'factura-456.pdf', ruta_almacenamiento: '/uploads/documents/factura-456.pdf', mime_type: 'application/pdf', tamano_bytes: 95000, subido_por: usrCont.id }
  });

  // ── 20. CERRADO (proyecto completo cobrado + facturado + cerrado) ─
  const sCerrado = await crearServicio({
    codigo: 'SRV-2026-000020', id_cliente: clientes[1].id, id_ascensor: ascensores[2].id,
    id_tipo: tipos[8].id, titulo: 'Proyecto instalación piso ampliación',
    descripcion: 'Proyecto de instalación nueva para nueva ala', tipo_registro: 'proyecto',
    fecha: iso(dias(-60)), hora: '08:00', estado: 'Cerrado', precio: 12500.00,
    fecha_estimada_entrega: iso(dias(-30))
  });
  await asignar(sCerrado, [
    { id_tecnico: tecnicos[2].id, principal: true, documentacion: true, checklist: true, rol: 'Responsable principal' },
    { id_tecnico: tecnicos[4].id, rol: 'Especialista' },
    { id_tecnico: tecnicos[0].id, rol: 'Apoyo técnico' }
  ], [
    { tipo: 'Equipo', nombre: 'Andamios', cantidad: 4, unidad: 'Unidad', estado: 'Confirmado' },
    { tipo: 'Material', nombre: 'Cables de tracción', cantidad: 50, unidad: 'Metro', estado: 'Confirmado' },
    { tipo: 'Herramienta', nombre: 'Equipo de soldadura', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' },
    { tipo: 'Repuesto', nombre: 'Tarjeta de control nueva', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' }
  ], 'Aprobado');
  await transicionEstado(sCerrado.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro', 'Cobrado parcial', 'Cobrado total', 'Facturado', 'Cerrado'], usrAdmin.id, dias(-60));
  await crearGuia(sCerrado, { codigo_guia: 'G-2026-020', observaciones: 'Proyecto entregado y operativo al 100%. Certificado de conformidad firmado.', archivo: { nombre_original: 'guia-proyecto-020.pdf', ruta_almacenamiento: '/uploads/documents/guia-proyecto-020.pdf', mime_type: 'application/pdf', tamano_bytes: 412000, subido_por: usrAdmin.id }, estado: 'Aprobada' });
  await crearEvidencias(sCerrado, [
    { tipo: 'Foto', descripcion: 'Estado inicial del foso', archivo: { nombre_original: 'inicial-020.jpg', ruta_almacenamiento: '/uploads/documents/inicial-020.jpg', mime_type: 'image/jpeg', tamano_bytes: 380000, subido_por: usrAdmin.id } },
    { tipo: 'Foto', descripcion: 'Cabina nueva instalada', archivo: { nombre_original: 'cabina-020.jpg', ruta_almacenamiento: '/uploads/documents/cabina-020.jpg', mime_type: 'image/jpeg', tamano_bytes: 395000, subido_por: usrAdmin.id } },
    { tipo: 'Video', descripcion: 'Prueba de funcionamiento final', archivo: { nombre_original: 'prueba-020.mp4', ruta_almacenamiento: '/uploads/documents/prueba-020.mp4', mime_type: 'video/mp4', tamano_bytes: 8500000, subido_por: usrAdmin.id } },
    { tipo: 'Documento', descripcion: 'Certificado de inspección emitido', archivo: { nombre_original: 'cert-020.pdf', ruta_almacenamiento: '/uploads/documents/cert-020.pdf', mime_type: 'application/pdf', tamano_bytes: 188000, subido_por: usrAdmin.id } }
  ]);
  await crearServicioRealizado(sCerrado, {
    obs: 'Proyecto de instalación completado y entregado.',
    estado_administrativo: 'Cerrado', estado_contable: 'Cerrado',
    estado_cobro: 'Cerrado', estado_facturacion: 'Facturado',
    fecha_realizacion: dias(-45)
  });
  const cobroCerrado = await crearCobro(sCerrado, {
    monto: 12500, abonado: 12500, cuotas: 4, cuotas_pagadas: 4,
    estado_cobro: 'Cerrado', fecha_ultimo: iso(dias(-2)),
    pagos: [
      { monto: 3125, fecha: iso(dias(-55)), metodo: 'Transferencia', notas: 'Inicial 25%' },
      { monto: 3125, fecha: iso(dias(-35)), metodo: 'Transferencia', notas: 'Cuota 2' },
      { monto: 3125, fecha: iso(dias(-15)), metodo: 'Transferencia', notas: 'Cuota 3' },
      { monto: 3125, fecha: iso(dias(-2)), metodo: 'Transferencia', notas: 'Pago final' }
    ],
    cuotasDetalle: [
      { n: 1, vence: iso(dias(-55)), monto: 3125, pagado: 3125, estado: 'Pagada', fecha_pago: iso(dias(-55)) },
      { n: 2, vence: iso(dias(-35)), monto: 3125, pagado: 3125, estado: 'Pagada', fecha_pago: iso(dias(-35)) },
      { n: 3, vence: iso(dias(-15)), monto: 3125, pagado: 3125, estado: 'Pagada', fecha_pago: iso(dias(-15)) },
      { n: 4, vence: iso(dias(-2)), monto: 3125, pagado: 3125, estado: 'Pagada', fecha_pago: iso(dias(-2)) }
    ]
  });
  await crearFactura(sCerrado, cobroCerrado, {
    numero: 'F001-000123', fecha: iso(dias(-50)), monto: 12500, estado: 'Adjunta',
    archivo: { nombre_original: 'factura-123.pdf', ruta_almacenamiento: '/uploads/documents/factura-123.pdf', mime_type: 'application/pdf', tamano_bytes: 142000, subido_por: usrCont.id }
  });
  // Entregas del proyecto
  await crearEntrega(sCerrado, { tipo: 'Entrega parcial', fecha: iso(dias(-50)), descripcion: 'Entrega parcial: estructura instalada', estado: 'Aprobada', archivo: { nombre_original: 'entrega-parcial-020.pdf', ruta_almacenamiento: '/uploads/documents/entrega-parcial-020.pdf', mime_type: 'application/pdf', tamano_bytes: 75000, subido_por: usrAdmin.id } });
  await crearEntrega(sCerrado, { tipo: 'Entrega técnica', fecha: iso(dias(-40)), descripcion: 'Entrega técnica: equipamiento eléctrico y mecánico', estado: 'Aprobada' });
  await crearEntrega(sCerrado, { tipo: 'Entrega documental', fecha: iso(dias(-35)), descripcion: 'Planos, manuales y certificaciones', estado: 'Aprobada', archivo: { nombre_original: 'documentos-020.pdf', ruta_almacenamiento: '/uploads/documents/documentos-020.pdf', mime_type: 'application/pdf', tamano_bytes: 580000, subido_por: usrAdmin.id } });
  await crearEntrega(sCerrado, { tipo: 'Entrega final', fecha: iso(dias(-30)), descripcion: 'Entrega final: ascensor operativo y certificado', estado: 'Aprobada', archivo: { nombre_original: 'entrega-final-020.pdf', ruta_almacenamiento: '/uploads/documents/entrega-final-020.pdf', mime_type: 'application/pdf', tamano_bytes: 95000, subido_por: usrAdmin.id } });

  // Entregas en otros estados para completar cobertura
  await crearEntrega(sFacturado, { tipo: 'Entrega documental', fecha: iso(dias(-12)), descripcion: 'Pendiente envío de informe técnico físico', estado: 'Pendiente' });
  await crearEntrega(sFinalizado, { tipo: 'Entrega técnica', fecha: iso(dias(-1)), descripcion: 'Entrega con observación: cliente pidió completar campo de checklist', estado: 'Observada' });
  await crearEntrega(sFinObservado, { tipo: 'Entrega parcial', fecha: iso(dias(-3)), descripcion: 'Entrega parcial nocturna sin firma del cliente', estado: 'Entregada' });

  // ── 21. CANCELADO ────────────────────────────────────────────────
  const sCancelado = await crearServicio({
    codigo: 'SRV-2026-000021', id_cliente: clientes[7].id, id_ascensor: ascensores[11].id,
    id_tipo: tipos[5].id, titulo: 'Revisión bloque oficinas',
    descripcion: 'Cliente solicitó cancelación tras programación',
    fecha: iso(dias(-5)), hora: '15:00', estado: 'Cancelado', precio: 320.00
  });
  await transicionEstado(sCancelado.id, ['Pendiente', 'Asignado', 'Cancelado'], usrAdmin.id, dias(-5));
  await prisma.tbl_servicios_proyectos.update({
    where: { id: sCancelado.id },
    data: { observaciones: '[Cancelado] Cliente reportó que el ascensor quedará inactivo permanentemente, no se requiere revisión.' }
  });

  // ── 22. SIN COBRO (servicio cortesía) ────────────────────────────
  const sSinCobro = await crearServicio({
    codigo: 'SRV-2026-000022', id_cliente: clientes[6].id, id_ascensor: ascensores[8].id,
    id_tipo: tipos[5].id, titulo: 'Revisión cortesía cliente premium',
    descripcion: 'Revisión sin costo como cortesía al cliente',
    fecha: iso(dias(-3)), hora: '09:00', estado: 'Cerrado', precio: 0.00,
    sin_cobro: 1
  });
  await asignar(sSinCobro, [
    { id_tecnico: tecnicos[2].id, principal: true, documentacion: true, checklist: true }
  ], [{ tipo: 'Herramienta', nombre: 'Kit revisión rápida', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' }], 'Completo');
  await transicionEstado(sSinCobro.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'Cerrado'], usrAdmin.id, dias(-3));
  await crearGuia(sSinCobro, { codigo_guia: 'G-2026-022', observaciones: 'Revisión de cortesía completada, sin costo.' });
  await crearServicioRealizado(sSinCobro, {
    obs: 'Revisión cortesía sin cobro.',
    estado_cobro: 'Sin cobro', estado_facturacion: 'Sin factura', estado_administrativo: 'Cerrado',
    fecha_realizacion: dias(-3)
  });
  await crearCobro(sSinCobro, { monto: 0, cuotas: 1, estado_cobro: 'Sin cobro' });

  // ── 23. INCOBRABLE (cliente quebró) ──────────────────────────────
  const sIncobrable = await crearServicio({
    codigo: 'SRV-2026-000023', id_cliente: clientes[3].id, id_ascensor: ascensores[4].id,
    id_tipo: tipos[3].id, titulo: 'Reparación crítica galería',
    descripcion: 'Reparación realizada antes que cliente entrara en problemas legales',
    fecha: iso(dias(-180)), hora: '09:00', estado: 'En cobro', precio: 2400.00
  });
  await asignar(sIncobrable, [
    { id_tecnico: tecnicos[1].id, principal: true, documentacion: true, checklist: true }
  ], [{ tipo: 'Repuesto', nombre: 'Sistema completo', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' }], 'Aprobado');
  await transicionEstado(sIncobrable.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro'], usrAdmin.id, dias(-180));
  await crearGuia(sIncobrable, { codigo_guia: 'G-2026-023', observaciones: 'Reparación completa entregada.' });
  await crearServicioRealizado(sIncobrable, { estado_cobro: 'Incobrable', fecha_realizacion: dias(-180) });
  const cobroIncobrable = await crearCobro(sIncobrable, {
    monto: 2400, cuotas: 1, estado_cobro: 'Incobrable',
    fecha_proximo: iso(dias(-150)),
    notas: '[Incobrable] Cliente en proceso de quiebra. Aprobado por Super Admin para marcar como incobrable.'
  });
  await crearRecordatorio(cobroIncobrable, 'Recordatorio de saldo S/ 2400.00. Por favor confirmar fecha de pago.', dias(-120));
  await audit('tbl_cobros', cobroIncobrable.id, 'STATUS_CHANGE', { estado: 'Incobrable', motivo: 'Cliente en quiebra' }, usrSuper.id);

  // ── 24-bis. CHECKLIST OBSERVADO (servicio con observación al checklist) ─
  const sChkObservado = await crearServicio({
    codigo: 'SRV-2026-000027', id_cliente: clientes[0].id, id_ascensor: ascensores[1].id,
    id_tipo: tipos[0].id, titulo: 'Mantenimiento Torre B con observación',
    descripcion: 'Mantenimiento donde se observó faltante en checklist',
    fecha: iso(dias(3)), hora: '11:00', estado: 'Checklist de salida pendiente', precio: 350.00
  });
  await asignar(sChkObservado, [
    { id_tecnico: tecnicos[4].id, principal: true, documentacion: true, checklist: true }
  ], [
    { tipo: 'Herramienta', nombre: 'Multímetro', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' },
    { tipo: 'Repuesto', nombre: 'Cable de control especial', cantidad: 5, unidad: 'Metro', estado: 'Observado', observaciones: 'Stock incompleto, faltan 2 metros — confirmar antes de salir' }
  ], 'Observado');
  await transicionEstado(sChkObservado.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente'], usrAdmin.id, dias(-1));

  // ── 24. FACTURA OBSERVADA (proceso atípico) ──────────────────────
  const sFactObservada = await crearServicio({
    codigo: 'SRV-2026-000024', id_cliente: clientes[4].id, id_ascensor: ascensores[6].id,
    id_tipo: tipos[2].id, titulo: 'Reparación eléctrica hotel',
    descripcion: 'Reparación eléctrica, factura emitida con error',
    fecha: iso(dias(-22)), hora: '10:00', estado: 'Cobrado total', precio: 920.00
  });
  await asignar(sFactObservada, [
    { id_tecnico: tecnicos[4].id, principal: true, documentacion: true, checklist: true }
  ], [{ tipo: 'Repuesto', nombre: 'Tarjeta de control', cantidad: 1, unidad: 'Unidad', estado: 'Confirmado' }], 'Aprobado');
  await transicionEstado(sFactObservada.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro', 'Cobrado total'], usrAdmin.id, dias(-22));
  await crearGuia(sFactObservada, { codigo_guia: 'G-2026-024', observaciones: 'Reparación completa.' });
  await crearServicioRealizado(sFactObservada, { estado_cobro: 'Pagado', estado_facturacion: 'Observado', fecha_realizacion: dias(-22) });
  const cobroFactObs = await crearCobro(sFactObservada, {
    monto: 920, abonado: 920, cuotas: 1, cuotas_pagadas: 1, estado_cobro: 'Pagado',
    fecha_ultimo: iso(dias(-10)),
    pagos: [{ monto: 920, fecha: iso(dias(-10)), metodo: 'Yape' }]
  });
  await crearFactura(sFactObservada, cobroFactObs, {
    numero: 'F001-000789', fecha: iso(dias(-9)), monto: 920, estado: 'Observada',
    archivo: { nombre_original: 'factura-789.pdf', ruta_almacenamiento: '/uploads/documents/factura-789.pdf', mime_type: 'application/pdf', tamano_bytes: 88000, subido_por: usrCont.id }
  });

  // ── 24-bis. FACTURA ANULADA (re-emitida) ────────────────────────
  const sFactAnulada = await crearServicio({
    codigo: 'SRV-2026-000028', id_cliente: clientes[6].id, id_ascensor: ascensores[8].id,
    id_tipo: tipos[0].id, titulo: 'Mantenimiento universidad — factura anulada',
    descripcion: 'Primera factura anulada por error de monto, segunda emitida',
    fecha: iso(dias(-18)), hora: '08:00', estado: 'Facturado', precio: 380.00
  });
  await asignar(sFactAnulada, [
    { id_tecnico: tecnicos[2].id, principal: true, documentacion: true, checklist: true }
  ], [{ tipo: 'Material', nombre: 'Suministros estándar', cantidad: 1, unidad: 'Juego', estado: 'Confirmado' }], 'Aprobado');
  await transicionEstado(sFactAnulada.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro', 'Cobrado total', 'Facturado'], usrAdmin.id, dias(-18));
  await crearGuia(sFactAnulada, { codigo_guia: 'G-2026-028', observaciones: 'Mantenimiento conforme.' });
  await crearServicioRealizado(sFactAnulada, { estado_cobro: 'Pagado', estado_facturacion: 'Facturado', fecha_realizacion: dias(-18) });
  const cobroFactAnulada = await crearCobro(sFactAnulada, {
    monto: 380, abonado: 380, cuotas: 1, cuotas_pagadas: 1, estado_cobro: 'Pagado',
    fecha_ultimo: iso(dias(-12)),
    pagos: [{ monto: 380, fecha: iso(dias(-12)), metodo: 'Plin' }]
  });
  // Primera factura: anulada por error
  await crearFactura(sFactAnulada, cobroFactAnulada, {
    numero: 'F001-000800', fecha: iso(dias(-11)), monto: 380, estado: 'Anulada',
    archivo: { nombre_original: 'factura-800.pdf', ruta_almacenamiento: '/uploads/documents/factura-800.pdf', mime_type: 'application/pdf', tamano_bytes: 82000, subido_por: usrCont.id }
  });
  // Segunda factura: correcta
  await crearFactura(sFactAnulada, cobroFactAnulada, {
    numero: 'F001-000801', fecha: iso(dias(-10)), monto: 380, estado: 'Emitida',
    archivo: { nombre_original: 'factura-801.pdf', ruta_almacenamiento: '/uploads/documents/factura-801.pdf', mime_type: 'application/pdf', tamano_bytes: 84000, subido_por: usrCont.id }
  });
  await audit('tbl_facturas', cobroFactAnulada.id, 'STATUS_CHANGE', { estado_anterior: 'Emitida', estado_nuevo: 'Anulada', motivo: 'Error en monto' }, usrCont.id);

  // ── 25. SERVICIO DE MANTENIMIENTO CONTINUO ───────────────────────
  let planMant1 = await prisma.tbl_mantenimientos_planes.findFirst({ where: { id_ascensor: ascensores[3].id, tipo_plan: 'continuo' } });
  if (!planMant1) {
    planMant1 = await prisma.tbl_mantenimientos_planes.create({
      data: {
        id_cliente: clientes[2].id, id_ascensor: ascensores[3].id, id_tipo_servicio: tipos[0].id,
        tipo_plan: 'continuo', frecuencia: 'semanal', cantidad_mantenimientos: 12,
        fecha_inicio: dias(-7), hora_programada: '10:00',
        precio: 250, moneda: 'PEN', estado_plan: 'activo',
        observaciones: 'Plan semanal Torre 1 - cliente residencial'
      }
    });
  }
  // Crear servicio futuro del plan
  const sMantContinuo = await crearServicio({
    codigo: 'SRV-2026-000025', id_cliente: clientes[2].id, id_ascensor: ascensores[3].id,
    id_tipo: tipos[0].id, titulo: 'Mantenimiento semanal Torre 1',
    descripcion: 'Servicio programado automáticamente por plan continuo',
    fecha: iso(dias(7)), hora: '10:00', estado: 'Pendiente', precio: 250.00,
    origen: 'mantenimiento', id_mantenimiento_plan: planMant1.id
  });
  await transicionEstado(sMantContinuo.id, ['Pendiente'], usrAdmin.id, dias(-1));

  let planMant2 = await prisma.tbl_mantenimientos_planes.findFirst({ where: { id_ascensor: ascensores[8].id, tipo_plan: 'continuo' } });
  if (!planMant2) {
    planMant2 = await prisma.tbl_mantenimientos_planes.create({
      data: {
        id_cliente: clientes[6].id, id_ascensor: ascensores[8].id, id_tipo_servicio: tipos[0].id,
        tipo_plan: 'continuo', frecuencia: 'mensual', cantidad_mantenimientos: 6,
        fecha_inicio: dias(8), hora_programada: '08:30',
        precio: 380, moneda: 'PEN', estado_plan: 'activo'
      }
    });
  }

  // Plan eventual (proyecto puntual) — sin frecuencia ni cantidad
  let planMant3 = await prisma.tbl_mantenimientos_planes.findFirst({ where: { id_ascensor: ascensores[5].id, tipo_plan: 'eventual' } });
  if (!planMant3) {
    planMant3 = await prisma.tbl_mantenimientos_planes.create({
      data: {
        id_cliente: clientes[4].id, id_ascensor: ascensores[5].id, id_tipo_servicio: tipos[1].id,
        tipo_plan: 'eventual',
        fecha_inicio: dias(15), hora_programada: '14:00',
        precio: 540, moneda: 'PEN', estado_plan: 'activo'
      }
    });
  }

  // ─── EMERGENCIAS (varios estados) ─────────────────────────────────
  // Emergencia activa (vinculada a sEnCurso1)
  const emExistente = await prisma.tbl_emergencias.findFirst({ where: { id_servicio: sEnCurso1.id } });
  if (!emExistente) {
    await prisma.tbl_emergencias.create({
      data: {
        id_servicio: sEnCurso1.id, id_cliente: clientes[3].id, id_ascensor: ascensores[4].id,
        motivo: 'Ascensor detenido entre pisos con personas adentro',
        nivel_urgencia: 'alta', estado_emergencia: 'En atención',
        observaciones: 'Reportada por contacto principal, técnico en sitio'
      }
    });
  }

  // Emergencia atendida (vinculada a sFinObservado)
  const emFinObs = await prisma.tbl_emergencias.findFirst({ where: { id_servicio: sFinObservado.id } });
  if (!emFinObs) {
    await prisma.tbl_emergencias.create({
      data: {
        id_servicio: sFinObservado.id, id_cliente: clientes[2].id, id_ascensor: ascensores[3].id,
        motivo: 'Ascensor con falla nocturna intermitente',
        nivel_urgencia: 'media', estado_emergencia: 'Atendida',
        observaciones: 'Atendida en horario nocturno'
      }
    });
  }

  // Emergencia reportada (no asignada aún)
  await prisma.tbl_emergencias.create({
    data: {
      id_cliente: clientes[7].id, id_ascensor: ascensores[10].id,
      motivo: 'Ruido fuerte al iniciar marcha — bloque comercial',
      nivel_urgencia: 'media', estado_emergencia: 'Reportada',
      observaciones: 'Reportado por administrador del condominio. Pendiente asignación.'
    }
  });

  // Emergencia cerrada histórica (vinculada a sCerrado proyecto, no, mejor a una nueva)
  const sEmCerrada = await crearServicio({
    codigo: 'SRV-2026-000026', id_cliente: clientes[5].id, id_ascensor: ascensores[7].id,
    id_tipo: tipos[4].id, titulo: 'Emergencia banco San Borja',
    descripcion: 'Falla eléctrica resuelta',
    fecha: iso(dias(-40)), hora: '13:00', estado: 'Cerrado', precio: 650.00,
    origen: 'emergencia', prioridad: 'alta'
  });
  await asignar(sEmCerrada, [{ id_tecnico: tecnicos[0].id, principal: true, documentacion: true, checklist: true }],
    [{ tipo: 'Repuesto', nombre: 'Fusibles industriales', cantidad: 3, unidad: 'Unidad', estado: 'Confirmado' }], 'Aprobado');
  await transicionEstado(sEmCerrada.id, ['Pendiente', 'Asignado', 'Checklist de salida pendiente', 'Listo para salida', 'En camino', 'En curso', 'Finalizado por técnico', 'En revisión administrativa', 'A gestión de cobro', 'En cobro', 'Cobrado total', 'Facturado', 'Cerrado'], usrAdmin.id, dias(-40));
  await crearGuia(sEmCerrada, { codigo_guia: 'G-2026-026', observaciones: 'Emergencia resuelta, ascensor restaurado.' });
  await crearServicioRealizado(sEmCerrada, { estado_cobro: 'Cerrado', estado_facturacion: 'Facturado', estado_administrativo: 'Cerrado', fecha_realizacion: dias(-40) });
  const cobroEmCerrada = await crearCobro(sEmCerrada, {
    monto: 650, abonado: 650, cuotas: 1, cuotas_pagadas: 1, estado_cobro: 'Cerrado',
    pagos: [{ monto: 650, fecha: iso(dias(-30)), metodo: 'Transferencia' }],
    fecha_ultimo: iso(dias(-30))
  });
  await crearFactura(sEmCerrada, cobroEmCerrada, {
    numero: 'F001-000234', fecha: iso(dias(-29)), monto: 650, estado: 'Adjunta',
    archivo: { nombre_original: 'factura-234.pdf', ruta_almacenamiento: '/uploads/documents/factura-234.pdf', mime_type: 'application/pdf', tamano_bytes: 92000, subido_por: usrCont.id }
  });
  await prisma.tbl_emergencias.create({
    data: {
      id_servicio: sEmCerrada.id, id_cliente: clientes[5].id, id_ascensor: ascensores[7].id,
      motivo: 'Falla eléctrica completa', nivel_urgencia: 'alta',
      estado_emergencia: 'Cerrada', observaciones: 'Atendida y cerrada hace 30 días',
      fecha_reporte: dias(-40)
    }
  });

  // ─── LEADS (varios estados) ────────────────────────────────────────
  const leadsDemo = [
    { nombre_contacto: 'Comercial Plaza Norte', telefono: '999111222', canal: 'WhatsApp', id_tipo_servicio_solicitado: tipos[7].id, estado_lead: 'nuevo', observaciones: 'Interesados en cotizar instalación nueva en plaza comercial' },
    { nombre_contacto: 'Edificio Madrid Real', telefono: '999333444', canal: 'Web', id_tipo_servicio_solicitado: tipos[0].id, estado_lead: 'contactado', observaciones: 'Llamada inicial realizada, esperando reunión' },
    { nombre_contacto: 'Constructora ABC', telefono: '999555666', canal: 'Referido', id_tipo_servicio_solicitado: tipos[8].id, estado_lead: 'calificado', observaciones: 'Cliente serio, propuesta enviada por proyecto de 4 ascensores' },
    { nombre_contacto: 'Sra. Rivera (residencial)', telefono: '999777888', canal: 'Llamada', id_tipo_servicio_solicitado: tipos[1].id, estado_lead: 'descartado', observaciones: 'No tiene presupuesto, descartado tras evaluación' }
  ];
  for (const l of leadsDemo) {
    const ex = await prisma.tbl_leads.findFirst({ where: { nombre_contacto: l.nombre_contacto } });
    if (!ex) await prisma.tbl_leads.create({ data: { ...l, user_id_registration: usrCoord.id } });
  }

  // Lead convertido (ya conectado al cliente 7 - Universidad Pacífico Norte que tuvo el proyecto)
  const leadConv = await prisma.tbl_leads.findFirst({ where: { nombre_contacto: 'Universidad Pacífico Norte (lead inicial)' } });
  if (!leadConv) {
    await prisma.tbl_leads.create({
      data: {
        nombre_contacto: 'Universidad Pacífico Norte (lead inicial)',
        telefono: '921098765', canal: 'Email',
        id_tipo_servicio_solicitado: tipos[8].id,
        cliente_existente: 0, id_cliente: clientes[6].id,
        estado_lead: 'convertido',
        observaciones: 'Convertido a cliente y proyecto SRV-2026-000020',
        id_servicio_convertido: sCerrado.id,
        user_id_registration: usrCoord.id
      }
    });
  }

  // ─── ATENCIONES RÁPIDAS (varios estados) ──────────────────────────
  const atencionesDemo = [
    { nombre_contacto: 'Sra. Pérez', telefono: '987000123', mensaje_rapido: 'Ascensor hace ruido al subir', tipo_solicitud: 'Consulta técnica', nivel_urgencia: 'media', estado_atencion: 'nueva' },
    { nombre_contacto: 'Sr. López (Edificio Bolivar)', telefono: '987000456', mensaje_rapido: 'Ascensor se queda corto en piso 5', tipo_solicitud: 'Reparación', nivel_urgencia: 'alta', estado_atencion: 'en gestión' },
    { nombre_contacto: 'Recepción Hospital Norte', telefono: '987000789', mensaje_rapido: 'Necesitamos revisión urgente', tipo_solicitud: 'Emergencia', nivel_urgencia: 'alta', estado_atencion: 'descartada', observaciones: 'No era nuestro cliente, derivado a otra empresa' }
  ];
  for (const a of atencionesDemo) {
    const ex = await prisma.tbl_atenciones_rapidas.findFirst({ where: { nombre_contacto: a.nombre_contacto, telefono: a.telefono } });
    if (!ex) await prisma.tbl_atenciones_rapidas.create({ data: { ...a, user_id_registration: usrCoord.id } });
  }
  // Atención convertida
  const arConv = await prisma.tbl_atenciones_rapidas.findFirst({ where: { nombre_contacto: 'Hotel Costa Marina (consulta)' } });
  if (!arConv) {
    await prisma.tbl_atenciones_rapidas.create({
      data: {
        nombre_contacto: 'Hotel Costa Marina (consulta)',
        telefono: '943210987',
        mensaje_rapido: 'Necesitamos mantenimiento correctivo del Lobby',
        tipo_solicitud: 'Mantenimiento correctivo',
        nivel_urgencia: 'alta', estado_atencion: 'convertida',
        id_cliente: clientes[4].id, id_ascensor: ascensores[5].id,
        id_servicio_convertido: sEnCamino.id,
        observaciones: 'Convertida en servicio SRV-2026-000006',
        user_id_registration: usrCoord.id
      }
    });
  }

  // ─── EVENTOS DE CALENDARIO ADICIONALES (mantenimientos y emergencias) ─
  // Ya se crearon vía crearServicio. Verifico que los planes de mantenimiento tengan evento independiente.
  const evMant = await prisma.tbl_calendario_eventos.findFirst({ where: { id_mantenimiento_plan: planMant1.id, id_servicio: null } });
  if (!evMant) {
    await prisma.tbl_calendario_eventos.create({
      data: {
        id_mantenimiento_plan: planMant1.id, titulo: `Plan continuo · Torre 1`,
        tipo_evento: 'mantenimiento', fecha_inicio: dias(7),
        estado_evento: 'programado', color: '#22c55e'
      }
    });
  }

  // ─── SETEAR ESTADOS DE COBRO RECIENTES EN SERVICIOS REALIZADOS ────
  // Sincronizar estado_cobro de servicios realizados según el estado del cobro real
  const cobrosTodos = await prisma.tbl_cobros.findMany();
  for (const c of cobrosTodos) {
    await prisma.tbl_servicios_realizados.updateMany({
      where: { id_servicio: c.id_servicio },
      data: { estado_cobro: c.estado_cobro }
    });
  }

  // ─── AUDITORÍA ADICIONAL (acciones recientes) ─────────────────────
  await audit('tbl_servicios_proyectos', sCancelado.id, 'CANCEL', { motivo: 'Cliente solicitó cancelación' }, usrAdmin.id);
  await audit('tbl_servicios_proyectos', sCerrado.id, 'STATUS_CHANGE', { estado: 'Cerrado' }, usrCont.id);
  await audit('tbl_pagos', cobroCerrado.id, 'CREATE', { monto: 3125 }, usrCont.id);
  await audit('tbl_cobros', cobroIncobrable.id, 'INCOBRABLE', { motivo: 'Cliente en quiebra' }, usrSuper.id);

  console.log('✅ Seed completado.');
  console.log('───────────────────────────────────────────────');
  console.log('Clientes: 8 | Ascensores: 12 (todos los 6 estados) | Técnicos: 7 (todos los 5 estados)');
  console.log('Servicios: 28 (cubriendo TODOS los 16 estados + Finalizado observado)');
  console.log('Cobros: 9 estados (Pendiente, En gestión, Parcial, Vencido, En mora, Pagado, Cerrado, Incobrable, Sin cobro)');
  console.log('Checklist: 5 estados (Pendiente, En llenado, Completo, Observado, Aprobado)');
  console.log('Facturas: 5 estados (Sin factura, Pendiente, Emitida, Adjunta, Observada, Anulada)');
  console.log('Emergencias: 4 estados (Reportada, En atención, Atendida, Cerrada)');
  console.log('Leads: 5 estados (nuevo, contactado, calificado, convertido, descartado)');
  console.log('Atenciones rápidas: 4 estados (nueva, en gestión, convertida, descartada)');
  console.log('Mantenimientos: 3 planes (2 continuos + 1 eventual)');
  console.log('Entregas: 4 tipos × 4 estados (parcial, técnica, documental, final / pendiente, entregada, observada, aprobada)');
  console.log('───────────────────────────────────────────────');
  console.log('Usuarios demo (contraseña: admin123):');
  console.log('  superadmin@ascensoresjy.com (Super Admin)');
  console.log('  admin@ascensoresjy.com (Admin)');
  console.log('  coordinador@ascensoresjy.com (Coordinador)');
  console.log('  contabilidad@ascensoresjy.com (Contabilidad)');
  console.log('  carlos@ascensoresjy.com / juan@... / marco@... / diego@... / andres@... (Técnicos)');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

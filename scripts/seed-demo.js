/**
 * Datos de prueba para recorrer el flujo del sistema en local.
 *
 * NO ejecutar en producción: crea usuarios con contraseña conocida.
 * Idempotente — se puede correr varias veces sin duplicar.
 *
 *   node scripts/seed-demo.js
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const db = new PrismaClient();
const PASSWORD_DEMO = 'Demo2026!';

// Los catálogos padre los crea prisma/seed.js; aquí solo colgamos subtipos.
async function padre(categoriaFuncional) {
  const p = await db.tbl_tipos_servicio.findFirst({
    where: { categoria_funcional: categoriaFuncional, id_padre: null }
  });
  if (!p) throw new Error(`Falta el tipo de servicio padre '${categoriaFuncional}'. Corre antes: npm run db:seed`);
  return p;
}

/** Crea si no existe una fila que matchee `where`; devuelve la fila. */
async function asegurar(modelo, where, data) {
  const existente = await db[modelo].findFirst({ where });
  if (existente) return existente;
  return db[modelo].create({ data });
}

async function main() {
  console.log('🌱 Seed DEMO — datos de prueba\n');

  const padreServicios = await padre('SERVICIOS');
  const padreProyectos = await padre('PROYECTOS');

  // ---- Tipos de ascensor ------------------------------------------------
  const tiposAscensor = ['Electromecánico', 'Hidráulico', 'Montacargas', 'Panorámico', 'Salvaescaleras'];
  for (const nombre of tiposAscensor) {
    await db.tbl_tipos_ascensor.upsert({ where: { nombre }, update: {}, create: { nombre } });
  }
  console.log(`   ✔ ${tiposAscensor.length} tipos de ascensor`);

  // ---- Subtipos de servicio (requeridos para crear servicios) -----------
  // Un subtipo de SERVICIOS exige modulo_asociado; uno de PROYECTOS exige que sea null.
  const subtipos = [
    { nombre: 'Mantenimiento preventivo', id_padre: padreServicios.id, modulo_asociado: 'mantenimiento' },
    { nombre: 'Reparación correctiva', id_padre: padreServicios.id, modulo_asociado: 'correctivo' },
    { nombre: 'Emergencia 24/7', id_padre: padreServicios.id, modulo_asociado: 'emergencia' },
    { nombre: 'Atención rápida', id_padre: padreServicios.id, modulo_asociado: 'atencion_rapida' },
    { nombre: 'Instalación de ascensor', id_padre: padreProyectos.id, modulo_asociado: null }
  ];
  const subtipoPorNombre = {};
  for (const s of subtipos) {
    subtipoPorNombre[s.nombre] = await asegurar('tbl_tipos_servicio', { nombre: s.nombre, id_padre: s.id_padre }, s);
  }
  console.log(`   ✔ ${subtipos.length} subtipos de servicio`);

  // ---- Técnicos ---------------------------------------------------------
  const tecnicosData = [
    { nombre: 'Carlos Ramírez', telefono: '987654321', documento: '45678912', especialidades: 'Electromecánico, tracción' },
    { nombre: 'Juan Palomino', telefono: '987654322', documento: '45678913', especialidades: 'Hidráulico' },
    { nombre: 'Miguel Torres', telefono: '987654323', documento: '45678914', especialidades: 'Electrónica de control' },
    { nombre: 'Luis Fernández', telefono: '987654324', documento: '45678915', especialidades: 'Montacargas' },
    { nombre: 'Pedro Quispe', telefono: '987654325', documento: '45678916', especialidades: 'Instalación, obra' }
  ];
  const tecnicos = [];
  for (const t of tecnicosData) tecnicos.push(await asegurar('tbl_tecnicos', { documento: t.documento }, t));
  console.log(`   ✔ ${tecnicos.length} técnicos`);

  // ---- Usuarios (uno por rol) -------------------------------------------
  const hash = bcrypt.hashSync(PASSWORD_DEMO, 10);
  const roles = Object.fromEntries(
    (await db.tbl_roles.findMany()).map(r => [r.codigo, r.id])
  );
  const usuariosData = [
    { nombres: 'Ana Torres', correo: 'admin@ascensoresjy.com', id_rol: roles.admin },
    { nombres: 'Rosa Díaz', correo: 'coordinador@ascensoresjy.com', id_rol: roles.coordinador },
    { nombres: 'Marta Ruiz', correo: 'contabilidad@ascensoresjy.com', id_rol: roles.contabilidad },
    { nombres: 'Sofía Vargas', correo: 'vendedora@ascensoresjy.com', id_rol: roles.vendedora },
    { nombres: 'Lucía Mendoza', correo: 'central@ascensoresjy.com', id_rol: roles.central_ventas },
    // El usuario técnico se vincula a su ficha de técnico (id_tecnico es @unique).
    { nombres: 'Carlos Ramírez', correo: 'carlos@ascensoresjy.com', id_rol: roles.tecnico, id_tecnico: tecnicos[0].id }
  ];
  for (const u of usuariosData) {
    await db.tbl_usuarios.upsert({
      where: { correo: u.correo },
      update: { contrasena: hash, estado: 1 },
      create: { ...u, contrasena: hash, telefono: '900000000' }
    });
  }
  console.log(`   ✔ ${usuariosData.length} usuarios (password: ${PASSWORD_DEMO})`);

  // ---- Clientes + edificios + ascensores ---------------------------------
  const clientesData = [
    { nombre: 'Condominio Los Robles', doc: '20512345671', distrito: 'Miraflores', edificio: 'Torre Los Robles', tipo: 'Edificio' },
    { nombre: 'Inmobiliaria San Isidro SAC', doc: '20512345672', distrito: 'San Isidro', edificio: 'Edificio Basadre', tipo: 'Edificio' },
    { nombre: 'Clínica Santa Rosa', doc: '20512345673', distrito: 'Surco', edificio: 'Sede Central', tipo: 'Edificio' },
    { nombre: 'Centro Comercial Plaza Norte', doc: '20512345674', distrito: 'Independencia', edificio: 'Ala Sur', tipo: 'Edificio' },
    { nombre: 'Constructora Andina SAC', doc: '20512345675', distrito: 'La Molina', edificio: 'Obra Residencial Sol', tipo: 'Obra' }
  ];
  const marcas = ['Otis', 'Schindler', 'Mitsubishi', 'ThyssenKrupp', 'Kone'];
  const clientes = [];
  const ascensores = [];
  for (const [i, c] of clientesData.entries()) {
    const cliente = await asegurar('tbl_clientes', { numero_documento: c.doc }, {
      tipo_documento: 'RUC',
      numero_documento: c.doc,
      nombre: c.nombre,
      telefono: `01${4000000 + i}`,
      correo: `contacto${i + 1}@demo.com`,
      contacto_principal_nombre: 'Contacto Demo',
      contacto_principal_telefono: `9${11000000 + i}`,
      clasificacion: i % 2 === 0 ? 'A' : 'B',
      contrato_servicio_inicio: new Date('2026-01-01'),
      contrato_servicio_fin: new Date('2026-12-31')
    });
    clientes.push(cliente);

    const edificio = await asegurar('tbl_edificios', { id_cliente: cliente.id, nombre: c.edificio }, {
      id_cliente: cliente.id,
      tipo: c.tipo,
      nombre: c.edificio,
      direccion: `Av. Demo ${100 + i}`,
      distrito: c.distrito
    });

    const codigo = `ASC-${String(i + 1).padStart(3, '0')}`;
    ascensores.push(await db.tbl_ascensores.upsert({
      where: { codigo },
      update: {},
      create: {
        id_edificio: edificio.id,
        codigo,
        ubicacion: `Torre ${i + 1}`,
        tipo: tiposAscensor[i % tiposAscensor.length],
        marca: marcas[i % marcas.length],
        modelo: `Gen-${2020 + i}`,
        capacidad: `${600 + i * 100} kg`,
        pisos: 5 + i,
        anio_aproximado: 2015 + i,
        estado_operativo: i === 3 ? 'Fuera de servicio' : 'Operativo',
        fecha_instalacion: new Date(`${2015 + i}-06-15`)
      }
    }));
  }
  console.log(`   ✔ ${clientes.length} clientes, edificios y ascensores`);

  // ---- Servicios en distintos estados del flujo --------------------------
  const serviciosData = [
    { codigo: 'SRV-0001', subtipo: 'Mantenimiento preventivo', estado: 'Pendiente', titulo: 'Mantenimiento mensual', prioridad: 'media', precio: 450 },
    { codigo: 'SRV-0002', subtipo: 'Reparación correctiva', estado: 'Asignado', titulo: 'Cambio de cables de tracción', prioridad: 'alta', precio: 1800 },
    { codigo: 'SRV-0003', subtipo: 'Emergencia 24/7', estado: 'En curso', titulo: 'Persona atrapada en cabina', prioridad: 'alta', precio: 300 },
    { codigo: 'SRV-0004', subtipo: 'Atención rápida', estado: 'Finalizado por técnico', titulo: 'Ajuste de puertas', prioridad: 'baja', precio: 150 },
    { codigo: 'PRY-0001', subtipo: 'Instalación de ascensor', estado: 'Pendiente', titulo: 'Instalación ascensor 8 paradas', prioridad: 'media', precio: 85000 }
  ];
  const hoy = new Date();
  for (const [i, s] of serviciosData.entries()) {
    const subtipo = subtipoPorNombre[s.subtipo];
    const esProyecto = subtipo.id_padre === padreProyectos.id;
    const fecha = new Date(hoy);
    fecha.setDate(fecha.getDate() + i - 2); // algunas pasadas, otras futuras

    const servicio = await db.tbl_servicios_proyectos.upsert({
      where: { codigo: s.codigo },
      update: {},
      create: {
        codigo: s.codigo,
        tipo_registro: esProyecto ? 'proyecto' : 'servicio',
        id_tipo_servicio: subtipo.id,
        id_cliente: clientes[i].id,
        titulo: s.titulo,
        descripcion: `${s.titulo} — registro de prueba`,
        fecha_programada: fecha,
        hora_programada: '09:00',
        prioridad: s.prioridad,
        estado_servicio: s.estado,
        precio_interno: s.precio,
        moneda: 'PEN'
      }
    });

    await asegurar('tbl_servicios_ascensores',
      { id_servicio: servicio.id, id_ascensor: ascensores[i].id },
      { id_servicio: servicio.id, id_ascensor: ascensores[i].id, monto: s.precio });

    // Solo los que ya salieron de 'Pendiente' tienen técnico asignado.
    if (s.estado !== 'Pendiente') {
      await asegurar('tbl_servicios_asignaciones',
        { id_servicio: servicio.id, id_tecnico: tecnicos[i].id },
        {
          id_servicio: servicio.id,
          id_tecnico: tecnicos[i].id,
          rol_asignacion: 'Responsable',
          responsable_principal: 1,
          responsable_documentacion: 1,
          responsable_checklist: 1
        });
    }
  }
  console.log(`   ✔ ${serviciosData.length} servicios/proyectos`);

  // ---- Cuentas bancarias (para PDFs de cotización) -----------------------
  const cuentas = [
    { nombre: 'BCP Soles', banco: 'BCP', tipo_cuenta: 'Corriente', moneda: 'PEN', numero_cuenta: '191-1234567-0-01', cci: '00219100123456700129', titular: 'Ascensores Jy S.A.C.', orden: 1 },
    { nombre: 'BBVA Dólares', banco: 'BBVA', tipo_cuenta: 'Corriente', moneda: 'USD', numero_cuenta: '0011-0234-0100987654', cci: '01123400100987654432', titular: 'Ascensores Jy S.A.C.', orden: 2 }
  ];
  for (const c of cuentas) await asegurar('tbl_cuentas_bancarias', { numero_cuenta: c.numero_cuenta }, c);
  console.log(`   ✔ ${cuentas.length} cuentas bancarias`);

  // ---- Plantillas de checklist de finalización ---------------------------
  const plantillas = [
    { categoria: 'mantenimiento', titulo: 'Checklist de mantenimiento preventivo', items: ['Verificar nivel de aceite', 'Revisar cables de tracción', 'Probar botonera de cabina', 'Comprobar luz de emergencia', 'Limpiar foso'] },
    { categoria: 'correctivo', titulo: 'Checklist de reparación correctiva', items: ['Falla reproducida antes de intervenir', 'Repuesto instalado y probado', 'Pruebas de recorrido completo', 'Zona de trabajo limpia'] },
    { categoria: 'emergencia', titulo: 'Checklist de atención de emergencia', items: ['Usuarios evacuados de forma segura', 'Causa de la parada identificada', 'Ascensor operativo o bloqueado con señalización'] }
  ];
  for (const p of plantillas) {
    const plantilla = await db.tbl_checklist_plantillas.upsert({
      where: { categoria: p.categoria },
      update: {},
      create: { categoria: p.categoria, titulo: p.titulo, activa: 1 }
    });
    for (const [orden, texto] of p.items.entries()) {
      await asegurar('tbl_checklist_plantilla_items',
        { id_plantilla: plantilla.id, texto },
        { id_plantilla: plantilla.id, texto, orden, grupo: 'General' });
    }
  }
  console.log(`   ✔ ${plantillas.length} plantillas de checklist`);

  console.log('\n───────────────────────────────────────────────');
  console.log('✅ Seed DEMO completado.');
  console.log('───────────────────────────────────────────────');
  console.log(`Usuarios demo (contraseña: ${PASSWORD_DEMO}):`);
  for (const u of usuariosData) console.log(`  • ${u.correo}`);
  console.log('\nSuperadmin del seed base: superadmin@ascensoresjy.com / Admin2026!');
}

main()
  .catch(e => { console.error('❌ Error en seed demo:', e); process.exit(1); })
  .finally(() => db.$disconnect());

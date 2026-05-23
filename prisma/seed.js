/**
 * SEED PRODUCCIÓN — Ascensores Jy
 *
 * Genera ÚNICAMENTE la información indispensable para que la aplicación
 * arranque y se pueda iniciar sesión. Toda la data operativa (clientes,
 * ascensores, técnicos, servicios, cobros, cotizaciones, etc.) se crea
 * desde la UI.
 *
 * Contenido sembrado:
 *   1. tbl_roles                — 5 roles del sistema (códigos usados por el backend).
 *   2. tbl_permisos             — Matriz de permisos del sistema.
 *   3. tbl_roles_permisos       — Asignación por defecto de permisos por rol.
 *   4. tbl_usuarios             — 1 super_admin para el primer login.
 *   5. tbl_configuracion        — Claves de configuración con placeholders editables
 *                                  desde la pantalla de configuración.
 *
 * Catálogos editables que QUEDAN VACÍOS (el super_admin los configura desde la UI):
 *   - tbl_tipos_ascensor
 *   - tbl_tipos_servicio
 *   - tbl_cuentas_bancarias
 *   - tbl_checklist_plantillas / tbl_checklist_plantilla_items
 *
 * Variables de entorno opcionales:
 *   - SEED_ADMIN_EMAIL     (default: superadmin@ascensoresjy.com)
 *   - SEED_ADMIN_PASSWORD  (default: Admin2026!  ←  CAMBIAR INMEDIATAMENTE TRAS PRIMER LOGIN)
 *   - SEED_ADMIN_NOMBRE    (default: Super Administrador)
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
async function upsertRol(codigo, nombre, descripcion) {
  return prisma.tbl_roles.upsert({
    where: { codigo },
    update: { nombre, descripcion },
    create: { codigo, nombre, descripcion }
  });
}

async function upsertPermiso(codigo, nombre, recurso, tipo) {
  return prisma.tbl_permisos.upsert({
    where: { codigo },
    update: { nombre, recurso, tipo },
    create: { codigo, nombre, recurso, tipo }
  });
}

async function asignarPermisos(idRol, permisos, codigos) {
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

async function upsertConfig(clave, valor, tipo, descripcion) {
  return prisma.tbl_configuracion.upsert({
    where: { clave },
    update: {}, // no sobreescribir si el admin ya lo editó
    create: { clave, valor: String(valor), tipo, descripcion }
  });
}

async function main() {
  console.log('🌱 Seed PRODUCCIÓN — Ascensores Jy');

  // ═════════════════════════════════════════════════════════════════
  // 1. ROLES DEL SISTEMA
  //    Los códigos están referenciados en el backend (middlewares, lógica
  //    de permisos) y en el frontend (rutas protegidas). NO modificar.
  // ═════════════════════════════════════════════════════════════════
  const rolSuper = await upsertRol('super_admin', 'Super Administrador', 'Control total del sistema');
  const rolAdmin = await upsertRol('admin', 'Administrador', 'Administración operativa');
  const rolCoord = await upsertRol('coordinador', 'Coordinador', 'Coordinación diaria de servicios');
  const rolTec = await upsertRol('tecnico', 'Técnico', 'Ejecución técnica en campo');
  const rolCont = await upsertRol('contabilidad', 'Contabilidad', 'Cobros y facturación');

  // ═════════════════════════════════════════════════════════════════
  // 2. PERMISOS DEL SISTEMA (recurso.accion)
  // ═════════════════════════════════════════════════════════════════
  const recursos = [
    ['clientes', 'Clientes'],
    ['ascensores', 'Ascensores'],
    ['tecnicos', 'Técnicos'],
    ['tipos_servicio', 'Tipos de servicio'],
    ['servicios', 'Servicios/Proyectos'],
    ['cobros', 'Gestión de cobros'],
    ['facturas', 'Facturas'],
    ['emergencias', 'Emergencias'],
    ['mantenimientos', 'Mantenimientos'],
    ['leads', 'Leads'],
    ['atenciones_rapidas', 'Atención rápida'],
    ['calendario', 'Calendario'],
    ['reportes', 'Reportes'],
    ['usuarios', 'Usuarios'],
    ['auditoria', 'Auditoría'],
    ['entregas', 'Entregas']
  ];
  const acciones = ['ver', 'crear', 'editar', 'eliminar'];
  const permisos = [];
  for (const [rec, nomRec] of recursos) {
    for (const acc of acciones) {
      permisos.push(await upsertPermiso(`${rec}.${acc}`, `${acc} ${nomRec}`, rec, acc));
    }
  }
  permisos.push(await upsertPermiso('precios.ver', 'Ver precios internos', 'precios', 'ver'));

  // ═════════════════════════════════════════════════════════════════
  // 3. ASIGNACIÓN DE PERMISOS POR ROL (defaults del sistema)
  //    El super_admin puede ajustar desde la UI si lo necesita.
  // ═════════════════════════════════════════════════════════════════
  await asignarPermisos(rolSuper.id, permisos, permisos.map(p => p.codigo));

  await asignarPermisos(rolAdmin.id, permisos,
    permisos
      .filter(p => !p.codigo.startsWith('usuarios.') || p.codigo === 'usuarios.ver')
      .map(p => p.codigo)
  );

  await asignarPermisos(rolCoord.id, permisos, [
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

  await asignarPermisos(rolTec.id, permisos, [
    'clientes.ver', 'ascensores.ver',
    'servicios.ver', 'servicios.editar',
    'calendario.ver'
  ]);

  await asignarPermisos(rolCont.id, permisos, [
    'clientes.ver', 'ascensores.ver', 'tipos_servicio.ver',
    'servicios.ver',
    'cobros.ver', 'cobros.crear', 'cobros.editar',
    'facturas.ver', 'facturas.crear', 'facturas.editar',
    'reportes.ver', 'precios.ver',
    'emergencias.ver', 'mantenimientos.ver', 'entregas.ver'
  ]);

  // ═════════════════════════════════════════════════════════════════
  // 4. USUARIO SUPER_ADMIN (único usuario inicial)
  //    Credenciales por defecto: cámbialas inmediatamente tras el primer login.
  // ═════════════════════════════════════════════════════════════════
  const correoAdmin = process.env.SEED_ADMIN_EMAIL || 'superadmin@ascensoresjy.com';
  const passwordAdmin = process.env.SEED_ADMIN_PASSWORD || 'Admin2026!';
  const nombreAdmin = process.env.SEED_ADMIN_NOMBRE || 'Super Administrador';

  const existe = await prisma.tbl_usuarios.findUnique({ where: { correo: correoAdmin } });
  if (!existe) {
    await prisma.tbl_usuarios.create({
      data: {
        nombres: nombreAdmin,
        correo: correoAdmin,
        contrasena: bcrypt.hashSync(passwordAdmin, 10),
        id_rol: rolSuper.id,
        estado: 1
      }
    });
    console.log(`   ✔ Super admin creado: ${correoAdmin}`);
  } else {
    console.log(`   ℹ Super admin ya existe (${correoAdmin}) — no se modifica.`);
  }

  // ═════════════════════════════════════════════════════════════════
  // 5. CONFIGURACIÓN DEL SISTEMA (placeholders editables desde la UI)
  //    Estas claves alimentan PDFs de cotización, cálculo de IGV,
  //    avisos de vencimiento de contrato y centrado del mapa de clientes.
  //    Mantener sincronizado con utils/configuracion.js (DEFAULTS / TIPOS).
  // ═════════════════════════════════════════════════════════════════
  await upsertConfig('IGV_RATE', '0.18', 'number', 'Tasa de IGV (decimal, ej. 0.18 = 18%)');
  await upsertConfig('COTIZACION_VALIDEZ_DIAS', '15', 'number', 'Días de validez por defecto de una cotización');
  await upsertConfig('COTIZACION_TERMINOS', 'Cotización válida hasta la fecha indicada. Precios en soles, incluyen IGV. Forma de pago se acuerda al confirmar el servicio.', 'string', 'Términos por defecto impresos en el PDF de cotización');
  await upsertConfig('EMPRESA_RAZON_SOCIAL', 'Ascensores Jy S.A.C.', 'string', 'Razón social mostrada en cabeceras y PDFs');
  await upsertConfig('EMPRESA_RUC', '20000000000', 'string', 'RUC de la empresa');
  await upsertConfig('EMPRESA_DIRECCION', 'Lima, Perú', 'string', 'Dirección fiscal de la empresa');
  await upsertConfig('EMPRESA_TELEFONO', '', 'string', 'Teléfono de contacto de la empresa');
  await upsertConfig('EMPRESA_CORREO', '', 'string', 'Correo de contacto de la empresa');
  await upsertConfig('CLIENTES_DIAS_AVISO_VENCIMIENTO_CONTRATO', '30', 'number', 'Días de antelación para avisar vencimiento de contrato de cliente');
  await upsertConfig('MAPA_CENTRO_LAT', '-12.0464', 'number', 'Latitud por defecto del mapa de clientes (Lima)');
  await upsertConfig('MAPA_CENTRO_LNG', '-77.0428', 'number', 'Longitud por defecto del mapa de clientes (Lima)');
  await upsertConfig('MAPA_ZOOM_DEFAULT', '12', 'number', 'Zoom por defecto del mapa de clientes');

  console.log('───────────────────────────────────────────────');
  console.log('✅ Seed completado (modo PRODUCCIÓN).');
  console.log('───────────────────────────────────────────────');
  console.log(`Usuario inicial: ${correoAdmin}`);
  console.log(`Contraseña:      ${passwordAdmin}`);
  console.log('⚠  CAMBIAR LA CONTRASEÑA INMEDIATAMENTE TRAS EL PRIMER LOGIN.');
  console.log('');
  console.log('Catálogos vacíos a configurar desde la UI:');
  console.log('  • Tipos de ascensor');
  console.log('  • Tipos de servicio  (REQUERIDO antes de crear cualquier servicio)');
  console.log('  • Cuentas bancarias  (para PDFs de cotización)');
  console.log('  • Plantillas de checklist de finalización  (mantenimiento/correctivo/emergencia)');
  console.log('  • Datos de empresa en Configuración  (RUC, dirección, teléfono, correo)');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

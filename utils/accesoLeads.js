/**
 * SSoT de ACCESO al módulo LEADS: qué rol hace qué y qué leads ve cada uno.
 *
 * Flujo comercial:
 *   1. La CENTRAL DE VENTAS (rol `central_ventas`) es el punto de captura: da de
 *      alta el lead y registra a qué Vendedora queda asignado. Solo tiene acceso
 *      a este módulo (ninguna otra ruta del sistema).
 *   2. La VENDEDORA asignada ve ÚNICAMENTE sus leads (id_vendedor = su usuario),
 *      puede editarlos y convertirlos en cliente/servicio. No da de alta leads
 *      ni ve la cartera de las demás.
 *   3. Administración (super_admin, admin, coordinador) mantiene la visión
 *      completa de la cartera.
 *
 * Este archivo es el único lugar donde se declaran esas reglas: las rutas
 * (leadsRoutes) y el controlador (leadsController) las consumen desde aquí.
 */

const ROL_VENDEDORA = 'vendedora';
const ROL_CENTRAL_VENTAS = 'central_ventas';

// Roles con visión de TODA la cartera de leads.
const ROLES_LEADS_GLOBALES = ['super_admin', 'admin', 'coordinador', ROL_CENTRAL_VENTAS];

// Alta de leads: la Central de ventas y el superadministrador. La Vendedora ya
// no registra leads: solo trabaja los que la Central le asigna.
const ROLES_ALTA_LEAD = ['super_admin', ROL_CENTRAL_VENTAS];

// Lectura de la lista y del detalle (la Vendedora, acotada a los suyos).
const ROLES_LECTURA_LEAD = [...ROLES_LEADS_GLOBALES, ROL_VENDEDORA];

// Edición de los datos del lead: la Central corrige cualquiera; la Vendedora,
// solo los suyos (el alcance por lead lo aplica `puedeVerLead`).
const ROLES_EDICION_LEAD = [...ROLES_LEADS_GLOBALES, ROL_VENDEDORA];

// Ciclo comercial del lead: cambio de estado, descarte y cotizaciones adjuntas.
const ROLES_GESTION_LEAD = [...ROLES_LEADS_GLOBALES];

// Conversión a cliente/servicio: la Vendedora responsable (más administración).
const ROLES_CONVERSION_LEAD = ['super_admin', 'admin', ROL_VENDEDORA];

// A quién se puede ASIGNAR un lead. Coincide con quien puede convertirlo: no
// tiene sentido asignar un lead a alguien que después no podrá trabajarlo.
// Incluye administración porque en la práctica parte del equipo comercial está
// dado de alta con esos roles y no con el rol `vendedora`.
const ROLES_ASIGNABLES_LEAD = [...ROLES_CONVERSION_LEAD];

/** ¿Este usuario solo puede ver los leads que tiene asignados? */
const soloSusLeads = (user) => user?.rol_codigo === ROL_VENDEDORA;

/** Fragmento Prisma que acota la consulta de leads al usuario (o {} si ve todo). */
const leadAlcanceWhere = (user) => (soloSusLeads(user) ? { id_vendedor: user.id } : {});

/** ¿El usuario puede ver/operar este lead concreto? */
const puedeVerLead = (user, lead) => !soloSusLeads(user) || (!!lead && lead.id_vendedor === user.id);

/** ¿Puede gestionar el ciclo comercial (estado, descarte, cotizaciones)? */
const puedeGestionarLead = (user) => ROLES_GESTION_LEAD.includes(user?.rol_codigo);

module.exports = {
  ROL_VENDEDORA,
  ROL_CENTRAL_VENTAS,
  ROLES_LEADS_GLOBALES,
  ROLES_ALTA_LEAD,
  ROLES_LECTURA_LEAD,
  ROLES_EDICION_LEAD,
  ROLES_GESTION_LEAD,
  ROLES_CONVERSION_LEAD,
  ROLES_ASIGNABLES_LEAD,
  soloSusLeads,
  leadAlcanceWhere,
  puedeVerLead,
  puedeGestionarLead
};

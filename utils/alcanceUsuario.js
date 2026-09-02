/**
 * SSoT de ALCANCE de acceso por usuario (Servicios / Proyectos).
 *
 * Los roles Administrador y Coordinador pueden estar acotados a uno o ambos
 * ámbitos mediante los flags `acceso_servicios` / `acceso_proyectos` del usuario
 * (tbl_usuarios). El ámbito mapea 1:1 al `tipo_registro` de
 * tbl_servicios_proyectos: Servicios → 'servicio', Proyectos → 'proyecto'.
 *
 * A partir de ese mapeo, un usuario acotado solo ve:
 *   - clientes de su(s) ámbito(s) (ver clienteAlcanceWhere),
 *   - ascensores de esos clientes,
 *   - servicios/proyectos y datos derivados de su(s) ámbito(s),
 *   - los módulos correspondientes (los demás se bloquean por ruta).
 *
 * El resto de roles (super_admin, contabilidad, tecnico) NO se filtra por ámbito.
 *
 * Toda la lógica de ámbito vive aquí; no debe duplicarse ni hardcodearse en los
 * controladores ni en las rutas.
 */

const { TIPO_REGISTRO } = require('./clasificacionServicio');
const { TIPOS_EDIFICIO } = require('./catalogosEdificios');
const { CAMPOS_CONTRATO_AREA } = require('./catalogosClientes');

// Roles cuyo acceso se acota por los flags de ámbito. Único lugar donde se define.
// Incluye la lista de clientes: un usuario acotado solo ve los clientes de su(s)
// área(s), igual que el resto de módulos.
const ROLES_CON_ALCANCE = ['admin', 'coordinador'];

// Roles cuyo acceso se acota por TIPO de edificio (Edificio / Obra). A diferencia
// del ámbito Servicios/Proyectos, esta restricción aplica solo al Administrador.
const ROLES_CON_ALCANCE_EDIFICIOS = ['admin'];

// Conjunto completo de ámbitos. Tener TODOS habilitados equivale a no estar acotado.
const TODOS_LOS_TIPOS = Object.values(TIPO_REGISTRO);

// Centinela imposible para forzar "ningún resultado" cuando un usuario acotado
// quedara sin ámbitos (no debería ocurrir: se valida al crear/editar usuario).
const NINGUNO = ['__sin_ambito__'];

/** ¿El acceso de este usuario se filtra por ámbito? */
function aplicaAlcance(user) {
  return !!user && ROLES_CON_ALCANCE.includes(user.rol_codigo);
}

/**
 * Lista de `tipo_registro` que el usuario puede ver.
 *   - rol no acotado → null (sin restricción).
 *   - rol acotado    → subconjunto de ['servicio','proyecto'] según sus flags.
 * Un flag ausente (p.ej. token emitido antes de esta función) se interpreta
 * como habilitado (!= 0) para no bloquear sesiones existentes.
 * Si el usuario tiene habilitados TODOS los ámbitos no está acotado: devuelve
 * null (sin restricción), igual que un rol no acotado, para que vea también los
 * clientes/ascensores que aún no tienen registros asociados.
 */
function tiposRegistroPermitidos(user) {
  if (!aplicaAlcance(user)) return null;
  const tipos = [];
  if (Number(user.acceso_servicios) !== 0) tipos.push(TIPO_REGISTRO.SERVICIO);
  if (Number(user.acceso_proyectos) !== 0) tipos.push(TIPO_REGISTRO.PROYECTO);
  if (tipos.length === TODOS_LOS_TIPOS.length) return null;
  return tipos;
}

/** ¿El usuario puede ver registros de un `tipo_registro` dado? */
function puedeVerTipoRegistro(user, tipoRegistro) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return true;
  return tipos.includes(tipoRegistro);
}

/** Helper interno: `{ in: [...] }` con centinela si la lista quedó vacía. */
function inTipos(tipos) {
  return { in: tipos.length ? tipos : NINGUNO };
}

/** Fragmento Prisma para filtrar tbl_servicios_proyectos por ámbito. */
function servicioAlcanceWhere(user) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  return { tipo_registro: inTipos(tipos) };
}

/**
 * Fragmento Prisma para tbl_clientes: solo los clientes del/de los ámbito(s) del
 * usuario. Un cliente pertenece a un área si cumple CUALQUIERA de estas señales:
 *
 *   1. Tiene contrato de esa área (inicio y fin registrados). Es la marca
 *      explícita y la que existe desde el minuto uno: al crear un cliente es
 *      obligatorio registrar el contrato de al menos un área, y un usuario
 *      acotado solo puede llenar la suya. Así un cliente recién creado no
 *      desaparece de la lista de quien lo creó.
 *   2. Tiene al menos un servicio/proyecto de esa área. Cubre a los clientes con
 *      historial cuyo contrato quedó registrado solo en la otra área.
 *
 * Un cliente con contrato (o actividad) en ambas áreas lo ven los dos ámbitos,
 * que es lo correcto: es cliente de las dos.
 */
function clienteAlcanceWhere(user) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  const condiciones = tipos.map(t => {
    const campos = CAMPOS_CONTRATO_AREA[t];
    return { [campos.inicio]: { not: null }, [campos.fin]: { not: null } };
  });
  // Con `tipos` vacío esta condición usa el centinela y no devuelve nada, que es
  // el resultado esperado para un usuario acotado que quedara sin ámbitos.
  condiciones.push({ servicios: { some: { estado: 1, tipo_registro: inTipos(tipos) } } });
  return { OR: condiciones };
}

/**
 * Fragmento Prisma para tbl_ascensores: solo ascensores de clientes del ámbito
 * (vía edificio).
 *
 * Delega en `clienteAlcanceWhere` para que "cliente del ámbito" signifique
 * EXACTAMENTE lo mismo aquí que en la lista de clientes. Antes esta función
 * repetía por su cuenta solo la segunda señal (tener servicios del área) y
 * omitía la del contrato: un cliente recién creado se veía en la lista, pero sus
 * ascensores no aparecían por ningún lado hasta que alguien le registrara el
 * primer servicio — y como para registrarlo hay que elegir el ascensor, el
 * usuario acotado quedaba sin salida (no podía cotizar ni crear el servicio).
 */
function ascensorAlcanceWhere(user) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  return { edificio: { is: { cliente: { is: clienteAlcanceWhere(user) } } } };
}

/**
 * Fragmento Prisma para una relación cuyo path llega a un servicio/proyecto.
 * `relacion` es el nombre de la relación a tbl_servicios_proyectos (por defecto
 * 'servicio'). Útil para tbl_entregas, tbl_servicios_realizados, etc.
 */
function porServicioRelacionWhere(user, relacion = 'servicio') {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  return { [relacion]: { is: { tipo_registro: inTipos(tipos) } } };
}

/**
 * Fragmento Prisma para filtrar tbl_cotizaciones por ámbito Servicios/Proyectos.
 * La cotización no tiene tipo_registro propio: su clasificación la da la
 * `categoria_funcional` del tipo de servicio PADRE (SERVICIOS↔servicio,
 * PROYECTOS↔proyecto). Devuelve {} si el usuario no está acotado.
 */
function cotizacionAlcanceWhere(user) {
  const tipos = tiposRegistroPermitidos(user);
  if (tipos === null) return {};
  const categorias = tipos.map(t => (t === TIPO_REGISTRO.PROYECTO ? 'PROYECTOS' : 'SERVICIOS'));
  return { tipo_servicio: { is: { categoria_funcional: { in: categorias.length ? categorias : NINGUNO } } } };
}

// ---------------------------------------------------------------------------
// ALCANCE por TIPO de edificio (Edificio / Obra) — solo Administrador.
// Cada Administrador puede estar acotado a ver solo Edificios, solo Obras o
// ambos, mediante los flags `acceso_edificios` / `acceso_obras` (tbl_usuarios).
// Tener ambos habilitados equivale a NO estar acotado (sin restricción). Estos
// flags se ignoran para el resto de roles (ven todos los tipos). Como un edificio
// agrupa ascensores y casi todo lo operativo cuelga de un ascensor, el filtro se
// propaga vía la relación a `edificio.tipo`.
// ---------------------------------------------------------------------------

const NINGUN_TIPO_EDIFICIO = ['__sin_tipo_edificio__'];

/** ¿El acceso de este usuario se acota por tipo de edificio? */
function aplicaAlcanceEdificio(user) {
  return !!user && ROLES_CON_ALCANCE_EDIFICIOS.includes(user.rol_codigo);
}

/**
 * Lista de `tipo` de edificio que el usuario puede ver, o null si no está acotado
 * (rol sin alcance de edificio, o Administrador con ambos tipos habilitados). El
 * mapeo flag→código sale del catálogo (catalogosEdificios), sin hardcodeo.
 */
function tiposEdificioPermitidos(user) {
  if (!aplicaAlcanceEdificio(user)) return null;
  const tipos = TIPOS_EDIFICIO.filter(t => Number(user[t.flag]) !== 0).map(t => t.codigo);
  if (tipos.length === TIPOS_EDIFICIO.length) return null;
  return tipos;
}

/** `{ in: [...] }` para el campo `tipo`, con centinela si la lista quedó vacía; o null si no aplica. */
function tipoEdificioIn(user) {
  const tipos = tiposEdificioPermitidos(user);
  if (tipos === null) return null;
  return { in: tipos.length ? tipos : NINGUN_TIPO_EDIFICIO };
}

/** Fragmento para tbl_edificios (campo `tipo` directo). */
function edificioAlcanceWhere(user) {
  const inTipos = tipoEdificioIn(user);
  return inTipos ? { tipo: inTipos } : {};
}

/** Fragmento para tbl_ascensores (relación `edificio`). */
function ascensorEdificioAlcanceWhere(user) {
  const inTipos = tipoEdificioIn(user);
  return inTipos ? { edificio: { is: { tipo: inTipos } } } : {};
}

/**
 * Fragmento para una entidad con relación DIRECTA a un ascensor (emergencias,
 * correctivos, atenciones rápidas). Opciones:
 *   - relacion: nombre de la relación al ascensor (por defecto 'ascensor').
 *   - fk: campo escalar del id de ascensor (por defecto 'id_ascensor').
 *   - permitirSinAscensor: si el registro puede no tener ascensor (atención
 *     rápida), no se oculta cuando no depende de ningún edificio (mismo criterio
 *     que la visibilidad por estado).
 */
function porAscensorEdificioWhere(user, { relacion = 'ascensor', fk = 'id_ascensor', permitirSinAscensor = false } = {}) {
  const inTipos = tipoEdificioIn(user);
  if (!inTipos) return {};
  const cond = { [relacion]: { is: { edificio: { is: { tipo: inTipos } } } } };
  return permitirSinAscensor ? { OR: [{ [fk]: null }, cond] } : cond;
}

/**
 * Fragmento para una entidad con tabla puente a ascensores (servicios, planes de
 * mantenimiento, cotizaciones). `relacion` = junction (por defecto 'ascensores').
 */
function porJunctionAscensorEdificioWhere(user, relacion = 'ascensores') {
  const inTipos = tipoEdificioIn(user);
  return inTipos ? { [relacion]: { some: { ascensor: { is: { edificio: { is: { tipo: inTipos } } } } } } } : {};
}

/**
 * Fragmento para una entidad que cuelga de un servicio (cobros, facturas,
 * entregas). `relacion` = nombre de la relación al servicio (por defecto 'servicio').
 */
function porServicioAscensorEdificioWhere(user, relacion = 'servicio') {
  const inTipos = tipoEdificioIn(user);
  return inTipos
    ? { [relacion]: { is: { ascensores: { some: { ascensor: { is: { edificio: { is: { tipo: inTipos } } } } } } } } }
    : {};
}

/**
 * Fragmento para entidades que cuelgan de un servicio O de un plan de
 * mantenimiento (cobros y facturas: id_servicio o id_mantenimiento_plan, uno u
 * otro). Se muestra si cualquiera de los dos caminos llega a un edificio de tipo
 * permitido.
 */
function porServicioOPlanAscensorEdificioWhere(user) {
  const inTipos = tipoEdificioIn(user);
  if (!inTipos) return {};
  const ascCond = { ascensores: { some: { ascensor: { is: { edificio: { is: { tipo: inTipos } } } } } } };
  return { OR: [{ servicio: { is: ascCond } }, { mantenimiento_plan: { is: ascCond } }] };
}

/**
 * Fragmento para tbl_calendario_eventos. Un evento puede colgar de un servicio,
 * un plan de mantenimiento o una emergencia (o de ninguno, si es manual). Se
 * muestra si su vínculo llega a un edificio de tipo permitido, o si no tiene
 * vínculo operativo alguno (evento suelto, nunca se oculta por tipo).
 */
function calendarioEventoEdificioWhere(user) {
  const inTipos = tipoEdificioIn(user);
  if (!inTipos) return {};
  const ascCond = { ascensores: { some: { ascensor: { is: { edificio: { is: { tipo: inTipos } } } } } } };
  return {
    OR: [
      { servicio: { is: ascCond } },
      { mantenimiento_plan: { is: ascCond } },
      { emergencia: { is: { ascensor: { is: { edificio: { is: { tipo: inTipos } } } } } } },
      { AND: [{ id_servicio: null }, { id_mantenimiento_plan: null }, { id_emergencia: null }] }
    ]
  };
}

/**
 * Aña­de un fragmento de alcance a un `where` Prisma mediante AND, sin riesgo de
 * colisión de claves con los filtros ya presentes. No-op si el fragmento es {}.
 * Muta y devuelve el mismo `where`.
 */
function conAlcance(where, fragmento) {
  if (fragmento && Object.keys(fragmento).length > 0) {
    const prev = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [];
    where.AND = [...prev, fragmento];
  }
  return where;
}

/**
 * Middleware: exige que el usuario tenga el ámbito indicado para acceder al
 * módulo. `tipoRegistro` = 'servicio' | 'proyecto'.
 */
function requiereAlcance(tipoRegistro) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (puedeVerTipoRegistro(req.user, tipoRegistro)) return next();
    return res.status(403).json({ error: 'No tiene acceso a este módulo según su ámbito asignado' });
  };
}

module.exports = {
  ROLES_CON_ALCANCE,
  ROLES_CON_ALCANCE_EDIFICIOS,
  aplicaAlcance,
  tiposRegistroPermitidos,
  puedeVerTipoRegistro,
  servicioAlcanceWhere,
  clienteAlcanceWhere,
  ascensorAlcanceWhere,
  porServicioRelacionWhere,
  cotizacionAlcanceWhere,
  // Alcance por tipo de edificio (Edificio / Obra) — solo Administrador.
  aplicaAlcanceEdificio,
  tiposEdificioPermitidos,
  edificioAlcanceWhere,
  ascensorEdificioAlcanceWhere,
  porAscensorEdificioWhere,
  porJunctionAscensorEdificioWhere,
  porServicioAscensorEdificioWhere,
  porServicioOPlanAscensorEdificioWhere,
  calendarioEventoEdificioWhere,
  conAlcance,
  requiereAlcance,
};

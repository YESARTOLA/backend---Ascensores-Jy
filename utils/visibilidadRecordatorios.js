/**
 * Quién ve cada recordatorio — punto único de la verdad. Lo usan el módulo de
 * Recordatorios (lista, campana, contadores) y el Calendario.
 *
 * Hay dos clases de recordatorio:
 *
 * 1. CON DUEÑO (`id_usuario_destino`): los manuales. Los ve únicamente su dueño
 *    —quien lo registró para sí mismo o la persona para quien se registró—, sea
 *    cual sea su rol: un técnico también recibe el que le deja el coordinador.
 *    Quien lo registró para otro no lo tiene en su agenda, pero puede abrirlo
 *    (vista «Registrados para otros») para corregirlo o eliminarlo.
 *
 * 2. SIN DUEÑO: los automáticos. Los rige el rol del usuario:
 *    - tipos visibles según la matriz de utils/visibilidadCalendario.js;
 *    - el técnico, solo los de servicios/emergencias que tiene asignados;
 *    - una alerta dirigida a un rol (`rol_destinatario`) solo la ve ese rol;
 *    - el ámbito Servicios/Proyectos del usuario (utils/alcanceUsuario.js): un
 *      administrador de Proyectos no ve los recordatorios de Servicios.
 */
const { tiposRecordatorioPermitidos, soloOperativosAsignados } = require('./visibilidadCalendario');
const { tiposRegistroPermitidos } = require('./alcanceUsuario');
const { TIPO_REGISTRO } = require('./clasificacionServicio');

// Un recordatorio es de Proyectos si el servicio que lo origina es un proyecto:
// el vinculado directamente o, a falta de él, el de su emergencia o su cobro.
// Todo lo demás (planes de mantenimiento incluidos) es dominio de Servicios.
const WHERE_ES_PROYECTO = {
  OR: [
    { servicio: { tipo_registro: TIPO_REGISTRO.PROYECTO } },
    { id_servicio: null, emergencia: { servicio: { tipo_registro: TIPO_REGISTRO.PROYECTO } } },
    { id_servicio: null, id_emergencia: null, cobro: { servicio: { tipo_registro: TIPO_REGISTRO.PROYECTO } } }
  ]
};

// Espejo en memoria de WHERE_ES_PROYECTO, para un recordatorio ya cargado con
// su servicio, la emergencia con su servicio y el cobro con su servicio.
function esDeProyecto(rec) {
  const servicio = rec.id_servicio
    ? rec.servicio
    : rec.id_emergencia ? rec.emergencia?.servicio : rec.cobro?.servicio;
  return servicio?.tipo_registro === TIPO_REGISTRO.PROYECTO;
}

/** Cláusula de ámbito Servicios/Proyectos, o null si el usuario no está acotado. */
function whereAmbito(user) {
  const tipos = tiposRegistroPermitidos(user);
  if (!tipos) return null;
  const verProyectos = tipos.includes(TIPO_REGISTRO.PROYECTO);
  const verServicios = tipos.includes(TIPO_REGISTRO.SERVICIO);
  if (verProyectos && verServicios) return null;
  if (verProyectos) return WHERE_ES_PROYECTO;
  if (verServicios) return { NOT: WHERE_ES_PROYECTO };
  return { id: -1 };
}

/** Recordatorios sin dueño que el rol (y el ámbito) del usuario le dejan ver. */
function whereSegunRol(user) {
  const tipos = tiposRecordatorioPermitidos(user.rol_codigo);
  const clauses = [{ id_usuario_destino: null }, { tipo: { in: tipos } }];
  // Un manual sin dueño (creado antes de existir la columna y cuyo autor ya no
  // existe) sigue siendo privado de quien lo creó.
  if (tipos.includes('manual')) {
    clauses.push({ OR: [{ tipo: { not: 'manual' } }, { user_id_registration: user.id }] });
  }
  if (soloOperativosAsignados(user.rol_codigo)) {
    const idTec = user.id_tecnico || -1;
    clauses.push({
      OR: [
        { servicio:   { asignaciones: { some: { id_tecnico: idTec, estado: 1 } } } },
        { emergencia: { servicio: { asignaciones: { some: { id_tecnico: idTec, estado: 1 } } } } }
      ]
    });
  }
  clauses.push({ OR: [{ rol_destinatario: null }, { rol_destinatario: user.rol_codigo }] });
  const ambito = whereAmbito(user);
  if (ambito) clauses.push(ambito);
  return { AND: clauses };
}

/** La agenda del usuario: lo que es suyo más lo que su rol le deja ver. */
function whereRecordatoriosVisibles(user) {
  return { OR: [{ id_usuario_destino: user.id }, whereSegunRol(user)] };
}

/** Los que el usuario registró para otra persona. */
function whereRecordatoriosEnviados(user) {
  return {
    AND: [
      { user_id_registration: user.id },
      { id_usuario_destino: { not: null } },
      { NOT: { id_usuario_destino: user.id } }
    ]
  };
}

// Espejo en memoria de whereSegunRol para un recordatorio sin dueño ya cargado
// (con las asignaciones de su servicio y del servicio de su emergencia).
function visibleSegunRol(rec, user) {
  const tipos = tiposRecordatorioPermitidos(user.rol_codigo);
  if (!tipos.includes(rec.tipo)) return false;
  if (rec.tipo === 'manual' && rec.user_id_registration !== user.id) return false;
  if (rec.rol_destinatario && rec.rol_destinatario !== user.rol_codigo) return false;
  const ambito = tiposRegistroPermitidos(user);
  if (ambito && !ambito.includes(esDeProyecto(rec) ? TIPO_REGISTRO.PROYECTO : TIPO_REGISTRO.SERVICIO)) return false;
  if (!soloOperativosAsignados(user.rol_codigo)) return true;
  const idTec = user.id_tecnico;
  if (!idTec) return false;
  const asignado = (asigs) => (asigs || []).some(a => a.id_tecnico === idTec && a.estado === 1);
  return asignado(rec.servicio?.asignaciones) || asignado(rec.emergencia?.servicio?.asignaciones);
}

/**
 * Relación del usuario con un recordatorio concreto:
 *   - 'destinatario': está en su agenda; puede atenderlo, descartarlo, leerlo…
 *   - 'autor': lo registró para otra persona; puede verlo, editarlo y eliminarlo,
 *     pero atenderlo o marcarlo leído le toca a su dueño.
 *   - null: no tiene acceso (los controladores responden 404).
 */
function relacionConRecordatorio(rec, user) {
  if (rec.id_usuario_destino != null) {
    if (rec.id_usuario_destino === user.id) return 'destinatario';
    if (rec.user_id_registration === user.id) return 'autor';
    return null;
  }
  return visibleSegunRol(rec, user) ? 'destinatario' : null;
}

module.exports = {
  whereRecordatoriosVisibles,
  whereRecordatoriosEnviados,
  relacionConRecordatorio
};

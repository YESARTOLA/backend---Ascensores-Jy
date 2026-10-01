/**
 * Baja lógica de un CLIENTE y su cascada sobre TODO lo relacionado con él.
 *
 * Igual que el resto del sistema, NO hay borrado físico: todo es estado = 0 y
 * por tanto auditable y recuperable. Extiende al cliente completo la regla de
 * la eliminación de un edificio (bajaEdificioCascada.js): no sobrevive NADA que
 * dependa del cliente, ni siquiera lo ya ejecutado o cobrado.
 *
 * Qué se arrastra:
 *   - Todos sus edificios activos, con TODOS sus ascensores tratados como un
 *     único conjunto (misma selección y misma secuencia que un edificio). Así un
 *     servicio que cubre dos edificios del mismo cliente se va entero.
 *   - Lo que cuelga del cliente aunque no pase por sus ascensores: servicios,
 *     planes, emergencias, correctivos y atenciones rápidas con su id_cliente, y
 *     sus cobros y facturas sueltos (sin servicio ni plan).
 *   - Sus cotizaciones: quedan Anuladas (estado = 0), igual que al eliminar una
 *     cotización. Sus servicios generados ya caen en el punto anterior.
 *   - El cliente en sí.
 *
 * Única excepción, la misma que en un edificio: un servicio de OTRO cliente que
 * además cubre ascensores ajenos sigue vivo (pendiente → se le quitan estos
 * ascensores y se recalcula el precio; ya cobrado → intacto).
 *
 * Los leads vinculados NO se tocan: son el historial comercial del prospecto.
 *
 * Reactivar el cliente NO resucita a sus hijos (misma regla que el edificio):
 * se reactivan uno a uno de forma consciente.
 *
 * No hace commit ni purga Wasabi: el llamador envuelve esto en su propio
 * $transaction y, tras el commit, invoca purgarObjetosWasabi(wasabiKeys) y
 * liberarTecnicos(tecnicoIds, -1).
 */

const {
  seleccionarImpactoAscensores,
  contarIngresos,
  resumirImpacto,
  bajaImpactoEnTx,
  bajaIngresosEnTx
} = require('./bajaEdificioCascada');
const { eliminarPlanSinAscensores, INCLUDE_SERVICIO_DESAFECTACION } = require('./bajaAscensorCascada');
const { ESTADO_GLOBAL } = require('./estadoCotizacion');

const SOLO_ID = { select: { id: true } };

// Une dos listas de filas sin repetir ids (conserva la primera aparición).
function unir(a, b) {
  const vistos = new Set();
  return [...a, ...b].filter(f => (vistos.has(f.id) ? false : vistos.add(f.id)));
}

/**
 * Calcula, SIN mutar nada, todo lo que implicaría eliminar el cliente. Es la
 * fuente única de la decisión: la usan la vista previa (modal de doble
 * confirmación) y la propia cascada.
 *
 * Acepta indistintamente el cliente Prisma o un `tx` (misma API de lectura).
 */
async function seleccionarImpactoCliente(db, idCliente) {
  const edificios = await db.tbl_edificios.findMany({
    where: { id_cliente: idCliente, estado: 1 }, select: { id: true, nombre: true }
  });
  const ascensores = edificios.length === 0 ? [] : await db.tbl_ascensores.findMany({
    where: { id_edificio: { in: edificios.map(e => e.id) }, estado: 1 },
    select: { id: true, codigo: true }
  });
  const base = await seleccionarImpactoAscensores(db, ascensores);

  const delCliente = { id_cliente: idCliente, estado: 1 };
  const [servicios, planes, emergencias, correctivos, atenciones, cotizaciones] = await Promise.all([
    db.tbl_servicios_proyectos.findMany({ where: delCliente, include: INCLUDE_SERVICIO_DESAFECTACION }),
    db.tbl_mantenimientos_planes.findMany({ where: delCliente, ...SOLO_ID }),
    db.tbl_emergencias.findMany({ where: delCliente, ...SOLO_ID }),
    db.tbl_correctivos.findMany({ where: delCliente, ...SOLO_ID }),
    db.tbl_atenciones_rapidas.findMany({ where: delCliente, ...SOLO_ID }),
    db.tbl_cotizaciones.findMany({ where: delCliente, ...SOLO_ID })
  ]);

  // Los servicios del propio cliente se van enteros, aunque por sus ascensores
  // hubieran quedado como "compartidos": solo sobreviven los de otro cliente.
  const propios = new Set(servicios.map(s => s.id));
  const serviciosABaja = unir(base.servicios.aBaja, servicios);
  const planesABaja = [...new Set([...base.planes.aBaja, ...planes.map(p => p.id)])];

  return {
    edificios,
    ascensores,
    planes: { aBaja: planesABaja },
    servicios: {
      aBaja: serviciosABaja,
      recalculados: base.servicios.recalculados.filter(s => !propios.has(s.id)),
      intactos: base.servicios.intactos.filter(s => !propios.has(s.id))
    },
    emergencias: { aBaja: unir(base.emergencias.aBaja, emergencias) },
    correctivos: { aBaja: unir(base.correctivos.aBaja, correctivos) },
    atenciones: { aBaja: unir(base.atenciones.aBaja, atenciones) },
    cotizaciones,
    ingresos: await contarIngresos(db, serviciosABaja, planesABaja, { idCliente })
  };
}

/**
 * Resumen en conteos: lo que consume la vista previa y lo que queda guardado en
 * la auditoría de la eliminación.
 */
function resumirImpactoCliente(impacto) {
  const { se_eliminan, compartidos_con_otro_edificio } = resumirImpacto(impacto);
  return {
    se_eliminan: {
      edificios: impacto.edificios.length,
      ...se_eliminan,
      cotizaciones: impacto.cotizaciones.length
    },
    compartidos_con_otro_cliente: compartidos_con_otro_edificio
  };
}

/** Conteos del impacto de eliminar el cliente, sin ejecutar nada. */
async function calcularImpactoCliente(db, idCliente) {
  return resumirImpactoCliente(await seleccionarImpactoCliente(db, idCliente));
}

/**
 * Ejecuta la baja lógica en cascada del cliente dentro de una transacción.
 *
 * Idempotente: si el cliente ya está inactivo no hace nada.
 *
 * @returns {{ wasabiKeys: string[], tecnicoIds: number[], resumen: object|null, edificios: number[] }}
 */
async function bajaClienteCascadaEnTx(tx, idCliente, userId, ip) {
  const wasabiKeys = [];
  const tecnicoIds = [];
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };

  const cliente = await tx.tbl_clientes.findUnique({ where: { id: idCliente } });
  if (!cliente || cliente.estado === 0) return { wasabiKeys, tecnicoIds, resumen: null, edificios: [] };

  const impacto = await seleccionarImpactoCliente(tx, idCliente);
  const resumen = resumirImpactoCliente(impacto);

  // 1-4) Servicios, registros operativos, ingresos de plan y ascensores: la
  //      misma secuencia que la baja de un edificio, sobre todo el cliente.
  await bajaImpactoEnTx(tx, impacto, userId, ip, stamp, wasabiKeys, tecnicoIds);

  // 5) Planes del cliente que la cascada por ascensor no cerró (cubrían
  //    ascensores fuera de sus edificios, o ninguno). Sus ingresos ya cayeron en
  //    el paso 3; un plan ya cerrado se salta solo.
  for (const idPlan of impacto.planes.aBaja) {
    await eliminarPlanSinAscensores(tx, idPlan, userId, ip, stamp, wasabiKeys, tecnicoIds);
  }

  // 6) Cobros y facturas sueltos del cliente (sin servicio ni plan dado de baja).
  await bajaIngresosEnTx(tx, { id_cliente: idCliente }, userId, stamp, wasabiKeys);

  // 7) Sus edificios.
  const idsEdificios = impacto.edificios.map(e => e.id);
  if (idsEdificios.length > 0) {
    await tx.tbl_edificios.updateMany({ where: { id: { in: idsEdificios } }, data: { estado: 0, ...stamp } });
  }

  // 8) Sus cotizaciones quedan Anuladas, como al eliminar una cotización.
  await tx.tbl_cotizaciones.updateMany({
    where: { id_cliente: idCliente, estado: 1 },
    data: { estado: 0, estado_global: ESTADO_GLOBAL.ANULADO, ...stamp }
  });

  // 9) El cliente en sí.
  await tx.tbl_clientes.update({ where: { id: idCliente }, data: { estado: 0, ...stamp } });

  return { wasabiKeys, tecnicoIds, resumen, edificios: idsEdificios };
}

module.exports = {
  bajaClienteCascadaEnTx,
  calcularImpactoCliente,
  seleccionarImpactoCliente
};

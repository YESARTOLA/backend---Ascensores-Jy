/**
 * ELIMINACIÓN de un ascensor: la regla de la eliminación de un edificio
 * (bajaEdificioCascada.js) aplicada a un solo ascensor.
 *
 * Es distinta de MARCAR COMO INACTIVO (bajaAscensorCascada.js), que es para un
 * ascensor que dejó de operar: cancela sus planes pero conserva todo lo ya
 * ejecutado o cobrado, y lo siguen viendo todos los roles. Eliminar es para lo
 * que no debe quedar en la operación (p. ej. un ascensor creado por error):
 *
 *   - Servicios/proyectos cuyos ascensores activos son SOLO este → se van
 *     enteros, aunque estén ejecutados o cobrados, con su cobro y facturación.
 *   - Servicios que además cubren otros ascensores → siguen vivos: si están
 *     pendientes se les quita este ascensor y se recalcula el precio; si ya están
 *     cobrados quedan intactos para no descuadrar el cobro.
 *   - Planes de mantenimiento que se quedan sin ascensores → eliminados, con el
 *     cobro y las facturas del plan. Los que cubren otros ascensores siguen.
 *   - Emergencias, correctivos y atenciones rápidas del ascensor.
 *   - El ascensor: estado = 0, 'Inactivo' y `fecha_eliminacion`, que es lo que
 *     lo distingue de uno solo inactivo. Solo el Super Admin lo ve y lo reactiva.
 *
 * Como todo el sistema, es baja lógica: nada se borra físicamente.
 */

const {
  seleccionarImpactoAscensores,
  contarIngresos,
  resumirImpacto,
  bajaImpactoEnTx
} = require('./bajaEdificioCascada');

const esSuperAdmin = (user) => user?.rol_codigo === 'super_admin';

/**
 * Fragmento `where` sobre tbl_ascensores que oculta los eliminados a quien no
 * es Super Admin. Los inactivos (sin `fecha_eliminacion`) los ve todo el mundo.
 */
function whereAscensorVisible(user) {
  return esSuperAdmin(user) ? {} : { fecha_eliminacion: null };
}

/** ¿Puede este usuario ver (y operar sobre) el ascensor? */
function ascensorVisiblePara(ascensor, user) {
  return !!ascensor && (!ascensor.fecha_eliminacion || esSuperAdmin(user));
}

/**
 * Calcula, SIN mutar nada, todo lo que implicaría eliminar el ascensor. Fuente
 * única de la decisión: la usan la vista previa y la propia cascada. Acepta el
 * cliente Prisma o un `tx`.
 *
 * Sirve también para un ascensor ya inactivo: al inactivarlo se conservó su
 * historial (servicios ejecutados, emergencias…), que es justo lo que se lleva.
 */
async function seleccionarImpactoAscensor(db, idAscensor) {
  const ascensor = await db.tbl_ascensores.findUnique({
    where: { id: idAscensor }, select: { id: true, codigo: true }
  });
  const impacto = await seleccionarImpactoAscensores(db, ascensor ? [ascensor] : []);
  return {
    ...impacto,
    ingresos: await contarIngresos(db, impacto.servicios.aBaja, impacto.planes.aBaja)
  };
}

/**
 * Resumen en conteos: lo que consume la vista previa y lo que queda guardado en
 * la auditoría. No cuenta el propio ascensor entre lo que se arrastra.
 */
function resumirImpactoAscensor(impacto) {
  const { se_eliminan, compartidos_con_otro_edificio } = resumirImpacto(impacto);
  const { ascensores: _propio, ...arrastrados } = se_eliminan;
  return { se_eliminan: arrastrados, compartidos_con_otro_ascensor: compartidos_con_otro_edificio };
}

/** Conteos del impacto de eliminar el ascensor, sin ejecutar nada. */
async function calcularImpactoAscensor(db, idAscensor) {
  return resumirImpactoAscensor(await seleccionarImpactoAscensor(db, idAscensor));
}

/**
 * Ejecuta la eliminación en cascada dentro de una transacción.
 *
 * Idempotente: si el ascensor ya está eliminado no hace nada. No hace commit ni
 * purga Wasabi: tras el commit el llamador invoca purgarObjetosWasabi(wasabiKeys)
 * y liberarTecnicos(tecnicoIds, -1).
 *
 * @returns {{ wasabiKeys: string[], tecnicoIds: number[], resumen: object|null }}
 */
async function eliminarAscensorCascadaEnTx(tx, idAscensor, userId, ip) {
  const wasabiKeys = [];
  const tecnicoIds = [];
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };

  const ascensor = await tx.tbl_ascensores.findUnique({ where: { id: idAscensor } });
  if (!ascensor || ascensor.fecha_eliminacion) return { wasabiKeys, tecnicoIds, resumen: null };

  const impacto = await seleccionarImpactoAscensor(tx, idAscensor);
  const resumen = resumirImpactoAscensor(impacto);

  // Servicios, registros operativos, ingresos de plan y la baja del ascensor
  // con sus planes (misma secuencia que un edificio).
  await bajaImpactoEnTx(tx, impacto, userId, ip, stamp, wasabiKeys, tecnicoIds);

  // Marca de eliminado. Se fijan también estado y estado operativo porque un
  // ascensor que ya estaba inactivo no pasa por la baja del paso anterior.
  await tx.tbl_ascensores.update({
    where: { id: idAscensor },
    data: { estado: 0, estado_operativo: 'Inactivo', fecha_eliminacion: new Date(), ...stamp }
  });

  return { wasabiKeys, tecnicoIds, resumen };
}

module.exports = {
  whereAscensorVisible,
  ascensorVisiblePara,
  calcularImpactoAscensor,
  eliminarAscensorCascadaEnTx
};

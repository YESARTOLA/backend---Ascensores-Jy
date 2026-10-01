/**
 * Baja lógica de un EDIFICIO y su cascada sobre TODO lo relacionado con él.
 *
 * Igual que el resto del sistema, NO hay borrado físico: todo es estado = 0 y
 * por tanto auditable y recuperable. Este módulo centraliza qué se arrastra al
 * eliminar un edificio.
 *
 * REGLA: no debe sobrevivir NADA que dependa exclusivamente del edificio, ni
 * siquiera lo ya ejecutado o cobrado. Eliminar el edificio elimina también sus
 * ingresos: cobros, cuotas, pagos y facturas, tanto los que cuelgan de cada
 * servicio como el cobro único de cada plan de mantenimiento.
 *
 * Qué se arrastra:
 *   - Ascensores activos del edificio, y su cascada de planes de mantenimiento,
 *     eventos de calendario y recordatorios (vía bajaAscensorCascadaEnTx).
 *   - Servicios/proyectos activos —de plan o ad-hoc, pendientes o ejecutados—
 *     cuyos ascensores activos pertenecen TODOS al edificio, con su cadena
 *     completa de cobro y facturación.
 *   - El cobro y las facturas de cada plan que se elimina (los planes facturan
 *     en un cobro único con id_servicio nulo, así que no los alcanza la cascada
 *     de servicio).
 *   - Emergencias, correctivos y atenciones rápidas de esos ascensores, con sus
 *     eventos de calendario y recordatorios.
 *   - El edificio en sí.
 *
 * Única excepción, y no es una regla de historial sino de pertenencia: un
 * servicio que ADEMÁS cubre ascensores de otro edificio sigue vivo, porque no es
 * solo de este edificio. Si está pendiente se le quitan estos ascensores y se
 * recalcula el precio; si ya está cobrado se deja intacto para no descuadrar su
 * cobro. Las cotizaciones tampoco se tocan: son documentos comerciales emitidos
 * y sus filas admiten ascensores nuevos (id_ascensor nulo), así que no dependen
 * del edificio.
 *
 * Reactivar un edificio NO resucita a sus hijos: al reabrirlo no hay garantía
 * del estado real de ascensores, planes ni servicios, así que se reactivan uno a
 * uno de forma consciente (misma regla documentada en bajaAscensorCascada.js).
 *
 * No hace commit ni purga Wasabi: el llamador envuelve esto en su propio
 * $transaction y, tras el commit, invoca purgarObjetosWasabi(wasabiKeys) y
 * liberarTecnicos(tecnicoIds, -1).
 */

const {
  bajaAscensorCascadaEnTx,
  desafectarAscensoresDeServicioEnTx,
  servicioEsHistorial,
  INCLUDE_SERVICIO_DESAFECTACION
} = require('./bajaAscensorCascada');
const { bajaArchivoEnTx, bajaServicioCascadaEnTx } = require('./reversionEliminacion');
const { bajaDocumentosDeFacturasEnTx } = require('./documentosFactura');
const { ESTADO_EVENTO_CANCELADO } = require('./estadoEvento');

// Al eliminar un edificio se arrastra también lo ya ejecutado o cobrado.
const OPCIONES_DESAFECTACION = { incluirHistorial: true };

/**
 * Calcula, SIN mutar nada, todo lo que implicaría eliminar el edificio.
 *
 * Es la fuente única de la decisión: la usan tanto el endpoint de impacto (para
 * el modal de doble confirmación) como la propia cascada, de modo que lo que se
 * le promete al usuario y lo que se ejecuta no puedan divergir.
 *
 * Acepta indistintamente el cliente Prisma o un `tx` (misma API de lectura).
 */
async function seleccionarImpactoEdificio(db, idEdificio) {
  const ascensores = await db.tbl_ascensores.findMany({
    where: { id_edificio: idEdificio, estado: 1 },
    select: { id: true, codigo: true }
  });
  const impacto = await seleccionarImpactoAscensores(db, ascensores);
  return {
    ...impacto,
    ingresos: await contarIngresos(db, impacto.servicios.aBaja, impacto.planes.aBaja)
  };
}

/**
 * Selección para un CONJUNTO de ascensores que se dan de baja juntos: los de un
 * edificio, o todos los de un cliente (bajaClienteCascada.js). Aplicar la regla
 * sobre el conjunto completo —y no edificio por edificio— es lo que hace que un
 * servicio que cubre dos edificios del mismo cliente se vaya entero en vez de
 * quedar como "compartido" en cada uno. No cuenta ingresos: cada llamador los
 * cuenta sobre su selección final con `contarIngresos`.
 */
async function seleccionarImpactoAscensores(db, ascensores) {
  const idsAsc = ascensores.map(a => a.id);

  if (idsAsc.length === 0) {
    return {
      ascensores,
      planes: { aBaja: [] },
      servicios: { aBaja: [], recalculados: [], intactos: [] },
      emergencias: { aBaja: [] },
      correctivos: { aBaja: [] },
      atenciones: { aBaja: [] }
    };
  }

  // --- Servicios / proyectos vinculados a esos ascensores (de plan y ad-hoc) ---
  const servicios = await db.tbl_servicios_proyectos.findMany({
    where: { estado: 1, ascensores: { some: { estado: 1, id_ascensor: { in: idsAsc } } } },
    include: INCLUDE_SERVICIO_DESAFECTACION
  });
  const enBaja = new Set(idsAsc);
  const serviciosABaja = [];
  const serviciosRecalculados = [];
  const serviciosIntactos = [];
  for (const s of servicios) {
    const propios = s.ascensores.filter(a => enBaja.has(a.id_ascensor));
    // Todos sus ascensores son del edificio → el servicio es solo de este
    // edificio y se va entero, con sus ingresos.
    if (propios.length === s.ascensores.length) serviciosABaja.push(s);
    // Compartido con otro edificio: si ya está cobrado no se puede tocar.
    else if (servicioEsHistorial(s)) serviciosIntactos.push(s);
    else serviciosRecalculados.push(s);
  }

  // --- Planes que se quedarán sin ningún ascensor activo ---
  const enlaces = await db.tbl_mantenimientos_planes_ascensores.findMany({
    where: { id_ascensor: { in: idsAsc }, estado: 1, plan: { estado: 1 } },
    select: { id_plan: true }
  });
  const planesABaja = [];
  for (const idPlan of [...new Set(enlaces.map(e => e.id_plan))]) {
    const restantes = await db.tbl_mantenimientos_planes_ascensores.count({
      where: { id_plan: idPlan, estado: 1, id_ascensor: { notIn: idsAsc } }
    });
    if (restantes === 0) planesABaja.push(idPlan);
  }

  // --- Registros operativos con FK directa al ascensor ---
  const soloId = { select: { id: true } };
  const [emergencias, correctivos, atenciones] = await Promise.all([
    db.tbl_emergencias.findMany({ where: { id_ascensor: { in: idsAsc }, estado: 1 }, ...soloId }),
    db.tbl_correctivos.findMany({ where: { id_ascensor: { in: idsAsc }, estado: 1 }, ...soloId }),
    db.tbl_atenciones_rapidas.findMany({ where: { id_ascensor: { in: idsAsc }, estado: 1 }, ...soloId })
  ]);

  return {
    ascensores,
    planes: { aBaja: planesABaja },
    servicios: { aBaja: serviciosABaja, recalculados: serviciosRecalculados, intactos: serviciosIntactos },
    emergencias: { aBaja: emergencias },
    correctivos: { aBaja: correctivos },
    atenciones: { aBaja: atenciones }
  };
}

/**
 * Ingresos que se darán de baja: los que cuelgan de los servicios que se van
 * enteros más el cobro único de cada plan eliminado. `montoAbonado` es lo ya
 * pagado por el cliente que desaparecerá de los reportes — el dato que hace que
 * el usuario se lo piense dos veces antes de confirmar.
 */
async function contarIngresos(db, serviciosABaja, planesABaja, { idCliente = null } = {}) {
  const idsServicio = serviciosABaja.map(s => s.id);
  const filtroCobro = { estado: 1, OR: [] };
  if (idsServicio.length > 0) filtroCobro.OR.push({ id_servicio: { in: idsServicio } });
  if (planesABaja.length > 0) filtroCobro.OR.push({ id_mantenimiento_plan: { in: planesABaja } });
  // Baja de un cliente: también sus cobros sueltos (sin servicio ni plan).
  if (idCliente) filtroCobro.OR.push({ id_cliente: idCliente });
  if (filtroCobro.OR.length === 0) return { cobros: 0, pagos: 0, facturas: 0, montoAbonado: 0 };

  const cobros = await db.tbl_cobros.findMany({
    where: filtroCobro,
    select: { id: true, total_abonado: true }
  });
  const idsCobro = cobros.map(c => c.id);
  const [pagos, facturas] = await Promise.all([
    idsCobro.length > 0
      ? db.tbl_pagos.count({ where: { id_cobro: { in: idsCobro }, estado: 1 } })
      : 0,
    db.tbl_facturas.count({
      where: {
        estado: 1,
        OR: [
          ...(idsCobro.length > 0 ? [{ id_cobro: { in: idsCobro } }] : []),
          ...(idsServicio.length > 0 ? [{ id_servicio: { in: idsServicio } }] : []),
          ...(planesABaja.length > 0 ? [{ id_mantenimiento_plan: { in: planesABaja } }] : []),
          ...(idCliente ? [{ id_cliente: idCliente }] : [])
        ]
      }
    })
  ]);

  return {
    cobros: cobros.length,
    pagos,
    facturas,
    montoAbonado: cobros.reduce((acc, c) => acc + Number(c.total_abonado || 0), 0)
  };
}

/**
 * Resumen en conteos del impacto: lo que consume el endpoint de vista previa y
 * lo que queda guardado en la auditoría de la eliminación.
 */
function resumirImpacto(impacto) {
  return {
    se_eliminan: {
      ascensores: impacto.ascensores.length,
      planes: impacto.planes.aBaja.length,
      servicios: impacto.servicios.aBaja.length,
      emergencias: impacto.emergencias.aBaja.length,
      correctivos: impacto.correctivos.aBaja.length,
      atenciones_rapidas: impacto.atenciones.aBaja.length,
      cobros: impacto.ingresos.cobros,
      pagos: impacto.ingresos.pagos,
      facturas: impacto.ingresos.facturas,
      monto_abonado: impacto.ingresos.montoAbonado
    },
    compartidos_con_otro_edificio: {
      servicios_recalculados: impacto.servicios.recalculados.length,
      servicios_intactos: impacto.servicios.intactos.length
    }
  };
}

/** Conteos del impacto de eliminar el edificio, sin ejecutar nada. */
async function calcularImpactoEdificio(db, idEdificio) {
  return resumirImpacto(await seleccionarImpactoEdificio(db, idEdificio));
}

/**
 * Da de baja los cobros y facturas activos que cumplen `filtro` (se aplica igual
 * a tbl_cobros y a tbl_facturas) y todo lo que cuelga de ellos: cuotas, pagos,
 * recordatorios de cobro, documentos de factura y archivos.
 */
async function bajaIngresosEnTx(tx, filtro, userId, stamp, wasabiKeys) {
  const cobros = await tx.tbl_cobros.findMany({
    where: { ...filtro, estado: 1 },
    include: { pagos: { where: { estado: 1 } } }
  });

  const archivoIds = new Set();
  for (const cobro of cobros) {
    for (const p of cobro.pagos) if (p.id_archivo_comprobante) archivoIds.add(p.id_archivo_comprobante);
    await tx.tbl_cobros_cuotas.updateMany({ where: { id_cobro: cobro.id, estado: 1 }, data: { estado: 0, ...stamp } });
    await tx.tbl_pagos.updateMany({ where: { id_cobro: cobro.id, estado: 1 }, data: { estado: 0, ...stamp } });
    await tx.tbl_cobros_recordatorios.updateMany({ where: { id_cobro: cobro.id, estado: 1 }, data: { estado: 0, ...stamp } });
    await tx.tbl_cobros.update({ where: { id: cobro.id }, data: { estado: 0, ...stamp } });
  }

  const facturas = await tx.tbl_facturas.findMany({
    where: { ...filtro, estado: 1 },
    select: { id: true, id_archivo: true }
  });
  for (const f of facturas) if (f.id_archivo) archivoIds.add(f.id_archivo);
  if (facturas.length > 0) {
    const idsArchivoDocumentos = await bajaDocumentosDeFacturasEnTx(tx, facturas.map(f => f.id), userId);
    for (const idArchivo of idsArchivoDocumentos) archivoIds.add(idArchivo);
    await tx.tbl_facturas.updateMany({ where: { ...filtro, estado: 1 }, data: { estado: 0, ...stamp } });
  }

  for (const idArchivo of archivoIds) {
    const key = await bajaArchivoEnTx(tx, idArchivo, userId);
    if (key) wasabiKeys.push(key);
  }
}

/**
 * Da de baja el cobro de un plan de mantenimiento y todo lo que cuelga de él.
 *
 * Los planes facturan en un cobro único (`tbl_cobros.id_mantenimiento_plan`, con
 * id_servicio nulo), así que la cascada por servicio nunca lo alcanza: sin esto
 * el cobro y sus pagos sobrevivirían a un plan ya eliminado.
 */
async function bajaIngresosDePlanEnTx(tx, idPlan, userId, stamp, wasabiKeys) {
  await bajaIngresosEnTx(tx, { id_mantenimiento_plan: idPlan }, userId, stamp, wasabiKeys);
}

// Da de baja los registros operativos junto con sus eventos de calendario y
// recordatorios. `estado_emergencia` / `estado_correctivo` no se tocan: la baja
// la marca `estado = 0`, y conservar el estado de negocio permite entender en
// qué punto quedó el registro si se audita o se recupera.
async function bajaRegistrosOperativosEnTx(tx, impacto, stamp) {
  const idsEmergencias = impacto.emergencias.aBaja.map(e => e.id);
  if (idsEmergencias.length > 0) {
    await tx.tbl_calendario_eventos.updateMany({
      where: { id_emergencia: { in: idsEmergencias }, estado: 1 },
      data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, ...stamp }
    });
    await tx.tbl_recordatorios.updateMany({
      where: { id_emergencia: { in: idsEmergencias }, estado: 1 },
      data: { estado: 0, ...stamp }
    });
    await tx.tbl_emergencias.updateMany({
      where: { id: { in: idsEmergencias } }, data: { estado: 0, ...stamp }
    });
  }

  const idsCorrectivos = impacto.correctivos.aBaja.map(c => c.id);
  if (idsCorrectivos.length > 0) {
    await tx.tbl_correctivos.updateMany({
      where: { id: { in: idsCorrectivos } }, data: { estado: 0, ...stamp }
    });
  }

  const idsAtenciones = impacto.atenciones.aBaja.map(a => a.id);
  if (idsAtenciones.length > 0) {
    await tx.tbl_atenciones_rapidas.updateMany({
      where: { id: { in: idsAtenciones } }, data: { estado: 0, ...stamp }
    });
  }
}

/**
 * Ejecuta una selección (de edificio o de cliente) dentro de la transacción:
 * servicios, registros operativos, ingresos de plan y ascensores, en ese orden.
 * No toca el edificio ni el cliente: eso lo cierra cada llamador.
 */
async function bajaImpactoEnTx(tx, impacto, userId, ip, stamp, wasabiKeys, tecnicoIds) {
  const idsAsc = impacto.ascensores.map(a => a.id);

  // 1) Servicios. Va ANTES de la cascada por ascensor: ésta solo mira filas con
  //    estado = 1, así que encuentra ya resuelto lo que aquí se dio de baja o se
  //    recalculó y no lo procesa dos veces. Los de `aBaja` se van enteros con su
  //    cadena de cobro; a los compartidos se les aplica la regla única de la
  //    baja de ascensor (se les quitan estos ascensores y se recalculan).
  for (const s of impacto.servicios.aBaja) {
    const r = await bajaServicioCascadaEnTx(tx, s.id, userId);
    wasabiKeys.push(...r.wasabiKeys);
    tecnicoIds.push(...r.tecnicoIds);
  }
  for (const s of impacto.servicios.recalculados) {
    await desafectarAscensoresDeServicioEnTx(
      tx, s, idsAsc, userId, stamp, wasabiKeys, tecnicoIds, OPCIONES_DESAFECTACION
    );
  }

  // 2) Emergencias, correctivos y atenciones rápidas.
  await bajaRegistrosOperativosEnTx(tx, impacto, stamp);

  // 3) Ingresos a nivel de plan. Va antes de la cascada por ascensor, que es
  //    quien marca el plan como eliminado, para poder leerlos todavía activos.
  for (const idPlan of impacto.planes.aBaja) {
    await bajaIngresosDePlanEnTx(tx, idPlan, userId, stamp, wasabiKeys);
  }

  // 4) Ascensores: arrastra sus planes de mantenimiento, eventos y recordatorios.
  for (const a of impacto.ascensores) {
    const r = await bajaAscensorCascadaEnTx(tx, a.id, userId, ip);
    wasabiKeys.push(...r.wasabiKeys);
    tecnicoIds.push(...r.tecnicoIds);
  }
}

/**
 * Ejecuta la baja lógica en cascada del edificio dentro de una transacción.
 *
 * Idempotente: si el edificio ya está inactivo no hace nada.
 *
 * @returns {{ wasabiKeys: string[], tecnicoIds: number[], resumen: object|null }}
 */
async function bajaEdificioCascadaEnTx(tx, idEdificio, userId, ip) {
  const wasabiKeys = [];
  const tecnicoIds = [];
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };

  const edificio = await tx.tbl_edificios.findUnique({ where: { id: idEdificio } });
  if (!edificio || edificio.estado === 0) return { wasabiKeys, tecnicoIds, resumen: null };

  const impacto = await seleccionarImpactoEdificio(tx, idEdificio);
  const resumen = resumirImpacto(impacto);

  // 1-4) Servicios, registros operativos, ingresos de plan y ascensores.
  await bajaImpactoEnTx(tx, impacto, userId, ip, stamp, wasabiKeys, tecnicoIds);

  // 5) El edificio en sí.
  await tx.tbl_edificios.update({ where: { id: idEdificio }, data: { estado: 0, ...stamp } });

  return { wasabiKeys, tecnicoIds, resumen };
}

module.exports = {
  bajaEdificioCascadaEnTx,
  calcularImpactoEdificio,
  seleccionarImpactoEdificio,
  // Piezas que reutiliza la baja de un cliente completo (bajaClienteCascada.js).
  seleccionarImpactoAscensores,
  contarIngresos,
  resumirImpacto,
  bajaImpactoEnTx,
  bajaIngresosEnTx
};

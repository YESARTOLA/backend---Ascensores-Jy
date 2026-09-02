/**
 * Motor de reversión de eliminaciones (borrado lógico en cascada).
 *
 * Todos los módulos operativos (Emergencias, Correctivos, Mantenimientos) y
 * Cobros cuelgan, directa o indirectamente, de tbl_servicios_proyectos. Como el
 * sistema NO hace borrado físico (estado = 0), las reglas onDelete:Cascade del
 * schema Prisma NO se disparan: la reversión de cada hijo debe ser explícita.
 *
 * Este módulo centraliza esa baja en cascada para que un solo lugar conozca el
 * grafo completo y la limpieza de objetos en Wasabi.
 *
 * Convención de uso:
 *   const { wasabiKeys, tecnicoIds } = await bajaServicioCascadaEnTx(tx, idServicio, userId);
 *   // ...commit de la transacción...
 *   await purgarObjetosWasabi(wasabiKeys);   // best-effort, tras el commit
 *   await liberarTecnicos(tecnicoIds, idServicio);
 *
 * Las operaciones de Wasabi se ejecutan SIEMPRE después del commit: un objeto
 * borrado no se puede "des-borrar" si la transacción terminara revirtiéndose.
 */

const prisma = require('../config/prisma');
const { ESTADO_EVENTO_CANCELADO } = require('./estadoEvento');
const { keyDesdeRuta, eliminarObjeto } = require('./storage');

const ESTADOS_EN_CAMPO = ['En curso'];

/**
 * Da de baja (estado = 0) una fila de tbl_archivos dentro de la transacción.
 * Devuelve su key de Wasabi (para purgar tras el commit) o null.
 */
async function bajaArchivoEnTx(tx, idArchivo, userId) {
  if (!idArchivo) return null;
  const arch = await tx.tbl_archivos.findUnique({ where: { id: idArchivo } });
  if (!arch || arch.estado === 0) return null;
  await tx.tbl_archivos.update({
    where: { id: idArchivo },
    data: { estado: 0, user_id_modification: userId, date_time_modification: new Date() }
  });
  return keyDesdeRuta(arch.ruta_almacenamiento);
}

/**
 * Borra del bucket Wasabi la lista de keys. Best-effort: un fallo se loguea
 * pero no aborta (la fila en BD ya quedó en estado = 0).
 */
async function purgarObjetosWasabi(keys) {
  for (const key of (keys || [])) {
    if (!key) continue;
    try {
      await eliminarObjeto(key);
    } catch (e) {
      console.warn('[reversion] no se pudo borrar de Wasabi:', key, e.message);
    }
  }
}

/**
 * Da de baja en cascada un servicio y TODO lo que cuelga de él (asignaciones,
 * ascensores, guías, evidencias, entregas, observaciones,
 * historial de estados, checklist de finalización + respuestas, servicio
 * realizado, cobro + cuotas + pagos + recordatorios de cobro + facturas),
 * cancela sus eventos de calendario y descarta sus recordatorios. Recolecta las
 * keys de Wasabi de todos los archivos referenciados.
 *
 * NO hace commit ni purga Wasabi: eso es responsabilidad del llamador, que
 * debe envolver esta función en su propio $transaction y, tras el commit,
 * invocar purgarObjetosWasabi(wasabiKeys) y liberarTecnicos(tecnicoIds, idServicio).
 *
 * @returns {{ wasabiKeys: string[], tecnicoIds: number[] }}
 */
async function bajaServicioCascadaEnTx(tx, idServicio, userId) {
  const wasabiKeys = [];
  if (!idServicio) return { wasabiKeys, tecnicoIds: [] };

  const servicio = await tx.tbl_servicios_proyectos.findUnique({
    where: { id: idServicio },
    include: {
      asignaciones: { where: { estado: 1 } },
      guias: { where: { estado: 1 } },
      evidencias: { where: { estado: 1 } },
      entregas: { where: { estado: 1 } },
      servicio_realizado: true,
      finalizacion_checklist: true,
      facturas: { where: { estado: 1 } },
      cobro: { include: { pagos: { where: { estado: 1 } } } }
    }
  });
  if (!servicio) return { wasabiKeys, tecnicoIds: [] };

  const tecnicoIds = (servicio.asignaciones || []).map(a => a.id_tecnico);
  const stamp = { user_id_modification: userId, date_time_modification: new Date() };

  // --- Recolectar archivos referenciados (para purgar en Wasabi) ---
  const archivoIds = new Set();
  for (const g of servicio.guias) if (g.id_archivo) archivoIds.add(g.id_archivo);
  for (const e of servicio.evidencias) if (e.id_archivo) archivoIds.add(e.id_archivo);
  for (const e of servicio.entregas) if (e.id_archivo) archivoIds.add(e.id_archivo);
  if (servicio.id_archivo_ot) archivoIds.add(servicio.id_archivo_ot);
  if (servicio.finalizacion_checklist?.id_archivo_pdf) archivoIds.add(servicio.finalizacion_checklist.id_archivo_pdf);
  for (const f of servicio.facturas) if (f.id_archivo) archivoIds.add(f.id_archivo);
  if (servicio.cobro) {
    for (const p of servicio.cobro.pagos) if (p.id_archivo_comprobante) archivoIds.add(p.id_archivo_comprobante);
  }

  // --- Hijos directos del servicio ---
  // Ascensores vinculados: se capturan ANTES de dar de baja la fila puente para
  // poder detectar, al final, los que quedaron "Por instalar" y sin otro proyecto
  // que los instale (ver marcado 'Instalación cancelada' más abajo).
  const idsAscensoresVinculados = (
    await tx.tbl_servicios_ascensores.findMany({
      where: { id_servicio: idServicio, estado: 1 }, select: { id_ascensor: true }
    })
  ).map(b => b.id_ascensor).filter(Boolean);
  await tx.tbl_servicios_ascensores.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });
  await tx.tbl_servicios_asignaciones.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });

  await tx.tbl_servicios_guias.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });
  await tx.tbl_servicios_evidencias.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });
  await tx.tbl_entregas.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });
  await tx.tbl_servicios_observaciones.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });
  await tx.tbl_servicios_dias.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });
  await tx.tbl_servicios_estados_historial.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });

  if (servicio.finalizacion_checklist) {
    await tx.tbl_servicios_finalizacion_respuestas.updateMany({ where: { id_checklist: servicio.finalizacion_checklist.id, estado: 1 }, data: { estado: 0, ...stamp } });
    await tx.tbl_servicios_finalizacion_checklist.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });
  }
  await tx.tbl_servicios_realizados.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });

  // --- Cadena de cobro ---
  if (servicio.cobro) {
    const idCobro = servicio.cobro.id;
    await tx.tbl_cobros_cuotas.updateMany({ where: { id_cobro: idCobro, estado: 1 }, data: { estado: 0, ...stamp } });
    await tx.tbl_pagos.updateMany({ where: { id_cobro: idCobro, estado: 1 }, data: { estado: 0, ...stamp } });
    await tx.tbl_cobros_recordatorios.updateMany({ where: { id_cobro: idCobro, estado: 1 }, data: { estado: 0, ...stamp } });
    await tx.tbl_cobros.updateMany({ where: { id: idCobro, estado: 1 }, data: { estado: 0, ...stamp } });
  }
  // Facturas del servicio (cubre las generales con id_cobro null y las por cuota).
  await tx.tbl_facturas.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });

  // --- Calendario y recordatorios ---
  await tx.tbl_calendario_eventos.updateMany({
    where: { id_servicio: idServicio, estado: 1 },
    data: { estado: 0, estado_evento: ESTADO_EVENTO_CANCELADO, ...stamp }
  });
  await tx.tbl_recordatorios.updateMany({ where: { id_servicio: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });

  // --- Cronograma del plan de mantenimiento ---
  // Si el servicio materializaba una visita del cronograma, la visita queda
  // desenganchada (no se ejecutó; sin esto quedaría ocupada por un servicio
  // muerto y jamás podría volver a programarse). Aquí solo se desengancha; los
  // flujos que además deben devolver la fecha al calendario (cancelar/eliminar
  // servicio) usan planMantenimientoMensual.liberarVisitasDeServicio.
  await tx.tbl_mantenimientos_programacion.updateMany({
    where: { id_servicio: idServicio, estado: 1 },
    data: { id_servicio: null, ...stamp }
  });

  // --- Archivos (fila BD + key Wasabi) ---
  for (const idArchivo of archivoIds) {
    const key = await bajaArchivoEnTx(tx, idArchivo, userId);
    if (key) wasabiKeys.push(key);
  }

  // --- El servicio en sí ---
  await tx.tbl_servicios_proyectos.updateMany({ where: { id: idServicio, estado: 1 }, data: { estado: 0, ...stamp } });

  // --- Ascensores "Por instalar" que quedan huérfanos ---
  // Un ascensor nuevo creado al aprobar una cotización nace 'Por instalar'. Si se
  // cancela/elimina el proyecto que lo iba a instalar y NINGÚN otro proyecto activo
  // lo referencia, se marca 'Instalación cancelada' (se mantiene visible, estado=1)
  // para que quede claro que su instalación no se concretó. Guardas:
  //   - solo si sigue 'Por instalar' (nunca se instaló) y activo (estado=1);
  //   - solo si no queda otro servicio/proyecto activo que lo use.
  // Un ascensor ya operativo o pre-existente nunca se toca.
  for (const idAsc of idsAscensoresVinculados) {
    const asc = await tx.tbl_ascensores.findUnique({ where: { id: idAsc } });
    if (!asc || asc.estado !== 1 || asc.estado_operativo !== 'Por instalar') continue;
    const otrosProyectosActivos = await tx.tbl_servicios_ascensores.count({
      where: { id_ascensor: idAsc, estado: 1, id_servicio: { not: idServicio } }
    });
    if (otrosProyectosActivos > 0) continue;
    await tx.tbl_ascensores.update({
      where: { id: idAsc },
      data: { estado_operativo: 'Instalación cancelada', ...stamp }
    });
    await tx.tbl_ascensores_historial.create({
      data: {
        id_ascensor: idAsc,
        id_servicio: idServicio,
        tipo_evento: 'instalacion_cancelada',
        descripcion: `Instalación cancelada: se anuló el proyecto ${servicio.codigo} que instalaría este ascensor`,
        creado_por: userId
      }
    });
  }

  return { wasabiKeys, tecnicoIds };
}

/**
 * Vuelve a "Disponible" cada técnico que ya no tenga ningún otro servicio
 * activo en campo (En curso). Se ejecuta fuera de la transacción.
 */
async function liberarTecnicos(tecnicoIds, idServicioExcluido) {
  for (const idTecnico of new Set(tecnicoIds || [])) {
    if (!idTecnico) continue;
    const otrasActivas = await prisma.tbl_servicios_asignaciones.count({
      where: {
        id_tecnico: idTecnico,
        estado: 1,
        id_servicio: { not: idServicioExcluido },
        servicio: { estado_servicio: { in: ESTADOS_EN_CAMPO }, estado: 1 }
      }
    });
    if (otrasActivas === 0) {
      await prisma.tbl_tecnicos.update({ where: { id: idTecnico }, data: { estado_operativo: 'Disponible' } });
    }
  }
}

module.exports = {
  bajaArchivoEnTx,
  purgarObjetosWasabi,
  bajaServicioCascadaEnTx,
  liberarTecnicos
};

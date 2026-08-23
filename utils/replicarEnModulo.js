/**
 * Replica un servicio recién creado en el módulo operativo correspondiente
 * según `tipo_servicio.modulo_asociado`.
 *
 * Punto único usado por:
 *   - serviciosController.crear        (creación manual de servicios)
 *   - cotizacionesController.aprobar   (servicios generados por cotización)
 *
 * Reglas:
 *   - emergencia / correctivo: crea 1 fila vinculada al servicio (constraint
 *     @unique en tbl_emergencias.id_servicio / tbl_correctivos.id_servicio).
 *     Si hay multiascensor, la fila usa el primer ascensor; los demás siguen
 *     vinculados al servicio vía tbl_servicios_proyectos_ascensores.
 *   - mantenimiento: crea 1 plan que cubre todos los ascensores (montos
 *     heredados de la junction del servicio originante).
 *   - atencion_rapida: crea 1 fila en tbl_atenciones_rapidas con
 *     id_servicio_convertido = servicio.id (registro de origen).
 *   - null / otro valor: no hace nada.
 *
 * Si los datos requeridos faltan para el módulo activo, lanza Error y la
 * transacción del caller debe revertir todo el alta.
 */

const { parseYMDLima } = require('./tiempo');
const { clasificarTipoServicio, MODULOS_VALIDOS } = require('./clasificacionServicio');
const { ESTADO_PLAN_ACTIVO } = require('./estadoPlanMantenimiento');
const { mesesParaVisitas } = require('./frecuenciaMantenimiento');
const { generarProgramacion } = require('./planMantenimientoMensual');
const { crearCobroInicial } = require('./crearCobroInicial');

function nivelUrgencia(valor, defaultValor) {
  return ['alta', 'media', 'baja'].includes(valor) ? valor : defaultValor;
}

/**
 * @param {object} tx                 cliente Prisma o transaccional
 * @param {object} args
 * @param {object} args.servicio      servicio recién creado (necesita id, codigo)
 * @param {object} args.tipoServicio  SUBTIPO de servicio con su relación `padre`
 *                                    incluida (se clasifica vía clasificarTipoServicio).
 * @param {number[]} args.idsAscensores  ascensores vinculados (≥1)
 * @param {number} args.idCliente
 * @param {string} args.horaProgramada
 * @param {Date}   args.fechaProgramada
 * @param {number} args.usuarioId
 * @param {object} args.datosModulo   body del caller con campos extra (motivo,
 *                                    falla, nivel_urgencia, tipo_plan, frecuencia,
 *                                    frecuencia_dias_custom, cantidad_mantenimientos,
 *                                    cantidad_mantenimientos_gratuitos,
 *                                    fecha_inicio_plan, tipo_solicitud,
 *                                    nombre_contacto, telefono, mensaje_rapido)
 * @param {string} args.origenEtiqueta texto para observaciones (ej "aprobación de COT-123 v1")
 */
async function replicarEnModulo(tx, args) {
  const {
    servicio, tipoServicio, idsAscensores, idCliente,
    horaProgramada, fechaProgramada, usuarioId,
    datosModulo: d = {}, origenEtiqueta = `servicio ${servicio?.codigo || servicio?.id}`
  } = args;

  if (!servicio?.id) throw new Error('replicarEnModulo: servicio sin id');
  if (!Array.isArray(idsAscensores) || idsAscensores.length === 0) {
    throw new Error('replicarEnModulo: debe haber al menos un ascensor');
  }

  const { modulo_asociado: modulo } = clasificarTipoServicio(tipoServicio);
  if (!modulo) return null;

  const primerAscensor = idsAscensores[0];
  const obs = `Generada por ${origenEtiqueta}`;

  if (modulo === 'emergencia') {
    const motivo = String(d.motivo || servicio.descripcion || servicio.titulo || '').trim();
    if (!motivo) throw new Error('Motivo obligatorio para módulo Emergencias');
    await tx.tbl_emergencias.create({
      data: {
        id_servicio: servicio.id,
        id_cliente: idCliente,
        id_ascensor: primerAscensor,
        motivo,
        nivel_urgencia: nivelUrgencia(d.nivel_urgencia, 'alta'),
        estado_emergencia: 'Reportada',
        observaciones: obs,
        user_id_registration: usuarioId
      }
    });
    return 'emergencia';
  }

  if (modulo === 'correctivo') {
    const falla = String(d.falla || servicio.descripcion || servicio.titulo || '').trim();
    if (!falla) throw new Error('Descripción de la falla obligatoria para módulo Correctivos');
    await tx.tbl_correctivos.create({
      data: {
        id_servicio: servicio.id,
        id_cliente: idCliente,
        id_ascensor: primerAscensor,
        falla,
        nivel_urgencia: nivelUrgencia(d.nivel_urgencia, 'media'),
        estado_correctivo: 'Reportado',
        observaciones: obs,
        user_id_registration: usuarioId
      }
    });
    return 'correctivo';
  }

  if (modulo === 'mantenimiento') {
    // Solo existen dos tipos de plan reales: 'eventual' y 'continuo'. Cualquier
    // otro valor (incluido el legacy 'ciclico') se normaliza a 'continuo', mismo
    // criterio que mantenimientosController; 'ciclico' no tiene lógica propia
    // (no materializaba ocurrencias) y quedaba como plan inerte.
    const tipoPlan = d.tipo_plan === 'eventual' ? 'eventual' : 'continuo';
    const frecuencia = tipoPlan === 'eventual' ? null : (d.frecuencia || 'mensual');
    const frecDiasCustom = d.frecuencia_dias_custom ? Number(d.frecuencia_dias_custom) : null;
    const cantidadMant = d.cantidad_mantenimientos != null ? Number(d.cantidad_mantenimientos) : null;
    const cantidadGratuitos = Math.max(0, Number(d.cantidad_mantenimientos_gratuitos) || 0);
    const fechaInicioPlan = d.fecha_inicio_plan ? parseYMDLima(d.fecha_inicio_plan) : fechaProgramada;
    // El plan se dimensiona en MESES. Si el origen habla de "N mantenimientos"
    // (formularios previos al modelo mensual) se convierte conservando el
    // horizonte del contrato: trimestral × 4 → 12 meses.
    const duracionMeses = tipoPlan === 'eventual'
      ? 1
      : (Number.isFinite(Number(d.duracion_meses)) && Number(d.duracion_meses) >= 1
          ? Number(d.duracion_meses)
          : mesesParaVisitas(frecuencia, frecDiasCustom, cantidadMant ?? 12));
    // Un único plan que cubre todos los ascensores. Los montos por ascensor se
    // heredan de la junction del servicio originante (mismo reparto del precio).
    const ascSrv = await tx.tbl_servicios_ascensores.findMany({
      where: { id_servicio: servicio.id, estado: 1 },
      select: { id_ascensor: true, monto: true, moneda: true }
    });
    const filasAsc = (ascSrv.length > 0
      ? ascSrv
      : idsAscensores.map(id_ascensor => ({ id_ascensor, monto: 0, moneda: 'PEN' }))
    ).map(a => ({
      id_ascensor: a.id_ascensor,
      monto: a.monto || 0,
      moneda: a.moneda || 'PEN',
      user_id_registration: usuarioId
    }));
    // Monto mensual: el importe pactado por ocurrencia repartido sobre los
    // meses del plan, de modo que el total del contrato no cambie.
    const sumaPorOcurrencia = filasAsc.reduce((acc, a) => acc + Number(a.monto || 0), 0);
    const montoMensual = Number(d.monto_mensual) >= 0 && d.monto_mensual !== undefined && d.monto_mensual !== null && d.monto_mensual !== ''
      ? Math.round(Number(d.monto_mensual) * 100) / 100
      : Math.round((sumaPorOcurrencia * (cantidadMant ?? duracionMeses) / duracionMeses) * 100) / 100;
    const monedaPlan = filasAsc[0]?.moneda || 'PEN';

    const plan = await tx.tbl_mantenimientos_planes.create({
      data: {
        id_cliente: idCliente,
        id_tipo_servicio: tipoServicio.id,
        tipo_plan: tipoPlan,
        frecuencia,
        frecuencia_dias_custom: frecDiasCustom,
        duracion_meses: duracionMeses,
        cantidad_mantenimientos: cantidadMant,
        cantidad_mantenimientos_gratuitos: cantidadGratuitos,
        monto_mensual: montoMensual,
        moneda: monedaPlan,
        fecha_inicio: fechaInicioPlan,
        hora_programada: horaProgramada,
        estado_plan: ESTADO_PLAN_ACTIVO,
        observaciones: obs,
        user_id_registration: usuarioId,
        // Cada ascensor hereda la frecuencia del plan; se puede afinar luego
        // desde el detalle del plan.
        ascensores: { create: filasAsc.map(a => ({ ...a, frecuencia, frecuencia_dias_custom: frecDiasCustom })) }
      }
    });

    // Cronograma completo (una fila y un evento por visita de cada ascensor).
    const filasJunction = await tx.tbl_mantenimientos_planes_ascensores.findMany({
      where: { id_plan: plan.id, estado: 1 },
      include: { ascensor: { select: { id: true, codigo: true, edificio: { select: { nombre: true } } } } }
    });
    const prog = await generarProgramacion(tx, { plan, filasJunction, userId: usuarioId });
    await tx.tbl_mantenimientos_planes.update({
      where: { id: plan.id }, data: { cantidad_mantenimientos: prog.creadas }
    });

    // Cobro ÚNICO del plan: nace vacío y crece una cuota por mes aprobado.
    await crearCobroInicial(tx, {
      idMantenimientoPlan: plan.id,
      idCliente,
      monto: 0,
      moneda: monedaPlan,
      fechaCuotaUnica: plan.fecha_inicio,
      sinCuotas: true,
      idUsuario: usuarioId
    });
    return 'mantenimiento';
  }

  if (modulo === 'atencion_rapida') {
    const nombre = String(d.nombre_contacto || '').trim();
    const telefono = String(d.telefono || '').trim();
    if (!nombre || !telefono) {
      throw new Error('Nombre y teléfono del contacto son obligatorios para módulo Atención Rápida');
    }
    await tx.tbl_atenciones_rapidas.create({
      data: {
        nombre_contacto: nombre,
        telefono,
        mensaje_rapido: d.mensaje_rapido || null,
        tipo_solicitud: d.tipo_solicitud || null,
        nivel_urgencia: nivelUrgencia(d.nivel_urgencia, 'media'),
        estado_atencion: 'convertida',
        id_cliente: idCliente,
        id_ascensor: primerAscensor,
        id_servicio_convertido: servicio.id,
        observaciones: obs,
        user_id_registration: usuarioId
      }
    });
    return 'atencion_rapida';
  }

  return null;
}

module.exports = {
  replicarEnModulo,
  MODULOS_VALIDOS
};

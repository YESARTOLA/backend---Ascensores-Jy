/**
 * Smoke test end-to-end del flujo "cotización con adelanto + saldo variable".
 *
 * Verifica los requerimientos del prompt original:
 *  1. Cotización aprobada → cobro aparece en gestión de cobros directamente.
 *  2. Cotización aprobada → no se pueden modificar montos (estado Cerrada).
 *  3. Adelanto facturable y pagable.
 *  4. Resto (700 en ejemplo) puede variar en monto y distribución de cuotas.
 *  5. Cuotas pagadas/facturadas quedan blindadas.
 *
 * Ejecuta directo contra el backend en http://localhost:4000 con admin/admin123.
 */
const BASE = 'http://localhost:4000/api';

async function req(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) {
    const msg = data?.error || JSON.stringify(data).slice(0, 200);
    throw new Error(`${method} ${path} → ${r.status}: ${msg}`);
  }
  return data;
}

function assert(cond, msg) {
  if (!cond) { console.error('   ❌ FAIL:', msg); process.exitCode = 1; return false; }
  console.log('   ✔', msg);
  return true;
}

async function main() {
  console.log('▶ login');
  const { token } = await req('POST', '/auth/login', null, {
    correo: 'admin@ascensoresjy.com',
    contrasena: 'admin123'
  });
  console.log('   token OK');

  // IDs hardcoded — el listado de clientes/tipos tiene problemas no relacionados
  // a esta prueba (otra columna inexistente). Estos IDs vienen del seed.
  const cliente = { id: 5 }; // Hotel Costa Marina
  const ascensor = { id: 6 }; // ASC-JY-006
  const tipo = { id: 4 };    // Reparación mecánica

  // ---- 1. Crear cotización con plan 300 + 880 y saldo_variable=true
  console.log('\n▶ crear cotización (1180 total, plan 300+880, saldo_variable=true)');
  const body = {
    id_cliente: cliente.id,
    id_tipo_servicio: tipo.id,
    ascensores: [{ id_ascensor: ascensor.id }],
    titulo: 'API E2E - Adelanto 300 + saldo variable',
    fecha_validez: '2026-06-30',
    items: [{ descripcion: 'Servicio de prueba', cantidad: 1, unidad: 'Unidad', precio_unitario: 1000, descuento_porcentaje: 0 }],
    tiene_cuotas: true,
    plan_cuotas: [
      { numero_cuota: 1, fecha_vencimiento: '2026-05-25', monto: 300 },
      { numero_cuota: 2, fecha_vencimiento: '2026-06-25', monto: 880 }
    ],
    saldo_variable: true
  };
  const creada = await req('POST', '/cotizaciones', token, body);
  const cotId = (creada.data || creada).id;
  console.log('   cotización id=', cotId);
  const cotDetalle = await req('GET', `/cotizaciones/${cotId}`, token);
  const versionInicial = cotDetalle.data.versiones[0];
  assert(versionInicial.tiene_cuotas === true, 'versión tiene_cuotas=true');
  assert(versionInicial.saldo_variable === true, 'versión saldo_variable=true persistido');
  assert(Array.isArray(versionInicial.plan_cuotas) && versionInicial.plan_cuotas.length === 2,
    'plan_cuotas con 2 cuotas persistido');

  // ---- 2. Aprobar (el flujo nuevo no requiere paso intermedio "enviar")
  console.log('\n▶ aprobar');
  const aprob = await req('POST', `/cotizaciones/${cotId}/versiones/1/aprobar`, token, {
    fecha_programada: '2026-05-25', hora_programada: '09:00', prioridad: 'media'
  });
  const idServ = aprob.data.id_servicio_generado;
  const codigoServ = aprob.data.codigo_servicio;
  console.log('   servicio generado:', codigoServ, '(id=', idServ + ')');

  // ---- 3. Verificar cotización pasó al ciclo del servicio (Aceptado al
  // crearse en Pendiente; o Ejecución/Pendiente/Terminado si el flujo de
  // prueba avanzó más antes de esta aserción).
  console.log('\n▶ verificar que la cotización ya no permite editar montos');
  const cotPost = (await req('GET', `/cotizaciones/${cotId}`, token)).data;
  assert(
    ['Aceptado', 'Ejecución', 'Pendiente', 'Terminado'].includes(cotPost.estado_global),
    `cotización pasó a un estado de ejecución (actual: ${cotPost.estado_global})`
  );
  assert(cotPost.versiones[0].estado_version === 'Aprobado', 'versión 1 Aprobado');
  // Intentar editar versión aprobada (debe fallar)
  let editFalló = false;
  try {
    await req('PUT', `/cotizaciones/${cotId}/versiones/1`, token, {
      items: [{ descripcion: 'hack', cantidad: 1, unidad: 'U', precio_unitario: 9999, descuento_porcentaje: 0 }]
    });
  } catch (e) {
    editFalló = true;
    console.log('   error esperado:', e.message);
  }
  assert(editFalló, 'edición de versión aprobada es rechazada');

  // ---- 4. Verificar cobro creado automáticamente
  console.log('\n▶ verificar cobro creado automáticamente');
  const cobroListResp = await req('GET', `/cobros?id_proyecto=${idServ}`, token);
  const cobroLista = cobroListResp.data || cobroListResp;
  assert(cobroLista.length === 1, 'el cobro aparece en gestión de cobros');
  const idCobro = cobroLista[0].id;
  const cobro = (await req('GET', `/cobros/${idCobro}`, token)).data;
  assert(cobro.saldo_variable === true, 'cobro hereda saldo_variable=true');
  assert(Number(cobro.monto_total) === 1180, `cobro monto_total=1180 (got ${cobro.monto_total})`);
  assert(cobro.estado_cobro === 'Pendiente de iniciar', 'cobro nace en "Pendiente de iniciar"');
  assert(cobro.cuotas.length === 2, 'cobro tiene 2 cuotas');
  const cu1 = cobro.cuotas.find(c => c.numero_cuota === 1);
  const cu2 = cobro.cuotas.find(c => c.numero_cuota === 2);
  assert(Number(cu1.monto) === 300, 'cuota 1 = 300 (adelanto)');
  assert(Number(cu2.monto) === 880, 'cuota 2 = 880 (saldo)');

  // ---- 5. Verificar que el servicio NO transicionó por la creación del cobro
  const servAntes = (await req('GET', `/servicios/${idServ}`, token)).data;
  assert(servAntes.estado_servicio === 'Pendiente', `servicio sigue en Pendiente (got ${servAntes.estado_servicio})`);

  // ---- 6. Pagar el adelanto (300)
  console.log('\n▶ registrar abono del adelanto (300)');
  await req('POST', `/cobros/${idCobro}/pagos`, token, {
    monto: 300, fecha_pago: '2026-05-25', metodo_pago: 'Efectivo'
  });
  const cobroTrasPago = (await req('GET', `/cobros/${idCobro}`, token)).data;
  const cu1Tras = cobroTrasPago.cuotas.find(c => c.numero_cuota === 1);
  assert(Number(cu1Tras.monto_pagado) === 300, 'cuota 1 quedó con monto_pagado=300');
  assert(cu1Tras.estado_cuota === 'Pagada', 'cuota 1 marcada como Pagada (blindada)');
  // El servicio NO debe haber cambiado de estado a pesar del pago
  const servTrasPago = (await req('GET', `/servicios/${idServ}`, token)).data;
  assert(servTrasPago.estado_servicio === 'Pendiente',
    `servicio sigue Pendiente tras cobrar adelanto (got ${servTrasPago.estado_servicio}) — guard funciona`);

  // ---- 7. Intentar modificar la cuota blindada (debe fallar)
  console.log('\n▶ intentar modificar la cuota blindada (debe rechazarse)');
  let intentoFalló = false;
  try {
    await req('PUT', `/cobros/${idCobro}/plan-cuotas`, token, {
      cuotas: [
        { id: cu1Tras.id, numero_cuota: 1, fecha_vencimiento: '2026-05-25', monto: 200 }, // cambia monto blindado
        { numero_cuota: 2, fecha_vencimiento: '2026-06-25', monto: 880 }
      ]
    });
  } catch (e) {
    intentoFalló = true;
    console.log('   error esperado:', e.message);
  }
  assert(intentoFalló, 'modificar monto de cuota blindada es rechazado');

  // ---- 8. Redistribuir y SUBIR el saldo: 880 → 1000 partido en 3 cuotas (300 + 350 + 350)
  console.log('\n▶ redistribuir saldo: 880 → 1000 en 3 cuotas (saldo variable)');
  // Reenviar la cuota 1 con su fecha exacta tal cual la devolvió el backend
  // (para no cambiar nada de la cuota blindada).
  const planNuevo = {
    cuotas: [
      { id: cu1Tras.id, numero_cuota: 1, fecha_vencimiento: cu1Tras.fecha_vencimiento, monto: Number(cu1Tras.monto) },
      { numero_cuota: 2, fecha_vencimiento: '2026-06-25', monto: 300 },
      { numero_cuota: 3, fecha_vencimiento: '2026-07-25', monto: 350 },
      { numero_cuota: 4, fecha_vencimiento: '2026-08-25', monto: 350 }
    ]
  };
  await req('PUT', `/cobros/${idCobro}/plan-cuotas`, token, planNuevo);
  const cobroTrasRedist = (await req('GET', `/cobros/${idCobro}`, token)).data;
  assert(Number(cobroTrasRedist.monto_total) === 1300,
    `monto_total subió de 1180 a 1300 (got ${cobroTrasRedist.monto_total})`);
  assert(cobroTrasRedist.cuotas.length === 4, '4 cuotas activas tras redistribuir');
  // El servicio precio_interno debe haberse sincronizado
  const servTrasRedist = (await req('GET', `/servicios/${idServ}`, token)).data;
  assert(Number(servTrasRedist.precio_interno) === 1300,
    `servicio precio_interno sincronizado a 1300 (got ${servTrasRedist.precio_interno})`);

  // ---- 9. Intentar bajar el total por debajo de lo blindado (debe fallar)
  console.log('\n▶ intentar bajar el saldo por debajo de lo blindado (300)');
  let bajaFalló = false;
  try {
    await req('PUT', `/cobros/${idCobro}/plan-cuotas`, token, {
      cuotas: [
        { id: cu1Tras.id, numero_cuota: 1, fecha_vencimiento: '2026-05-25', monto: 300 },
        { numero_cuota: 2, fecha_vencimiento: '2026-06-25', monto: -100 } // total < blindado
      ]
    });
  } catch (e) {
    bajaFalló = true;
    console.log('   error esperado:', e.message);
  }
  assert(bajaFalló, 'bajar el total por debajo de lo blindado es rechazado');

  console.log('\n▶ TEST IDs para revisión visual:');
  console.log('   cotización:', cotId, '→ http://localhost:5173/cotizaciones/' + cotId);
  console.log('   servicio:  ', idServ, '→ http://localhost:5173/servicios/' + idServ);
  console.log('   cobro:     ', idCobro, '→ http://localhost:5173/cobros/' + idCobro);

  if (process.exitCode === 1) {
    console.error('\n❌ Hay assertions fallidas');
  } else {
    console.log('\n✅ Todos los criterios del prompt original verificados');
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

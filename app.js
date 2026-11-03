/* ============================================================
   SILVER BANK - Lógica de la aplicación
   ============================================================ */


/* ==================== BASE DE DATOS (IndexedDB con Dexie) ==================== */
const db = new Dexie('SilverBankDB');

db.version(1).stores({
  cliente:       'id',
  cuentas:       '++id,numero,tipo',
  movimientos:   '++id,cuentaId,fecha,tipo',
  beneficiarios: '++id,numero',
  solicitudes:   '++id'
});


/* ==================== UTILIDADES ==================== */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// Formato de dinero en quetzales
const Q = n => new Intl.NumberFormat('es-GT', {
  style: 'currency',
  currency: 'GTQ'
}).format(n);

// Formato de fecha y hora
const F = d => new Date(d).toLocaleString('es-GT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

// Redondeo a 2 decimales
const r2 = n => Math.round(n * 100) / 100;

// Número de cuenta aleatorio
const numCuenta = () => 'SB-' + Math.floor(1e9 + Math.random() * 9e9);

// Evita que el texto escrito por el usuario se interprete como HTML
const esc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

const CRED = 'Tarjeta de crédito';
const LIMITE = 4800;

let cliente = null;   // Datos del cliente actual
const render = {};    // Funciones que dibujan cada sección

// Gastos inventados con tarjeta de débito: [días atrás, descripción, monto]
const GASTOS = [
  [29, 'Supermercado La Torre', 385.75],
  [27, 'Gasolinera Puma',       250],
  [25, 'Pollo Campero',         96.5],
  [22, 'Farmacia Cruz Verde',   142.3],
  [20, 'Cinépolis',             120],
  [18, 'Tienda Max',            459],
  [15, 'Uber',                  48.25],
  [13, 'Amazon',                320.9],
  [10, 'Walmart',               612.4],
  [7,  'Café Barista',          37.5],
  [4,  'Gasolinera Shell',      300],
  [2,  'Spotify / Netflix',     89.99]
];


/* ==================== INTERFAZ: MENSAJES, VISTAS Y SECCIONES ==================== */
function toast(mensaje, ok = true) {
  const t = document.createElement('div');
  t.className = 'toast ' + (ok ? 'ok' : 'mal');
  t.textContent = mensaje;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}

function vista(id) {
  $$('.vista').forEach(v => v.classList.toggle('activa', v.id === id));
  scrollTo(0, 0);
}

function seccion(id) {
  $$('.sec').forEach(s => s.classList.toggle('activa', s.id === id));
  $$('.menu button[data-sec]').forEach(b => b.classList.toggle('on', b.dataset.sec === id));
  $('#sidebar').classList.remove('abierto');

  if (render[id]) render[id]();
}

// Color de la etiqueta según el tipo de movimiento
function claseTipo(tipo) {
  if (/Gasto/.test(tipo)) return 'b-gasto';
  if (/servicio|tarjeta de crédito|Comisión/i.test(tipo)) return 'b-serv';
  if (/Transfer/.test(tipo)) return 'b-transf';
  return 'b-dep';
}

function filaMov(m, mapa) {
  return `
    <tr>
      <td>${F(m.fecha)}</td>
      <td>${mapa[m.cuentaId] || ''}</td>
      <td><span class="badge ${claseTipo(m.tipo)}">${esc(m.tipo)}</span></td>
      <td>${esc(m.descripcion)}</td>
      <td class="${m.monto < 0 ? 'neg' : 'pos'}">${Q(m.monto)}</td>
      <td>${Q(m.saldo)}</td>
    </tr>`;
}

function tablaMov(movimientos, mapa) {
  if (!movimientos.length) return '<p class="mut">Sin movimientos.</p>';

  return `
    <table>
      <tr>
        <th>Fecha</th>
        <th>Cuenta</th>
        <th>Tipo</th>
        <th>Descripción</th>
        <th>Monto</th>
        <th>Saldo</th>
      </tr>
      ${movimientos.map(m => filaMov(m, mapa)).join('')}
    </table>`;
}

// Diccionario id de cuenta -> número de cuenta
async function mapaCuentas() {
  const cuentas = await db.cuentas.toArray();
  return Object.fromEntries(cuentas.map(c => [c.id, c.numero]));
}

// Opciones para los <select> de cuentas
function optCuentas(cuentas) {
  return cuentas.map(c => {
    const detalle = c.tipo === CRED
      ? 'Disponible ' + Q(c.limite - c.saldo)
      : Q(c.saldo);
    return `<option value="${c.id}">${c.tipo} · ${c.numero} · ${detalle}</option>`;
  }).join('');
}


/* ==================== OPERACIONES CONTABLES ==================== */
/*
  Aplica un cargo o un abono a una cuenta y registra el movimiento.
  - Cuentas normales: cargo resta saldo, abono suma saldo.
  - Tarjeta de crédito: el saldo es la deuda (cargo la sube, abono la baja).
*/
async function ajustar(id, monto, dir, tipo, descripcion) {
  const cuenta = await db.cuentas.get(id);
  const esCredito = cuenta.tipo === CRED;
  const sube = (dir === 'cargo') === esCredito;
  const nuevo = r2(cuenta.saldo + (sube ? monto : -monto));

  if (!esCredito && nuevo < 0) {
    throw Error('Saldo insuficiente en la cuenta ' + cuenta.numero);
  }
  if (esCredito && nuevo > cuenta.limite) {
    throw Error('La operación excede el límite de la tarjeta');
  }
  if (esCredito && nuevo < 0) {
    throw Error('El pago excede la deuda de la tarjeta');
  }

  cuenta.saldo = nuevo;
  await db.cuentas.put(cuenta);

  await db.movimientos.add({
    cuentaId: id,
    tipo: tipo,
    descripcion: descripcion,
    monto: dir === 'cargo' ? -monto : monto,
    saldo: nuevo,
    fecha: new Date().toISOString()
  });
}

// Transacción: si algo falla, no se guarda nada
function trx(funcion) {
  return db.transaction(
    'rw',
    db.cuentas, db.movimientos, db.beneficiarios, db.solicitudes, db.cliente,
    funcion
  );
}

// Ejecuta una operación y muestra el resultado
async function ejecutar(funcion, mensajeOk, alTerminar) {
  try {
    await trx(funcion);
    toast(mensajeOk);
    if (alTerminar) alTerminar();
  } catch (e) {
    toast(e.message, false);
  }
}


/* ==================== LOGIN, REGISTRO Y SESIÓN ==================== */
function abrirLogin() {
  $('#modalLogin').classList.add('abierto');
  $('#lUser').focus();
}

$('#btnIngresar').onclick = abrirLogin;
$('#btnRegistro').onclick = abrirLogin;
$('#btnHero').onclick = abrirLogin;
$('#cerrarLogin').onclick = () => $('#modalLogin').classList.remove('abierto');

$('#formLogin').onsubmit = e => {
  e.preventDefault();

  const usuario = $('#lUser').value.trim();
  const clave = $('#lPass').value;

  if (usuario === 'admin' && clave === '2026') {
    sessionStorage.setItem('sb', '1');
    $('#modalLogin').classList.remove('abierto');
    $('#formLogin').reset();
    entrar();
  } else {
    toast('Usuario o contraseña incorrectos', false);
    const form = $('#formLogin');
    form.classList.add('sacude');
    setTimeout(() => form.classList.remove('sacude'), 400);
  }
};

async function entrar() {
  cliente = await db.cliente.get(1);

  // Si aún no hay cliente registrado, pide sus datos
  if (!cliente) return vista('registro');

  vista('app');
  seccion('resumen');
}

$('#btnSalir').onclick = () => {
  sessionStorage.removeItem('sb');
  vista('landing');
  toast('Sesión cerrada');
};

$('#btnMenu').onclick = () => $('#sidebar').classList.toggle('abierto');

$$('.menu button[data-sec]').forEach(b => {
  b.onclick = () => seccion(b.dataset.sec);
});

$('#formRegistro').onsubmit = async e => {
  e.preventDefault();

  const f = Object.fromEntries(new FormData(e.target));
  const saldo = r2(parseFloat(f.saldo));

  if (!/^\d{8}$/.test(f.telefono.replace(/\D/g, ''))) {
    return toast('El teléfono debe tener 8 dígitos', false);
  }
  if (!(saldo >= 0)) {
    return toast('Saldo inicial inválido', false);
  }

  await trx(async () => {
    // Datos del cliente
    cliente = {
      id: 1,
      nombres: f.nombres.trim(),
      apellidos: f.apellidos.trim(),
      telefono: f.telefono.trim(),
      direccion: f.direccion.trim(),
      desde: new Date().toISOString()
    };
    await db.cliente.put(cliente);

    // Cuenta monetaria con el saldo inicial indicado
    const total = r2(GASTOS.reduce((suma, g) => suma + g[2], 0));
    let corrida = r2(saldo + total);

    const id = await db.cuentas.add({
      numero: numCuenta(),
      tipo: 'Monetaria',
      saldo: saldo,
      limite: 0,
      creada: new Date().toISOString()
    });

    const diasAtras = n => new Date(Date.now() - n * 864e5).toISOString();

    // Saldo de apertura de hace 30 días
    await db.movimientos.add({
      cuentaId: id,
      tipo: 'Depósito',
      descripcion: 'Saldo de apertura del periodo',
      monto: corrida,
      saldo: corrida,
      fecha: diasAtras(30)
    });

    // Gastos inventados del último mes con tarjeta de débito
    for (const [dias, descripcion, monto] of GASTOS) {
      corrida = r2(corrida - monto);
      await db.movimientos.add({
        cuentaId: id,
        tipo: 'Gasto tarjeta débito',
        descripcion: descripcion + ' (Tarjeta de débito)',
        monto: -monto,
        saldo: corrida,
        fecha: diasAtras(dias)
      });
    }
  });

  toast('¡Bienvenido a Silver Bank!');
  e.target.reset();
  entrar();
};


/* ==================== RESUMEN ==================== */
render.resumen = async () => {
  const cuentas = await db.cuentas.toArray();
  const mapa = await mapaCuentas();
  const movimientos = (await db.movimientos.toArray())
    .sort((a, b) => b.fecha.localeCompare(a.fecha));

  const hace30dias = Date.now() - 30 * 864e5;

  const gastos = movimientos
    .filter(m => m.tipo === 'Gasto tarjeta débito' && new Date(m.fecha) > hace30dias)
    .reduce((suma, m) => suma - m.monto, 0);

  const disponible = cuentas
    .filter(c => c.tipo !== CRED)
    .reduce((suma, c) => suma + c.saldo, 0);

  const tarjetas = cuentas.map(c => {
    const esCred = c.tipo === CRED;
    const clase = esCred ? 'credito' : c.tipo;
    const monto = esCred ? Q(c.limite - c.saldo) : Q(c.saldo);
    const detalle = esCred
      ? `Disponible · Deuda ${Q(c.saldo)} · Límite ${Q(c.limite)}`
      : 'Saldo disponible';

    return `
      <div class="tarjeta ${clase}">
        <small>${c.tipo}</small>
        <div class="monto">${monto}</div>
        <small>${detalle}</small><br>
        <small>${c.numero} · ${esc(cliente.nombres)} ${esc(cliente.apellidos)}</small>
      </div>`;
  }).join('');

  $('#resumen').innerHTML = `
    <h2>Hola, ${esc(cliente.nombres)} 👋</h2>

    <div class="grid">${tarjetas}</div>
    <br>

    <div class="grid">
      <div class="card">
        <p>Total disponible</p>
        <div class="kpi">${Q(disponible)}</div>
      </div>

      <div class="card">
        <p>Gastos con tarjeta de débito (30 días)</p>
        <div class="kpi">${Q(gastos)}</div>
      </div>

      <div class="card">
        <p>Teléfono · Dirección</p>
        <b>${esc(cliente.telefono)}</b><br>
        ${esc(cliente.direccion)}
      </div>
    </div>

    <h3 style="margin:10px 0">Últimos movimientos</h3>
    <div class="card tabla">${tablaMov(movimientos.slice(0, 7), mapa)}</div>`;
};


/* ==================== TRANSFERENCIAS ==================== */
let cuentasPropias = [];
let beneficiarios = [];

render.transferir = async () => {
  cuentasPropias = (await db.cuentas.toArray()).filter(c => c.tipo !== CRED);
  beneficiarios = await db.beneficiarios.toArray();

  $('#tOrigen').innerHTML = optCuentas(cuentasPropias);
  llenarDestinos();
};

function llenarDestinos() {
  const tipo = $('#tTipo').value;
  const origen = +$('#tOrigen').value;
  let html;

  if (tipo === 'propia') {
    html = cuentasPropias
      .filter(c => c.id !== origen)
      .map(c => `<option value="c${c.id}">${c.tipo} · ${c.numero}</option>`)
      .join('');
  } else {
    const esTercero = tipo === 'tercero';
    html = beneficiarios
      .filter(b => (b.banco === 'Silver Bank') === esTercero)
      .map(b => `<option value="b${b.id}">${esc(b.nombre)} · ${esc(b.banco)} · ${esc(b.numero)}</option>`)
      .join('');
  }

  $('#tDestino').innerHTML = html || '<option value="">Sin destinos (agrégalos en Beneficiarios)</option>';
}

$('#tTipo').onchange = llenarDestinos;
$('#tOrigen').onchange = llenarDestinos;

$('#formTransf').onsubmit = e => {
  e.preventDefault();

  const tipo = $('#tTipo').value;
  const origen = +$('#tOrigen').value;
  const destino = $('#tDestino').value;
  const monto = r2(parseFloat($('#tMonto').value));
  const nota = $('#tDesc').value.trim();

  if (!destino) return toast('Selecciona una cuenta destino', false);
  if (!(monto > 0)) return toast('Monto inválido', false);

  const referencia = 'TR-' + Date.now().toString().slice(-9);
  const comision = tipo === 'otro' ? 5 : 0;
  let comprobante = null;

  ejecutar(async () => {
    const cuentaOrigen = await db.cuentas.get(origen);
    let destinoNombre, destinoBanco, destinoNumero, nombreTipo;

    if (tipo === 'propia') {
      // Entre mis cuentas
      const cuentaDestino = await db.cuentas.get(+destino.slice(1));
      nombreTipo = 'Transferencia entre mis cuentas';

      await ajustar(origen, monto, 'cargo', nombreTipo,
        `A ${cuentaDestino.numero} ${nota} · Ref. ${referencia}`);
      await ajustar(cuentaDestino.id, monto, 'abono', nombreTipo,
        `De ${cuentaOrigen.numero} ${nota} · Ref. ${referencia}`);

      destinoNombre = `${cliente.nombres} ${cliente.apellidos}`;
      destinoBanco = 'Silver Bank';
      destinoNumero = cuentaDestino.numero;

    } else {
      // A terceros u otros bancos
      const ben = await db.beneficiarios.get(+destino.slice(1));
      nombreTipo = tipo === 'tercero'
        ? 'Transferencia a terceros'
        : 'Transferencia a otro banco';

      await ajustar(origen, monto, 'cargo', nombreTipo,
        `A ${ben.nombre} (${ben.banco} ${ben.numero}) ${nota} · Ref. ${referencia}`);

      if (comision > 0) {
        await ajustar(origen, comision, 'cargo', 'Comisión',
          `Comisión por transferencia interbancaria · Ref. ${referencia}`);
      }

      destinoNombre = ben.nombre;
      destinoBanco = ben.banco;
      destinoNumero = ben.numero;
    }

    // Datos del comprobante (con el saldo ya actualizado)
    const origenActualizado = await db.cuentas.get(origen);

    comprobante = {
      referencia: referencia,
      fecha: new Date().toISOString(),
      tipo: nombreTipo,
      origen: `${cuentaOrigen.tipo} · ${cuentaOrigen.numero}`,
      destinoNombre: destinoNombre,
      destinoBanco: destinoBanco,
      destinoNumero: destinoNumero,
      monto: monto,
      comision: comision,
      nota: nota,
      saldo: origenActualizado.saldo
    };

  }, 'Transferencia realizada con éxito', () => {
    $('#tMonto').value = '';
    $('#tDesc').value = '';
    render.transferir();
    mostrarVoucher(comprobante);
  });
};


/* ==================== COMPROBANTE DE TRANSFERENCIA ==================== */
function mostrarVoucher(c) {
  const linea = (etiqueta, valor) =>
    `<div class="linea"><span>${etiqueta}</span><b>${esc(valor)}</b></div>`;

  $('#voucher').innerHTML = `
    <div class="logo c" style="color:#0b1f4a">◆ Silver<b>Bank</b></div>
    <div class="check">✓</div>
    <h2>Transferencia exitosa</h2>
    <div class="monto-g">${Q(c.monto)}</div>

    ${linea('No. de comprobante: ', c.referencia)}
    ${linea('Fecha y hora: ', F(c.fecha))}
    ${linea('Tipo: ', c.tipo)}
    ${linea('Cuenta origen: ', c.origen)}
    ${linea('Beneficiario: ', c.destinoNombre)}
    ${linea('Banco destino: ', c.destinoBanco)}
    ${linea('Cuenta destino: ', c.destinoNumero)}
    ${c.nota ? linea('Descripción: ', c.nota) : ''}
    ${c.comision > 0 ? linea('Comisión: ', Q(c.comision)) : ''}
    ${linea('Total debitado: ', Q(c.monto + c.comision))}
    ${linea('Saldo disponible: ', Q(c.saldo))}

    <div class="acciones">
      <button class="btn sec" id="vImprimir">🖨 Imprimir / PDF</button>
      <button class="btn" id="vCerrar">Cerrar</button>
    </div>`;

  $('#modalVoucher').classList.add('abierto');

  $('#vImprimir').onclick = () => window.print();
  $('#vCerrar').onclick = () => $('#modalVoucher').classList.remove('abierto');
}

// También se cierra al hacer clic fuera del comprobante
$('#modalVoucher').onclick = e => {
  if (e.target.id === 'modalVoucher') {
    $('#modalVoucher').classList.remove('abierto');
  }
};


/* ==================== PAGO DE SERVICIOS ==================== */
const SERVICIOS = {
  'Electricidad (EEGSA)':                 'NIS / contrato',
  'Agua (Empagua)':                       'No. de contador',
  'Telefonía (Claro)':                    'No. de teléfono',
  'Telefonía (Tigo)':                     'No. de teléfono',
  'Internet y cable':                     'No. de contrato',
  'Pago de tarjeta de crédito Silver Bank': ''
};

render.servicios = async () => {
  if (!$('#sServ').options.length) {
    $('#sServ').innerHTML = Object.keys(SERVICIOS)
      .map(s => `<option>${s}</option>`)
      .join('');
  }
  await actualizarServicios();
};

async function actualizarServicios() {
  const esTarjeta = $('#sServ').value.startsWith('Pago de tarjeta');
  const cuentas = await db.cuentas.toArray();
  const tarjeta = cuentas.find(c => c.tipo === CRED);

  // Oculta la referencia cuando se paga la tarjeta
  $('#lRef').style.display = esTarjeta ? 'none' : 'flex';
  $('#sRef').required = !esTarjeta;

  if (!esTarjeta) {
    $('#lRef').firstChild.textContent = SERVICIOS[$('#sServ').value];
  }

  // La tarjeta solo se paga desde cuentas normales
  const origenes = esTarjeta ? cuentas.filter(c => c.tipo !== CRED) : cuentas;
  $('#sOrigen').innerHTML = optCuentas(origenes);

  if (esTarjeta) {
    $('#sInfo').textContent = tarjeta
      ? `Deuda actual de tu tarjeta: ${Q(tarjeta.saldo)}`
      : 'Aún no tienes tarjeta de crédito. Solicítala en "Solicitar productos".';
  } else {
    $('#sInfo').textContent = '';
  }
}

$('#sServ').onchange = actualizarServicios;

$('#formServ').onsubmit = e => {
  e.preventDefault();

  const servicio = $('#sServ').value;
  const origen = +$('#sOrigen').value;
  const monto = r2(parseFloat($('#sMonto').value));
  const referencia = $('#sRef').value.trim();

  ejecutar(async () => {

    if (servicio.startsWith('Pago de tarjeta')) {
      const tarjeta = await db.cuentas.where('tipo').equals(CRED).first();
      if (!tarjeta) throw Error('No tienes tarjeta de crédito');

      await ajustar(origen, monto, 'cargo', 'Pago tarjeta de crédito',
        `Pago a tarjeta ${tarjeta.numero}`);
      await ajustar(tarjeta.id, monto, 'abono', 'Pago tarjeta de crédito',
        'Abono recibido');

    } else {
      await ajustar(origen, monto, 'cargo', 'Pago de servicio',
        `${servicio} · Ref. ${referencia}`);
    }

  }, 'Pago realizado con éxito', () => {
    $('#formServ').reset();
    actualizarServicios();
  });
};


/* ==================== BENEFICIARIOS / AGREGAR CUENTAS ==================== */
render.beneficiarios = async () => {
  const lista = await db.beneficiarios.toArray();

  $('#listaBen').innerHTML = lista.map(b => `
    <div class="card hov">
      <h3>${esc(b.nombre)}</h3>
      <p>${esc(b.banco)}<br>${esc(b.numero)}</p>
      <button class="btn peligro" data-del="${b.id}">Eliminar</button>
    </div>`).join('') || '<p class="mut">Aún no has agregado cuentas.</p>';

  $$('[data-del]').forEach(boton => {
    boton.onclick = async () => {
      await db.beneficiarios.delete(+boton.dataset.del);
      toast('Cuenta eliminada');
      render.beneficiarios();
    };
  });
};

$('#formBen').onsubmit = async e => {
  e.preventDefault();

  await db.beneficiarios.add({
    nombre: $('#bNombre').value.trim(),
    banco: $('#bBanco').value,
    numero: $('#bNum').value.trim()
  });

  toast('Cuenta agregada');
  e.target.reset();
  render.beneficiarios();
};


/* ==================== SOLICITUD DE PRODUCTOS ==================== */
$$('[data-prod]').forEach(boton => {
  boton.onclick = async () => {
    const producto = boton.dataset.prod;
    const numero = numCuenta();
    const cuentas = (await db.cuentas.toArray()).filter(c => c.tipo !== CRED);
    const form = $('#formProd');

    form.hidden = false;
    form.dataset.prod = producto;
    form.dataset.num = numero;

    // Campos propios de cada producto
    const camposProducto = producto === 'Ahorro'
      ? `
        <label>¿Cuánto deseas depositar? (Q)
          <input id="pMonto" type="number" min="1" step="0.01" required>
        </label>
        <label>Depositar desde
          <select id="pOrigen">${optCuentas(cuentas)}</select>
        </label>`
      : `
        <label>Límite de crédito
          <input value="${Q(LIMITE)}" disabled>
        </label>`;

    form.innerHTML = `
      <h3 class="todo">Solicitud: ${producto}</h3>

      <label>Titular
        <input value="${esc(cliente.nombres + ' ' + cliente.apellidos)}" disabled>
      </label>

      <label>Teléfono
        <input value="${esc(cliente.telefono)}" disabled>
      </label>

      <label>Número de cuenta que se abrirá
        <input value="${numero}" disabled>
      </label>

      ${camposProducto}

      <button class="btn">Confirmar solicitud</button>`;

    form.scrollIntoView({ behavior: 'smooth' });
  };
});

$('#formProd').onsubmit = async e => {
  e.preventDefault();

  const form = e.target;
  const producto = form.dataset.prod;
  const numero = form.dataset.num;

  // Solo se permite una tarjeta de crédito
  if (producto === CRED && await db.cuentas.where('tipo').equals(CRED).first()) {
    return toast('Ya tienes una tarjeta de crédito', false);
  }

  ejecutar(async () => {
    const id = await db.cuentas.add({
      numero: numero,
      tipo: producto,
      saldo: 0,
      limite: producto === CRED ? LIMITE : 0,
      creada: new Date().toISOString()
    });

    if (producto === 'Ahorro') {
      // El depósito inicial sale de la cuenta elegida
      const monto = r2(parseFloat($('#pMonto').value));

      await ajustar(+$('#pOrigen').value, monto, 'cargo', 'Transferencia entre mis cuentas',
        `Depósito inicial a cuenta de ahorro ${numero}`);
      await ajustar(id, monto, 'abono', 'Depósito',
        'Depósito inicial de apertura');

    } else {
      await db.movimientos.add({
        cuentaId: id,
        tipo: 'Apertura',
        descripcion: `Apertura de tarjeta de crédito, límite ${Q(LIMITE)}`,
        monto: 0,
        saldo: 0,
        fecha: new Date().toISOString()
      });
    }

    await db.solicitudes.add({
      producto: producto,
      numero: numero,
      fecha: new Date().toISOString()
    });

  }, `¡Producto aprobado! Cuenta ${numero} abierta`, () => {
    form.hidden = true;
  });
};


/* ==================== HISTORIAL ==================== */
render.historial = async () => {
  const cuentas = await db.cuentas.toArray();
  const movimientos = await db.movimientos.toArray();
  const tipos = [...new Set(movimientos.map(m => m.tipo))];

  // Conserva los filtros elegidos
  const cuentaElegida = $('#hCuenta').value;
  const tipoElegido = $('#hTipo').value;

  $('#hCuenta').innerHTML = '<option value="">Todas</option>' +
    cuentas.map(c => `<option value="${c.id}">${c.tipo} · ${c.numero}</option>`).join('');

  $('#hTipo').innerHTML = '<option value="">Todos</option>' +
    tipos.map(t => `<option>${esc(t)}</option>`).join('');

  $('#hCuenta').value = cuentaElegida;
  $('#hTipo').value = tipoElegido;

  pintarHistorial();
};

async function pintarHistorial() {
  const cuenta = $('#hCuenta').value;
  const tipo = $('#hTipo').value;
  const mapa = await mapaCuentas();

  const movimientos = (await db.movimientos.toArray())
    .filter(m => (!cuenta || m.cuentaId == cuenta) && (!tipo || m.tipo === tipo))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));

  // Suma de montos (en positivo) de los movimientos que cumplan la condición
  const sumar = condicion => movimientos
    .filter(condicion)
    .reduce((suma, m) => suma + Math.abs(m.monto), 0);

  $('#hResumen').innerHTML = `
    <div class="card">
      <p>Gastos tarjeta débito</p>
      <div class="kpi">${Q(sumar(m => m.tipo === 'Gasto tarjeta débito'))}</div>
    </div>

    <div class="card">
      <p>Pagos de servicios</p>
      <div class="kpi">${Q(sumar(m => /servicio|tarjeta de crédito/i.test(m.tipo) && m.monto < 0))}</div>
    </div>

    <div class="card">
      <p>Transferencias enviadas</p>
      <div class="kpi">${Q(sumar(m => /Transferencia/.test(m.tipo) && m.monto < 0))}</div>
    </div>`;

  $('#hTabla').innerHTML = tablaMov(movimientos, mapa);
}

$('#hCuenta').onchange = pintarHistorial;
$('#hTipo').onchange = pintarHistorial;


/* ==================== ESTADO DE CUENTA (EXCEL) ==================== */
const fechaISO = d => d.toISOString().slice(0, 10);

render.estado = async () => {
  const cuentas = await db.cuentas.toArray();
  const elegida = $('#eCuenta').value;

  $('#eCuenta').innerHTML = cuentas
    .map(c => `<option value="${c.id}">${c.tipo} · ${c.numero}</option>`)
    .join('');

  if (elegida) $('#eCuenta').value = elegida;

  // Por defecto: último mes
  if (!$('#eDesde').value) {
    $('#eDesde').value = fechaISO(new Date(Date.now() - 31 * 864e5));
    $('#eHasta').value = fechaISO(new Date());
  }

  vistaPreviaEstado();
};

// Obtiene la cuenta y los movimientos del periodo elegido
async function datosEstado() {
  const id = +$('#eCuenta').value;
  const cuenta = await db.cuentas.get(id);
  const desde = new Date($('#eDesde').value + 'T00:00:00');
  const hasta = new Date($('#eHasta').value + 'T23:59:59');

  const movimientos = (await db.movimientos.where('cuentaId').equals(id).toArray())
    .filter(m => {
      const fecha = new Date(m.fecha);
      return fecha >= desde && fecha <= hasta;
    })
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  return { cuenta, movimientos, desde, hasta };
}

async function vistaPreviaEstado() {
  const { cuenta, movimientos } = await datosEstado();
  if (!cuenta) return;

  $('#ePrev').innerHTML = tablaMov(movimientos, { [cuenta.id]: cuenta.numero });
}

$('#eCuenta').onchange = vistaPreviaEstado;
$('#eDesde').onchange = vistaPreviaEstado;
$('#eHasta').onchange = vistaPreviaEstado;

$('#btnExcel').onclick = async () => {
  const { cuenta, movimientos, desde, hasta } = await datosEstado();

  if (!movimientos.length) {
    return toast('No hay movimientos en ese periodo', false);
  }

  const totalDebitos = movimientos
    .filter(m => m.monto < 0)
    .reduce((suma, m) => suma - m.monto, 0);

  const totalCreditos = movimientos
    .filter(m => m.monto > 0)
    .reduce((suma, m) => suma + m.monto, 0);

  // Hoja 1: Estado de cuenta
  const filas = [
    ['SILVER BANK - ESTADO DE CUENTA'],
    [],
    ['Cliente', `${cliente.nombres} ${cliente.apellidos}`],
    ['Teléfono', cliente.telefono],
    ['Dirección', cliente.direccion],
    ['Cuenta', `${cuenta.tipo} ${cuenta.numero}`],
    ['Periodo', `${desde.toLocaleDateString('es-GT')} al ${hasta.toLocaleDateString('es-GT')}`],
    ['Fecha de emisión', new Date().toLocaleString('es-GT')],
    [cuenta.tipo === CRED ? 'Deuda actual (Q)' : 'Saldo actual (Q)', cuenta.saldo],
    [],
    ['Fecha', 'Tipo de movimiento', 'Descripción', 'Débito (Q)', 'Crédito (Q)', 'Saldo (Q)'],
    ...movimientos.map(m => [
      F(m.fecha),
      m.tipo,
      m.descripcion,
      m.monto < 0 ? -m.monto : '',
      m.monto > 0 ? m.monto : '',
      m.saldo
    ]),
    [],
    ['', '', 'TOTALES', r2(totalDebitos), r2(totalCreditos), cuenta.saldo]
  ];

  const hoja1 = XLSX.utils.aoa_to_sheet(filas);
  hoja1['!cols'] = [
    { wch: 20 }, { wch: 26 }, { wch: 52 }, { wch: 14 }, { wch: 14 }, { wch: 14 }
  ];

  // Hoja 2: Resumen por tipo de movimiento
  const porTipo = {};
  movimientos.forEach(m => {
    porTipo[m.tipo] = r2((porTipo[m.tipo] || 0) + m.monto);
  });

  const hoja2 = XLSX.utils.aoa_to_sheet([
    ['Tipo de movimiento', 'Total neto (Q)'],
    ...Object.entries(porTipo)
  ]);
  hoja2['!cols'] = [{ wch: 30 }, { wch: 16 }];

  // Libro de Excel
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja1, 'Estado de cuenta');
  XLSX.utils.book_append_sheet(libro, hoja2, 'Resumen por tipo');
  XLSX.writeFile(libro, `Estado_de_cuenta_${cuenta.numero}.xlsx`);

  toast('Estado de cuenta generado');
};


/* ==================== PERFIL ==================== */
render.perfil = () => {
  const form = $('#formPerfil');

  ['nombres', 'apellidos', 'telefono', 'direccion'].forEach(campo => {
    form.elements[campo].value = cliente[campo];
  });

  $('#pDesde').textContent =
    'Cliente desde ' + new Date(cliente.desde).toLocaleDateString('es-GT');
};

$('#formPerfil').onsubmit = async e => {
  e.preventDefault();

  const f = Object.fromEntries(new FormData(e.target));

  if (!/^\d{8}$/.test(f.telefono.replace(/\D/g, ''))) {
    return toast('El teléfono debe tener 8 dígitos', false);
  }

  Object.assign(cliente, f);
  await db.cliente.put(cliente);
  toast('Perfil actualizado');
};

$('#btnReset').onclick = async () => {
  const seguro = confirm(
    'Se borrarán todos los datos guardados (cliente, cuentas y movimientos). ¿Continuar?'
  );
  if (!seguro) return;

  await db.delete();
  sessionStorage.clear();
  location.reload();
};


/* ==================== INICIO ==================== */
// Si ya había una sesión abierta, entra directo
if (sessionStorage.getItem('sb')) {
  entrar();
}
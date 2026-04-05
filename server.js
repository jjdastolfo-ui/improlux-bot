const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────────
const NUMERO_ADMIN = process.env.NUMERO_ADMIN || "";

const CATEGORIAS = [
  "ALQUILER","ALQUILER ESTRUCTURA","ALIMENTACION RECRIA","ALIMENTACION CRIA",
  "TERMINACION","INSUMOS VETERINARIOS","TRABAJOS VETERINARIOS",
  "COMBUSTIBLE CAMPO","COMBUSTIBLE VIATICOS","SUELDO JORNAL","SUELDO ENCARGADO",
  "VERDEOS Y PASTURAS","ESTRUCTURA GANADERA","MANTENIMIENTO CAMPO",
  "MANTENIMIENTO MAQUINARIA","GASTOS VENTAS GANADERAS","INVERSION MAQUINARIA",
  "COMPRA GANADO","COMPRA HERRAMIENTAS","BPS","GASTOS ADM","PROVISTA",
  "VEHICULOS","TELEFONO","INTERESES","GASTO BANCARIO","OTROS"
];

const DB_PATH = process.env.DB_PATH || "./improlux.db";
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

// ── BASE DE DATOS ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS transacciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    concepto TEXT NOT NULL,
    detalle TEXT,
    ingreso REAL DEFAULT 0,
    egreso REAL DEFAULT 0,
    proveedor TEXT,
    tc REAL,
    fuente TEXT DEFAULT 'whatsapp',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cuentas_corrientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor TEXT NOT NULL UNIQUE,
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cheques (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_emision TEXT NOT NULL,
    fecha_cobro TEXT,
    tipo TEXT NOT NULL,
    proveedor TEXT,
    monto REAL NOT NULL,
    estado TEXT DEFAULT 'PENDIENTE',
    banco TEXT DEFAULT 'BROU',
    concepto TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inversores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inversor TEXT NOT NULL,
    fecha_ingreso TEXT NOT NULL,
    capital REAL NOT NULL,
    tasa REAL NOT NULL,
    fecha_vencimiento TEXT,
    deuda_actual REAL,
    estado TEXT DEFAULT 'ACTIVO',
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    usuario TEXT PRIMARY KEY,
    historial TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS presupuestos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ciclo TEXT NOT NULL,
    concepto TEXT NOT NULL,
    monto_anual REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ciclo, concepto)
  );
`);

// Inicializar proveedores conocidos si no existen
const proveedoresIniciales = [
  { proveedor: 'AMAKAIK', notas: 'Compra de ganado' },
  { proveedor: 'MERCADO RURAL', notas: 'Insumos varios - cuenta corriente' },
  { proveedor: 'ZAMBRANO INSUMOS', notas: 'Insumos veterinarios y campo' },
  { proveedor: 'ZAMBRANO Y CIA', notas: 'Insumos veterinarios y campo' },
  { proveedor: 'DIEGO PIOLI', notas: 'Cuenta corriente - pagos frecuentes' },
  { proveedor: 'SELECTA SRL', notas: 'Servicios' },
  { proveedor: 'INVITRO', notas: 'Servicios veterinarios / genética' },
];
const stmtProv = db.prepare('INSERT OR IGNORE INTO cuentas_corrientes (proveedor, notas) VALUES (?, ?)');
proveedoresIniciales.forEach(p => stmtProv.run(p.proveedor, p.notas));
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

// ── TIPO DE CAMBIO ────────────────────────────────────────────────────────────
let tcCache = { valor: null, fecha: null };

async function getTipoCambio() {
  const ahora = new Date();
  if (tcCache.valor && tcCache.fecha && (ahora - tcCache.fecha) < 60 * 60 * 1000) {
    return tcCache.valor;
  }
  try {
    const resp = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await resp.json();
    if (data?.rates?.UYU) {
      tcCache = { valor: data.rates.UYU, fecha: ahora };
      console.log(`TC obtenido: $${data.rates.UYU.toFixed(2)} UYU/USD`);
      return data.rates.UYU;
    }
  } catch (e) {
    console.error("Error TC:", e.message);
  }
  return null;
}

// ── HELPERS DB ────────────────────────────────────────────────────────────────
function getHistorial(usuario) {
  const row = db.prepare("SELECT historial FROM sesiones WHERE usuario = ?").get(usuario);
  return row ? JSON.parse(row.historial) : [];
}

function saveHistorial(usuario, historial) {
  const reciente = historial.slice(-20);
  db.prepare(`
    INSERT INTO sesiones (usuario, historial, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(usuario) DO UPDATE SET historial = excluded.historial, updated_at = excluded.updated_at
  `).run(usuario, JSON.stringify(reciente));
}

function fmt(n) {
  return parseFloat(n).toLocaleString("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getSaldoProveedor(proveedor) {
  const row = db.prepare(`
    SELECT 
      COALESCE(SUM(egreso), 0) as total_compras,
      COALESCE(SUM(ingreso), 0) as total_pagos
    FROM transacciones 
    WHERE LOWER(proveedor) = LOWER(?)
  `).get(proveedor);
  return (row.total_compras - row.total_pagos);
}

function getResumenCuentasCorrientes() {
  const proveedores = db.prepare("SELECT * FROM cuentas_corrientes ORDER BY proveedor").all();
  return proveedores.map(p => ({
    ...p,
    saldo: getSaldoProveedor(p.proveedor)
  })).filter(p => p.saldo !== 0);
}

function getUltimasTransacciones(limite = 10) {
  return db.prepare("SELECT * FROM transacciones ORDER BY created_at DESC LIMIT ?").all(limite);
}

function getChequesPendientes() {
  return db.prepare("SELECT * FROM cheques WHERE estado = 'PENDIENTE' ORDER BY fecha_cobro ASC").all();
}

function getInversoresActivos() {
  return db.prepare("SELECT * FROM inversores WHERE estado = 'ACTIVO' ORDER BY inversor").all();
}

function calcularDeudaInversor(inversor) {
  const diasTranscurridos = Math.floor(
    (new Date() - new Date(inversor.fecha_ingreso)) / (1000 * 60 * 60 * 24)
  );
  const interesesAcumulados = inversor.capital * inversor.tasa * (diasTranscurridos / 365);
  return inversor.capital + interesesAcumulados;
}

// ── CICLO GANADERO (marzo a marzo) ────────────────────────────────────────────
function parseCiclo(cicloStr) {
  // Acepta "25/26", "2025/2026", "25-26", etc.
  const match = cicloStr.match(/(\d{2,4})[\/\-](\d{2,4})/);
  if (!match) return null;
  let anioInicio = parseInt(match[1]);
  let anioFin = parseInt(match[2]);
  if (anioInicio < 100) anioInicio += 2000;
  if (anioFin < 100) anioFin += 2000;
  return {
    ciclo: `${anioInicio % 100}/${anioFin % 100}`,
    fecha_desde: `${anioInicio}-03-01`,
    fecha_hasta: `${anioFin}-02-28`,
    label: `${anioInicio}/${anioFin}`
  };
}

function getCicloActual() {
  const hoy = new Date();
  const mes = hoy.getMonth() + 1; // 1-12
  const anio = hoy.getFullYear();
  // Si estamos en marzo o después → ciclo es anio/anio+1
  // Si estamos en enero-febrero → ciclo es anio-1/anio
  if (mes >= 3) {
    return parseCiclo(`${anio}/${anio + 1}`);
  } else {
    return parseCiclo(`${anio - 1}/${anio}`);
  }
}

function getInformeCiclo(cicloStr) {
  const ciclo = parseCiclo(cicloStr);
  if (!ciclo) return null;

  const hoy = new Date().toISOString().slice(0, 10);
  const fechaHasta = ciclo.fecha_hasta < hoy ? ciclo.fecha_hasta : hoy;

  const rows = db.prepare(`
    SELECT concepto, 
           SUM(egreso) as total_egreso, 
           SUM(ingreso) as total_ingreso,
           COUNT(*) as cant_movimientos
    FROM transacciones 
    WHERE fecha >= ? AND fecha <= ?
    GROUP BY concepto ORDER BY total_egreso DESC
  `).all(ciclo.fecha_desde, fechaHasta);

  const totalEgresos = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
  const totalIngresos = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);
  const totalMovimientos = rows.reduce((s, r) => s + r.cant_movimientos, 0);

  // Presupuestos del ciclo
  const presupuestos = db.prepare(
    "SELECT * FROM presupuestos WHERE ciclo = ?"
  ).all(ciclo.ciclo);
  const presupuestoMap = {};
  presupuestos.forEach(p => { presupuestoMap[p.concepto] = p.monto_anual; });

  return { ciclo, rows, totalEgresos, totalIngresos, totalMovimientos, presupuestoMap, fechaHasta };
}

function getInformeMensual(anio, mes) {
  const periodo = `${anio}-${String(mes).padStart(2, '0')}`;
  const rows = db.prepare(`
    SELECT concepto, 
           SUM(egreso) as total_egreso, 
           SUM(ingreso) as total_ingreso,
           COUNT(*) as cant
    FROM transacciones WHERE fecha LIKE ?
    GROUP BY concepto ORDER BY total_egreso DESC
  `).all(`${periodo}-%`);

  const totalEgresos = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
  const totalIngresos = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);

  // Presupuestos del ciclo que contiene ese mes
  const ciclo = mes >= 3
    ? parseCiclo(`${anio}/${anio + 1}`)
    : parseCiclo(`${anio - 1}/${anio}`);
  
  const presupuestos = ciclo ? db.prepare(
    "SELECT * FROM presupuestos WHERE ciclo = ?"
  ).all(ciclo.ciclo) : [];
  const presupuestoMap = {};
  presupuestos.forEach(p => { presupuestoMap[p.concepto] = p.monto_anual / 12; }); // mensualizado

  return { periodo, rows, totalEgresos, totalIngresos, presupuestoMap, ciclo };
}

// ── CRON INFORME MENSUAL WhatsApp ─────────────────────────────────────────────
function scheduleInformeMensual() {
  function checkAndSend() {
    const ahora = new Date();
    if (ahora.getDate() === 1 && ahora.getHours() === 8) {
      // Primer día del mes a las 8am → enviar informe del mes anterior
      const mesAnterior = ahora.getMonth(); // 0-11, el mes actual -1 = mes anterior (0=enero → diciembre año anterior)
      const anio = mesAnterior === 0 ? ahora.getFullYear() - 1 : ahora.getFullYear();
      const mes = mesAnterior === 0 ? 12 : mesAnterior;
      enviarInformeMensualWhatsApp(anio, mes);
    }
  }
  // Chequear cada hora
  setInterval(checkAndSend, 60 * 60 * 1000);
  console.log("📅 Cron de informe mensual programado (1ro de cada mes, 8am)");
}

async function enviarInformeMensualWhatsApp(anio, mes) {
  if (!NUMERO_ADMIN || !TWILIO_NUMBER) {
    console.log("⚠️ No se puede enviar informe: falta NUMERO_ADMIN o TWILIO_NUMBER");
    return;
  }

  const meses = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const informe = getInformeMensual(anio, mes);
  
  let msg = `📊 *IMPROLUX — Informe ${meses[mes]} ${anio}*\n\n`;
  
  if (!informe.rows.length) {
    msg += "Sin movimientos en este período.\n";
  } else {
    const lineas = informe.rows.filter(r => r.total_egreso > 0).map(r => {
      const presup = informe.presupuestoMap[r.concepto];
      const pct = presup ? ` (${((r.total_egreso / presup) * 100).toFixed(0)}% presup.)` : "";
      const warn = presup && r.total_egreso > presup ? " ⚠️" : "";
      return `  • ${r.concepto}: $${fmt(r.total_egreso)}${pct}${warn}`;
    });
    msg += lineas.join("\n");
    msg += `\n\n📤 Egresos: $${fmt(informe.totalEgresos)} USD`;
    msg += `\n📥 Ingresos: $${fmt(informe.totalIngresos)} USD`;
    msg += `\n💰 Neto: $${fmt(informe.totalIngresos - informe.totalEgresos)} USD`;
  }

  try {
    await twilioClient.messages.create({
      body: msg,
      from: TWILIO_NUMBER,
      to: NUMERO_ADMIN
    });
    console.log(`✅ Informe mensual enviado a ${NUMERO_ADMIN}`);
  } catch (e) {
    console.error("❌ Error enviando informe:", e.message);
  }
}

// ── CONTEXTO IA ───────────────────────────────────────────────────────────────
async function buildContexto() {
  const tc = await getTipoCambio();
  const ultimas = getUltimasTransacciones(10);
  const cuentas = getResumenCuentasCorrientes();
  const chequesPend = getChequesPendientes();
  const inversores = getInversoresActivos();
  const totalDeuda = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);

  // Resumen de egresos del mes actual
  const mesActual = new Date().toISOString().slice(0, 7);
  const egresosMes = db.prepare(`
    SELECT concepto, SUM(egreso) as total 
    FROM transacciones 
    WHERE fecha LIKE ? AND egreso > 0
    GROUP BY concepto ORDER BY total DESC LIMIT 10
  `).all(`${mesActual}-%`);

  return `Sos el asistente financiero de IMPROLUX, empresa ganadera uruguaya. Respondés en español rioplatense, conciso (máximo 5 líneas por respuesta de texto). 

FECHA DE HOY: ${new Date().toISOString().slice(0,10)} — SIEMPRE usar esta fecha en los registros, nunca inventar fechas.
MONEDA DEL SISTEMA: TODO EN DÓLARES AMERICANOS (USD).
TC BROU HOY: ${tc ? `$${tc.toFixed(2)} UYU/USD` : "No disponible"}
Si el usuario menciona pesos/UYU, convertir automáticamente y aclararlo.

CATEGORÍAS DE GASTO: ${CATEGORIAS.join(", ")}

HERRAMIENTAS — cuando sea una acción respondé SOLO con JSON exacto sin texto extra, sin markdown, sin bloques de código. NUNCA muestres el JSON al usuario — es solo para uso interno del sistema:
{"accion":"registrar_transaccion","fecha":"YYYY-MM-DD","concepto":"CATEGORIA","detalle":"descripción","ingreso":0,"egreso":0,"proveedor":"nombre o vacío","tc":${tc || 0}}
{"accion":"nuevo_proveedor","proveedor":"nombre","notas":""}
{"accion":"pago_proveedor","proveedor":"nombre","monto":0,"fecha":"YYYY-MM-DD"}
{"accion":"nuevo_cheque","fecha_emision":"YYYY-MM-DD","fecha_cobro":"YYYY-MM-DD","tipo":"EMITIDO o RECIBIDO","proveedor":"nombre","monto":0,"banco":"BROU","concepto":""}
{"accion":"marcar_cheque_cobrado","id":0}
{"accion":"nuevo_inversor","inversor":"nombre","capital":0,"tasa":0.08,"notas":""}
{"accion":"borrar_transaccion","id":0}
{"accion":"editar_transaccion","id":0,"concepto":"","detalle":"","egreso":0,"ingreso":0,"proveedor":"","fecha":"YYYY-MM-DD"}
{"accion":"ver_ultimos"}
{"accion":"ver_cuentas"}
{"accion":"ver_cheques"}
{"accion":"ver_inversores"}
{"accion":"resumen_mes"}
{"accion":"resumen_periodo","fecha_desde":"YYYY-MM-DD","fecha_hasta":"YYYY-MM-DD"}
{"accion":"ver_por_fecha","fecha":"YYYY-MM-DD"}
{"accion":"informe_ciclo","ciclo":"25/26"}
{"accion":"set_presupuesto","ciclo":"25/26","concepto":"CATEGORIA","monto_anual":0}
{"accion":"ver_presupuestos","ciclo":"25/26"}
{"accion":"informe_mensual","anio":2026,"mes":3}
{"accion":"texto","mensaje":"respuesta en texto"}

CICLOS GANADEROS:
- El ciclo va de MARZO a FEBRERO del año siguiente
- "ciclo 25/26" = marzo 2025 → febrero 2026
- "ciclo 26/27" = marzo 2026 → febrero 2027
- Si piden "informe anual" sin especificar → usar ciclo actual
- "presupuesto nafta 500" → set_presupuesto con ciclo actual y la categoría correcta

VOCABULARIO DEL USUARIO — mapeo de palabras que usa → categoría correcta:
NAFTA/NARFA → COMBUSTIBLE CAMPO
GASOIL CAMPO/NAFTA CAMPO → COMBUSTIBLE CAMPO
GASOIL/GASOIL CAMIONETA/CAMIONETA GASOIL/GSAOIL CAMIONETA → COMBUSTIBLE VIATICOS
COMBUSTIBLE CAMIONETA/COMBUSTIBE CAMPO → según contexto: campo=COMBUSTIBLE CAMPO, camioneta/viaticos=COMBUSTIBLE VIATICOS
VIATICOS/GASOIL VIATICOS/PEAJES/COMIDA VIAJE → COMBUSTIBLE VIATICOS
PROVISTA/COMIDA/COMIDA EDUARDO/VERDULERIA/SUPERMERCADO/EL DORADO/GARRAFA → PROVISTA
GIRO EDUARDO/PAGO EDUARDO/SUELDO EDUARDO/TRANSFERENCIA EDUARDO/TRASNFERENIA EDUARDO/RECARGAS CELULAR/RECARGAS EDUARDO/ENCARGUE COSAS EDUARDO/NAFTA CAMPO (cuando va a Eduardo)/ALIMENTO PERROS/ROPA EDUARDO/BOMBACHAS EDUARDO/LIMA PARA EDUARDO/PAGO EDUARDO PREMIO/TRANSFERENCIAS TUERTO/PROVISTA EDUARDO → SUELDO JORNAL
PAGO EDUARDO (cuando dice encargado) → SUELDO ENCARGADO
PORTERA/PIQUES/TORNILLOS/CLAVOS/AISLADORES/BATERIAS/BULONES MANGA/CANDADOS/LIMA Y ACEITE MOTOSIERRA/MANTENIMIENTO CAMPO/PAGO LIMPIEZA → MANTENIMIENTO CAMPO
SERVICIO TRACTOR/ACEITE GRUPO/ACEITE TRACTOR/ARREGLO ZORRA Y MAQUINARIA/SERVICIO CUATRI/MANTENIMIENTO MOTO/REPUESTOS MOTO/CAMARA MOTO/ARREGLO CUBIERTAS → MANTENIMIENTO MAQUINARIA
INSUMOS (sin especificar)/GASOIL CHILQUERA/COMBUSTIBLE CHILQUERA/FERTILIZANTE → VERDEOS Y PASTURAS
INSUMOS VETERINARIOS/INSUMOS VETERINATIOS/CARAVANAS → INSUMOS VETERINARIOS
FLETE ALIMENTO/ENVIO FLETE ALIMENTO → ALIMENTACION RECRIA
PAGO LAURA TACTO/ECOGRAFIAS/PAGO ECOGRAFIAS → TRABAJOS VETERINARIOS
BREEDPLAN/PAGO ARU INSCRIPCION → GASTOS DATOS Y PEDEGREE
PAGO FLETES/GUIAS → GASTOS VENTAS GANADERAS
ENVIO PANTALLAS/PANTALLAS CAMPO/ENVIO CABLES/INVERSOR LUZ → ALQUILER ESTRUCTURA
PAGO ETIENNE/PAGO BINLADEN/GASTOS CONTRATO NUEVO MARTIN/ALQUILER → ALQUILER
CONTADOR/PAGO CONTADOR → CREACION INICIO EMPRESA Y CONTADOR
TELEFONO/TELEFONO CAMPO/TELEFONO JONI → TELEFONO
BPS/PAGO BPS → BPS
ADMINISTRATIVOS/COMIDA AGUSTIN/PAGO DAC/ENCOMIENDAS → GASTOS ADM
CUBIERTAS CAMIONETA → VEHICULOS
TIJERA → COMPRA HERRAMIENTAS
COCINA A LEÑA → ESTRUCTURA GANADERA
PAGO DIEGO/PAGO CUENTA DIEGO/PAGO FDIEGO/PAGO DIEGO DEBITO/PAGO CUENTA CORRIENTE DIEGO/PAGO CHEQUE → PAGOS CUENTA CORRIENTE (proveedor: Diego Pioli)

PROVEEDORES CONOCIDOS (cuentas corrientes):
- AMAKAIK — compra de ganado
- MERCADO RURAL — insumos varios, siempre cuenta corriente
- ZAMBRANO INSUMOS / ZAMBRANO Y CIA — insumos veterinarios y campo
- DIEGO PIOLI — cuenta corriente, pagos frecuentes
- SELECTA SRL — servicios
- INVITRO — servicios veterinarios/genética
Cuando el detalle menciona estos nombres → registrar con ese proveedor

REGLAS CRÍTICAS:
- Vocabulario propio del usuario arriba → respetar siempre ese mapeo
- Si el nombre coincide con un proveedor conocido → usar accion pago_proveedor, NO registrar como sueldo
- "pago a [nombre]" con nombre en proveedores → SIEMPRE es pago_proveedor
- Gasto en pesos → convertir a USD con TC del día, aclarar conversión
- "borrar", "eliminar", "anular" + ID → usar borrar_transaccion (borra permanentemente)
- "corregir", "editar", "cambiar" + ID → usar editar_transaccion
- Para consultas de períodos específicos → usar resumen_periodo o ver_por_fecha
- EDUARDO = empleado de campo (SUELDO JORNAL generalmente)
- JONI = Jonatan, dueño (gastos administrativos/personales de la empresa)
- Si no entendés bien → usar accion texto y preguntar

DATOS ACTUALES:
Últimas 10 transacciones: ${JSON.stringify(ultimas.map(t => ({ id: t.id, fecha: t.fecha, concepto: t.concepto, detalle: t.detalle, ingreso: t.ingreso, egreso: t.egreso, proveedor: t.proveedor })))}
Cuentas corrientes con saldo: ${JSON.stringify(cuentas.map(c => ({ proveedor: c.proveedor, saldo: c.saldo.toFixed(2) })))}
Cheques pendientes: ${JSON.stringify(chequesPend.map(c => ({ id: c.id, tipo: c.tipo, proveedor: c.proveedor, monto: c.monto, vence: c.fecha_cobro })))}
Inversores activos: ${JSON.stringify(inversores.map(i => ({ inversor: i.inversor, capital: i.capital, tasa: i.tasa, deuda: calcularDeudaInversor(i).toFixed(2) })))}
Total deuda inversores: $${fmt(totalDeuda)} USD
Egresos mes actual por categoría: ${JSON.stringify(egresosMes)}`;
}

// ── EJECUTAR ACCIÓN ───────────────────────────────────────────────────────────
async function ejecutarAccion(accion) {
  const hoy = new Date().toISOString().split("T")[0];
  const tc = await getTipoCambio();

  // REGISTRAR TRANSACCIÓN
  if (accion.accion === "registrar_transaccion") {
    const { concepto, detalle, proveedor } = accion;
    let { ingreso, egreso } = accion;
    if (!concepto) return "❌ Faltan datos para registrar.";

    // Validar fecha — si es muy antigua o futura, usar hoy
    let fecha = accion.fecha || hoy;
    const fechaDate = new Date(fecha);
    const diff = Math.abs(new Date() - fechaDate) / (1000 * 60 * 60 * 24);
    if (isNaN(fechaDate) || diff > 365) fecha = hoy;

    db.prepare(`
      INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, tc, fuente)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'whatsapp')
    `).run(fecha || hoy, concepto, detalle || "", parseFloat(ingreso) || 0, parseFloat(egreso) || 0, proveedor || "", tc || 0);

    const tipo = ingreso > 0 ? `📥 Ingreso: $${fmt(ingreso)} USD` : `📤 Egreso: $${fmt(egreso)} USD`;
    return `✅ Registrado!\n📝 ${detalle || concepto}\n${tipo}\n📁 ${concepto}${proveedor ? `\n🏪 ${proveedor}` : ""}`;
  }

  // NUEVO PROVEEDOR
  if (accion.accion === "nuevo_proveedor") {
    const { proveedor, notas } = accion;
    if (!proveedor) return "❌ Falta el nombre del proveedor.";
    try {
      db.prepare("INSERT INTO cuentas_corrientes (proveedor, notas) VALUES (?, ?)").run(proveedor, notas || "");
      return `✅ Proveedor creado!\n🏪 ${proveedor}\nSaldo inicial: $0.00 USD`;
    } catch (e) {
      if (e.message.includes("UNIQUE")) return `⚠️ El proveedor "${proveedor}" ya existe en cuentas corrientes.`;
      return "❌ Error al crear proveedor.";
    }
  }

  // PAGO A PROVEEDOR
  if (accion.accion === "pago_proveedor") {
    const { proveedor, monto, fecha } = accion;
    if (!proveedor || !monto) return "❌ Faltan datos para registrar el pago.";

    db.prepare(`
      INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, tc, fuente)
      VALUES (?, 'PAGO CUENTA CORRIENTE', ?, ?, 0, ?, ?, 'whatsapp')
    `).run(fecha || hoy, `Pago a ${proveedor}`, parseFloat(monto), proveedor, tc || 0);

    const saldoNuevo = getSaldoProveedor(proveedor);
    return `✅ Pago registrado!\n🏪 ${proveedor}\n💰 $${fmt(monto)} USD\n📊 Saldo pendiente: $${fmt(saldoNuevo)} USD`;
  }

  // NUEVO CHEQUE
  if (accion.accion === "nuevo_cheque") {
    const { fecha_emision, fecha_cobro, tipo, proveedor, monto, banco, concepto } = accion;
    if (!monto || !tipo) return "❌ Faltan datos para el cheque.";

    const result = db.prepare(`
      INSERT INTO cheques (fecha_emision, fecha_cobro, tipo, proveedor, monto, estado, banco, concepto)
      VALUES (?, ?, ?, ?, ?, 'PENDIENTE', ?, ?)
    `).run(fecha_emision || hoy, fecha_cobro || "", tipo, proveedor || "", parseFloat(monto), banco || "BROU", concepto || "");

    const emoji = tipo === "RECIBIDO" ? "📥" : "📤";
    return `✅ Cheque registrado! (ID: ${result.lastInsertRowid})\n${emoji} ${tipo}\n🏪 ${proveedor || "Sin proveedor"}\n💰 $${fmt(monto)} USD\n📅 Vence: ${fecha_cobro || "Sin fecha"}`;
  }

  // MARCAR CHEQUE COBRADO
  if (accion.accion === "marcar_cheque_cobrado") {
    const cheque = db.prepare("SELECT * FROM cheques WHERE id = ?").get(accion.id);
    if (!cheque) return "❌ No encontré ese cheque.";
    db.prepare("UPDATE cheques SET estado = 'COBRADO' WHERE id = ?").run(accion.id);
    return `✅ Cheque #${accion.id} marcado como cobrado.\n🏪 ${cheque.proveedor}\n💰 $${fmt(cheque.monto)} USD`;
  }

  // NUEVO INVERSOR
  if (accion.accion === "nuevo_inversor") {
    const { inversor, capital, tasa, notas } = accion;
    if (!inversor || !capital) return "❌ Faltan datos del inversor.";

    db.prepare(`
      INSERT INTO inversores (inversor, fecha_ingreso, capital, tasa, deuda_actual, estado, notas)
      VALUES (?, ?, ?, ?, ?, 'ACTIVO', ?)
    `).run(inversor, hoy, parseFloat(capital), parseFloat(tasa) || 0.08, parseFloat(capital), notas || "");

    return `✅ Inversor registrado!\n👤 ${inversor}\n💰 Capital: $${fmt(capital)} USD\n📈 Tasa: ${(parseFloat(tasa) * 100).toFixed(1)}% anual\n📅 Fecha ingreso: ${hoy}`;
  }

  // BORRAR TRANSACCIÓN (borrado real)
  if (accion.accion === "anular_transaccion" || accion.accion === "borrar_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id = ?").get(accion.id);
    if (!t) return "❌ No encontré esa transacción con ese ID.";
    db.prepare("DELETE FROM transacciones WHERE id = ?").run(accion.id);
    return `🗑️ Eliminado!\n📝 ${t.detalle || t.concepto}\n💰 ${t.egreso > 0 ? `-$${fmt(t.egreso)}` : `+$${fmt(t.ingreso)}`} USD\n📅 ${t.fecha}`;
  }

  // EDITAR TRANSACCIÓN
  if (accion.accion === "editar_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id = ?").get(accion.id);
    if (!t) return "❌ No encontré esa transacción.";
    const campos = {};
    if (accion.concepto) campos.concepto = accion.concepto;
    if (accion.detalle) campos.detalle = accion.detalle;
    if (accion.egreso !== undefined) campos.egreso = parseFloat(accion.egreso);
    if (accion.ingreso !== undefined) campos.ingreso = parseFloat(accion.ingreso);
    if (accion.proveedor !== undefined) campos.proveedor = accion.proveedor;
    if (accion.fecha) campos.fecha = accion.fecha;
    if (!Object.keys(campos).length) return "❌ No hay campos para editar.";
    const sets = Object.keys(campos).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE transacciones SET ${sets} WHERE id = ?`).run(...Object.values(campos), accion.id);
    return `✅ Transacción #${accion.id} actualizada!\n📝 ${campos.detalle || t.detalle}`;
  }

  // VER ÚLTIMOS
  if (accion.accion === "ver_ultimos") {
    const ultimos = getUltimasTransacciones(8);
    if (!ultimos.length) return "📋 No hay transacciones registradas.";
    const lineas = ultimos.map((t, i) =>
      `${i + 1}. [#${t.id}] ${t.concepto} · ${t.egreso > 0 ? `-$${fmt(t.egreso)}` : `+$${fmt(t.ingreso)}`} · ${t.fecha}${t.proveedor ? ` · ${t.proveedor}` : ""}`
    ).join("\n");
    return `📋 *Últimas transacciones:*\n\n${lineas}\n\nPara anular alguna decí "anular #ID"`;
  }

  // VER CUENTAS CORRIENTES
  if (accion.accion === "ver_cuentas") {
    const cuentas = getResumenCuentasCorrientes();
    if (!cuentas.length) return "📋 No hay cuentas corrientes con saldo pendiente.";
    const lineas = cuentas.map(c =>
      `${c.saldo > 0 ? "🔴" : "🟢"} ${c.proveedor}: $${fmt(Math.abs(c.saldo))} USD ${c.saldo > 0 ? "(debemos)" : "(a favor)"}`
    ).join("\n");
    const total = cuentas.reduce((s, c) => s + c.saldo, 0);
    return `🔄 *Cuentas Corrientes:*\n\n${lineas}\n\n💳 Total adeudado: $${fmt(total)} USD`;
  }

  // VER CHEQUES
  if (accion.accion === "ver_cheques") {
    const cheques = getChequesPendientes();
    if (!cheques.length) return "✅ No hay cheques pendientes.";
    const lineas = cheques.map(c =>
      `${c.tipo === "EMITIDO" ? "📤" : "📥"} [#${c.id}] ${c.proveedor || "Sin prov."} · $${fmt(c.monto)} USD · vence ${c.fecha_cobro || "sin fecha"}`
    ).join("\n");
    const total = cheques.reduce((s, c) => s + c.monto, 0);
    return `🏦 *Cheques pendientes:*\n\n${lineas}\n\n💳 Total: $${fmt(total)} USD`;
  }

  // VER INVERSORES
  if (accion.accion === "ver_inversores") {
    const inversores = getInversoresActivos();
    if (!inversores.length) return "📋 No hay inversores activos.";
    const lineas = inversores.map(i => {
      const deuda = calcularDeudaInversor(i);
      return `👤 ${i.inversor}\n   Capital: $${fmt(i.capital)} · Tasa: ${(i.tasa * 100).toFixed(1)}%\n   Deuda actual: $${fmt(deuda)} USD`;
    }).join("\n\n");
    const totalDeuda = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);
    return `👥 *Inversores activos:*\n\n${lineas}\n\n💳 Deuda total: $${fmt(totalDeuda)} USD`;
  }

  // RESUMEN MES — acepta mes/año específico
  if (accion.accion === "resumen_mes") {
    // Detectar si piden un mes específico (ej: "marzo 2026" → fecha_desde en el JSON)
    const periodo = accion.periodo || new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT concepto, SUM(egreso) as total_egreso, SUM(ingreso) as total_ingreso
      FROM transacciones WHERE fecha LIKE ?
      GROUP BY concepto ORDER BY total_egreso DESC
    `).all(`${periodo}-%`);

    if (!rows.length) return `📊 No hay movimientos en ${periodo}.`;

    const totalEgresos = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
    const totalIngresos = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);
    const lineas = rows.filter(r => r.total_egreso > 0)
      .map(r => `  • ${r.concepto}: $${fmt(r.total_egreso)}`).join("\n");

    return `📊 *Resumen ${periodo}*\n\n${lineas || "Sin egresos"}\n\n📤 Total egresos: $${fmt(totalEgresos)} USD\n📥 Total ingresos: $${fmt(totalIngresos)} USD\n💰 Neto: $${fmt(totalIngresos - totalEgresos)} USD`;
  }

  // RESUMEN POR PERÍODO
  if (accion.accion === "resumen_periodo") {
    const { fecha_desde, fecha_hasta } = accion;
    if (!fecha_desde || !fecha_hasta) return "❌ Necesito fecha_desde y fecha_hasta.";

    const rows = db.prepare(`
      SELECT concepto, SUM(egreso) as total_egreso, SUM(ingreso) as total_ingreso
      FROM transacciones WHERE fecha BETWEEN ? AND ?
      GROUP BY concepto ORDER BY total_egreso DESC
    `).all(fecha_desde, fecha_hasta);

    if (!rows.length) return `📊 No hay movimientos entre ${fecha_desde} y ${fecha_hasta}.`;

    const totalEgresos = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
    const totalIngresos = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);
    const lineas = rows.filter(r => r.total_egreso > 0)
      .map(r => `  • ${r.concepto}: $${fmt(r.total_egreso)}`).join("\n");

    return `📊 *Período ${fecha_desde} → ${fecha_hasta}*\n\n${lineas || "Sin egresos"}\n\n📤 Egresos: $${fmt(totalEgresos)} USD\n📥 Ingresos: $${fmt(totalIngresos)} USD`;
  }

  // VER MOVIMIENTOS DE UN DÍA ESPECÍFICO
  if (accion.accion === "ver_por_fecha") {
    const { fecha } = accion;
    if (!fecha) return "❌ Necesito una fecha.";

    const rows = db.prepare(`
      SELECT * FROM transacciones WHERE fecha = ? ORDER BY created_at ASC
    `).all(fecha);

    if (!rows.length) return `📋 No hay movimientos el ${fecha}.`;

    const lineas = rows.map((t, i) =>
      `${i+1}. [#${t.id}] ${t.concepto} · ${t.detalle} · ${t.egreso > 0 ? `-$${fmt(t.egreso)}` : `+$${fmt(t.ingreso)}`} USD`
    ).join("\n");
    const total = rows.reduce((s, t) => s + t.egreso - t.ingreso, 0);

    return `📋 *Movimientos del ${fecha}:*\n\n${lineas}\n\n💰 Total del día: $${fmt(Math.abs(total))} USD`;
  }

  if (accion.accion === "texto") return accion.mensaje;

  // INFORME CICLO GANADERO
  if (accion.accion === "informe_ciclo") {
    const cicloStr = accion.ciclo || `${getCicloActual().ciclo}`;
    const informe = getInformeCiclo(cicloStr);
    if (!informe) return "❌ No pude interpretar el ciclo. Usá formato 25/26.";

    if (!informe.rows.length) return `📊 No hay movimientos en el ciclo ${informe.ciclo.label}.`;

    const lineas = informe.rows.filter(r => r.total_egreso > 0).map(r => {
      const presup = informe.presupuestoMap[r.concepto];
      let extra = "";
      if (presup) {
        const pct = ((r.total_egreso / presup) * 100).toFixed(0);
        extra = ` (${pct}% de $${fmt(presup)})`;
        if (r.total_egreso > presup) extra += " ⚠️";
      }
      return `  • ${r.concepto}: $${fmt(r.total_egreso)}${extra}`;
    });

    let msg = `📊 *IMPROLUX — Ciclo ${informe.ciclo.label}*\n`;
    msg += `📅 ${informe.ciclo.fecha_desde} → ${informe.fechaHasta}\n`;
    msg += `📋 ${informe.totalMovimientos} movimientos\n\n`;
    msg += lineas.join("\n");
    msg += `\n\n📤 Total egresos: $${fmt(informe.totalEgresos)} USD`;
    msg += `\n📥 Total ingresos: $${fmt(informe.totalIngresos)} USD`;
    msg += `\n💰 Neto: $${fmt(informe.totalIngresos - informe.totalEgresos)} USD`;

    // Resumen de presupuesto total si hay
    const totalPresup = Object.values(informe.presupuestoMap).reduce((s, v) => s + v, 0);
    if (totalPresup > 0) {
      const pctTotal = ((informe.totalEgresos / totalPresup) * 100).toFixed(0);
      msg += `\n\n📐 Presupuesto total ciclo: $${fmt(totalPresup)} USD`;
      msg += `\n📊 Ejecutado: ${pctTotal}%`;
    }

    return msg;
  }

  // SET PRESUPUESTO
  if (accion.accion === "set_presupuesto") {
    const cicloStr = accion.ciclo || getCicloActual().ciclo;
    const ciclo = parseCiclo(cicloStr);
    if (!ciclo) return "❌ Ciclo inválido. Usá formato 25/26.";
    if (!accion.concepto || !accion.monto_anual) return "❌ Necesito categoría y monto anual.";

    db.prepare(`
      INSERT INTO presupuestos (ciclo, concepto, monto_anual)
      VALUES (?, ?, ?)
      ON CONFLICT(ciclo, concepto) DO UPDATE SET monto_anual = excluded.monto_anual
    `).run(ciclo.ciclo, accion.concepto.toUpperCase(), parseFloat(accion.monto_anual));

    return `✅ Presupuesto definido!\n📁 ${accion.concepto.toUpperCase()}\n💰 $${fmt(accion.monto_anual)} USD/año\n📅 Ciclo ${ciclo.label}`;
  }

  // VER PRESUPUESTOS
  if (accion.accion === "ver_presupuestos") {
    const cicloStr = accion.ciclo || getCicloActual().ciclo;
    const ciclo = parseCiclo(cicloStr);
    if (!ciclo) return "❌ Ciclo inválido.";

    const presupuestos = db.prepare(
      "SELECT * FROM presupuestos WHERE ciclo = ? ORDER BY concepto"
    ).all(ciclo.ciclo);

    if (!presupuestos.length) return `📋 No hay presupuestos definidos para ciclo ${ciclo.label}.\nUsá "presupuesto [categoría] [monto]" para crear uno.`;

    // Obtener gastos reales del ciclo
    const hoy = new Date().toISOString().slice(0, 10);
    const fechaHasta = ciclo.fecha_hasta < hoy ? ciclo.fecha_hasta : hoy;

    const lineas = presupuestos.map(p => {
      const real = db.prepare(`
        SELECT COALESCE(SUM(egreso), 0) as total
        FROM transacciones 
        WHERE concepto = ? AND fecha >= ? AND fecha <= ?
      `).get(p.concepto, ciclo.fecha_desde, fechaHasta);

      const gastado = real.total;
      const pct = ((gastado / p.monto_anual) * 100).toFixed(0);
      const warn = gastado > p.monto_anual ? " ⚠️ EXCEDIDO" : "";
      const bar = gastado > 0 ? ` [${"█".repeat(Math.min(Math.round(pct / 10), 10))}${"░".repeat(Math.max(10 - Math.round(pct / 10), 0))}]` : "";
      return `📁 ${p.concepto}\n   $${fmt(gastado)} / $${fmt(p.monto_anual)} (${pct}%)${bar}${warn}`;
    });

    const totalPresup = presupuestos.reduce((s, p) => s + p.monto_anual, 0);
    return `📐 *Presupuestos — Ciclo ${ciclo.label}*\n\n${lineas.join("\n\n")}\n\n💰 Total presupuestado: $${fmt(totalPresup)} USD`;
  }

  // INFORME MENSUAL (bajo demanda)
  if (accion.accion === "informe_mensual") {
    const meses = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
    const anio = accion.anio || new Date().getFullYear();
    const mes = accion.mes || new Date().getMonth() + 1;
    const informe = getInformeMensual(anio, mes);

    if (!informe.rows.length) return `📊 No hay movimientos en ${meses[mes]} ${anio}.`;

    const lineas = informe.rows.filter(r => r.total_egreso > 0).map(r => {
      const presup = informe.presupuestoMap[r.concepto];
      const pct = presup ? ` (${((r.total_egreso / presup) * 100).toFixed(0)}% presup.)` : "";
      const warn = presup && r.total_egreso > presup ? " ⚠️" : "";
      return `  • ${r.concepto}: $${fmt(r.total_egreso)}${pct}${warn}`;
    });

    let msg = `📊 *IMPROLUX — ${meses[mes]} ${anio}*\n\n`;
    msg += lineas.join("\n");
    msg += `\n\n📤 Egresos: $${fmt(informe.totalEgresos)} USD`;
    msg += `\n📥 Ingresos: $${fmt(informe.totalIngresos)} USD`;
    msg += `\n💰 Neto: $${fmt(informe.totalIngresos - informe.totalEgresos)} USD`;
    return msg;
  }

  return "No entendí eso. Intentá de nuevo.";
}

// ── WEBHOOK INTERNO (llamado desde CasaFin) ───────────────────────────────────
app.post("/webhook-interno", async (req, res) => {
  try {
    const body = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0");
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0 || "";
    const usuario = "improlux";
    let respuesta = "";

    const historial = getHistorial(usuario);
    historial.push({ role: "user", content: body });

    const contexto = await buildContexto();
    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: contexto,
      messages: historial,
    });

    const rawRespuesta = result.content[0].text.trim();
    historial.push({ role: "assistant", content: rawRespuesta });
    saveHistorial(usuario, historial);

    const limpio = rawRespuesta.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    try {
      const jsonMatch = limpio.match(/\{[\s\S]*"accion"[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : limpio;
      const accion = JSON.parse(jsonStr);
      if (accion && accion.accion) {
        respuesta = await ejecutarAccion(accion);
      } else {
        respuesta = limpio;
      }
    } catch {
      respuesta = limpio;
    }

    res.json({ respuesta });
  } catch (err) {
    console.error("Error webhook-interno:", err);
    res.json({ respuesta: "❌ Error en IMPROLUX. Intentá de nuevo." });
  }
});

// ── WEBHOOK WHATSAPP ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const body = (req.body.Body || "").trim();
    const usuario = "improlux";
    let respuesta = "";

    const historial = getHistorial(usuario);
    historial.push({ role: "user", content: body });

    const contexto = await buildContexto();
    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: contexto,
      messages: historial,
    });

    const rawRespuesta = result.content[0].text.trim();
    historial.push({ role: "assistant", content: rawRespuesta });
    saveHistorial(usuario, historial);

    const limpio = rawRespuesta.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    try {
      const jsonMatch = limpio.match(/\{[\s\S]*"accion"[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : limpio;
      const accion = JSON.parse(jsonStr);
      if (accion && accion.accion) {
        respuesta = await ejecutarAccion(accion);
      } else {
        respuesta = limpio;
      }
    } catch {
      respuesta = limpio;
    }

    twiml.message(respuesta);
  } catch (err) {
    console.error("Error webhook:", err);
    twiml.message("❌ Ocurrió un error. Intentá de nuevo.");
  }
  res.type("text/xml").send(twiml.toString());
});

// ── CARGA MASIVA (importar histórico) ─────────────────────────────────────────
app.post("/api/importar", (req, res) => {
  const { transacciones } = req.body;
  if (!Array.isArray(transacciones)) return res.status(400).json({ error: 'Formato inválido' });
  
  let ok = 0, errores = 0;
  const stmt = db.prepare(`
    INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, tc, fuente)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const t of transacciones) {
    try {
      stmt.run(
        t.fecha || new Date().toISOString().slice(0,10),
        t.concepto || '',
        t.detalle || '',
        parseFloat(t.ingreso) || 0,
        parseFloat(t.egreso) || 0,
        t.proveedor || '',
        t.tc || null,
        t.fuente || 'historico'
      );
      ok++;
    } catch(e) { errores++; }
  }
  res.json({ ok, errores, total: transacciones.length });
});

// ── API REST PARA BOT HTML ────────────────────────────────────────────────────
app.get("/api/transacciones", (req, res) => {
  const limite = parseInt(req.query.limite) || 100;
  const rows = db.prepare("SELECT * FROM transacciones ORDER BY fecha DESC, created_at DESC LIMIT ?").all(limite);
  res.json(rows);
});

app.get("/api/cuentas", (req, res) => {
  const cuentas = db.prepare("SELECT * FROM cuentas_corrientes ORDER BY proveedor").all();
  const conSaldo = cuentas.map(c => ({ ...c, saldo: getSaldoProveedor(c.proveedor) }));
  res.json(conSaldo);
});

app.get("/api/cheques", (req, res) => {
  const rows = db.prepare("SELECT * FROM cheques ORDER BY fecha_cobro ASC").all();
  res.json(rows);
});

app.get("/api/inversores", (req, res) => {
  const rows = db.prepare("SELECT * FROM inversores ORDER BY inversor").all();
  const conDeuda = rows.map(i => ({ ...i, deuda_calculada: calcularDeudaInversor(i) }));
  res.json(conDeuda);
});

app.get("/api/tc", async (req, res) => {
  const tc = await getTipoCambio();
  res.json({ tc, fecha: new Date().toISOString().slice(0, 10) });
});

app.get("/api/resumen", (req, res) => {
  const mesActual = new Date().toISOString().slice(0, 7);
  const egresosMes = db.prepare(`SELECT SUM(egreso) as total FROM transacciones WHERE fecha LIKE ?`).get(`${mesActual}-%`);
  const ingresosMes = db.prepare(`SELECT SUM(ingreso) as total FROM transacciones WHERE fecha LIKE ?`).get(`${mesActual}-%`);
  const chequesPend = db.prepare("SELECT COUNT(*) as total, SUM(monto) as monto FROM cheques WHERE estado = 'PENDIENTE'").get();
  const inversores = getInversoresActivos();
  const totalDeuda = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);
  const totalMovimientos = db.prepare("SELECT COUNT(*) as total FROM transacciones").get();

  res.json({
    egresos_mes: egresosMes?.total || 0,
    ingresos_mes: ingresosMes?.total || 0,
    cheques_pendientes: chequesPend?.total || 0,
    monto_cheques: chequesPend?.monto || 0,
    deuda_inversores: totalDeuda,
    total_movimientos: totalMovimientos?.total || 0
  });
});

// ── API PRESUPUESTOS ──────────────────────────────────────────────────────────
app.get("/api/presupuestos", (req, res) => {
  const cicloStr = req.query.ciclo || getCicloActual().ciclo;
  const ciclo = parseCiclo(cicloStr);
  if (!ciclo) return res.status(400).json({ error: "Ciclo inválido" });

  const presupuestos = db.prepare(
    "SELECT * FROM presupuestos WHERE ciclo = ? ORDER BY concepto"
  ).all(ciclo.ciclo);

  const hoy = new Date().toISOString().slice(0, 10);
  const fechaHasta = ciclo.fecha_hasta < hoy ? ciclo.fecha_hasta : hoy;

  const resultado = presupuestos.map(p => {
    const real = db.prepare(`
      SELECT COALESCE(SUM(egreso), 0) as total
      FROM transacciones WHERE concepto = ? AND fecha >= ? AND fecha <= ?
    `).get(p.concepto, ciclo.fecha_desde, fechaHasta);
    return { ...p, gastado: real.total, porcentaje: p.monto_anual > 0 ? ((real.total / p.monto_anual) * 100) : 0 };
  });

  res.json({ ciclo: ciclo.label, presupuestos: resultado });
});

app.post("/api/presupuestos", (req, res) => {
  const { ciclo, concepto, monto_anual } = req.body;
  const cicloObj = parseCiclo(ciclo || getCicloActual().ciclo);
  if (!cicloObj || !concepto || !monto_anual) return res.status(400).json({ error: "Faltan datos" });

  db.prepare(`
    INSERT INTO presupuestos (ciclo, concepto, monto_anual)
    VALUES (?, ?, ?)
    ON CONFLICT(ciclo, concepto) DO UPDATE SET monto_anual = excluded.monto_anual
  `).run(cicloObj.ciclo, concepto.toUpperCase(), parseFloat(monto_anual));

  res.json({ ok: true, ciclo: cicloObj.label, concepto: concepto.toUpperCase(), monto_anual: parseFloat(monto_anual) });
});

app.post("/api/presupuestos/bulk", (req, res) => {
  const { ciclo, presupuestos } = req.body;
  const cicloObj = parseCiclo(ciclo || getCicloActual().ciclo);
  if (!cicloObj || !Array.isArray(presupuestos)) return res.status(400).json({ error: "Datos inválidos" });

  const stmt = db.prepare(`
    INSERT INTO presupuestos (ciclo, concepto, monto_anual)
    VALUES (?, ?, ?)
    ON CONFLICT(ciclo, concepto) DO UPDATE SET monto_anual = excluded.monto_anual
  `);

  let ok = 0;
  for (const p of presupuestos) {
    if (p.concepto && p.monto_anual) {
      stmt.run(cicloObj.ciclo, p.concepto.toUpperCase(), parseFloat(p.monto_anual));
      ok++;
    }
  }
  res.json({ ok, ciclo: cicloObj.label });
});

// ── API INFORME CICLO ─────────────────────────────────────────────────────────
app.get("/api/informe-ciclo", (req, res) => {
  const cicloStr = req.query.ciclo || getCicloActual().ciclo;
  const informe = getInformeCiclo(cicloStr);
  if (!informe) return res.status(400).json({ error: "Ciclo inválido" });
  res.json({
    ciclo: informe.ciclo.label,
    fecha_desde: informe.ciclo.fecha_desde,
    fecha_hasta: informe.fechaHasta,
    total_egresos: informe.totalEgresos,
    total_ingresos: informe.totalIngresos,
    total_movimientos: informe.totalMovimientos,
    categorias: informe.rows,
    presupuestos: informe.presupuestoMap
  });
});

// ── API INFORME MENSUAL ───────────────────────────────────────────────────────
app.get("/api/informe-mensual", (req, res) => {
  const anio = parseInt(req.query.anio) || new Date().getFullYear();
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const informe = getInformeMensual(anio, mes);
  res.json({
    periodo: informe.periodo,
    total_egresos: informe.totalEgresos,
    total_ingresos: informe.totalIngresos,
    categorias: informe.rows,
    presupuestos_mensualizados: informe.presupuestoMap
  });
});

// ── ENVIAR INFORME MANUAL (para testing) ──────────────────────────────────────
app.post("/api/enviar-informe", async (req, res) => {
  const anio = parseInt(req.body.anio) || new Date().getFullYear();
  const mes = parseInt(req.body.mes) || new Date().getMonth();
  if (mes < 1 || mes > 12) return res.status(400).json({ error: "Mes inválido" });
  await enviarInformeMensualWhatsApp(anio, mes);
  res.json({ ok: true, mensaje: `Informe ${mes}/${anio} enviado` });
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "IMPROLUX Bot activo 🟢", version: "4.0" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IMPROLUX Bot v4.0 corriendo en puerto ${PORT}`);
  scheduleInformeMensual();
});

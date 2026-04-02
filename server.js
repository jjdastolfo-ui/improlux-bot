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
const CATEGORIAS = [
  "ALQUILER","ALQUILER ESTRUCTURA","ALIMENTACION RECRIA","ALIMENTACION CRIA",
  "TERMINACION","INSUMOS VETERINARIOS","TRABAJOS VETERINARIOS",
  "COMBUSTIBLE CAMPO","COMBUSTIBLE VIATICOS","SUELDO JORNAL","SUELDO ENCARGADO",
  "VERDEOS Y PASTURAS","ESTRUCTURA GANADERA","MANTENIMIENTO CAMPO",
  "MANTENIMIENTO MAQUINARIA","GASTOS VENTAS GANADERAS","INVERSION MAQUINARIA",
  "COMPRA GANADO","COMPRA HERRAMIENTAS","BPS","GASTOS ADM","PROVISTA",
  "VEHICULOS","TELEFONO","INTERESES","GASTO BANCARIO",
  "GASTOS DATOS Y PEDEGREE","TRASLADOS GANADEROS","VENTAS","SUELDOS ADM","OTROS"
];

const DB_PATH = process.env.DB_PATH || "./improlux.db";
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    es_cc INTEGER DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS cc_movimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    proveedor TEXT NOT NULL,
    monto REAL NOT NULL,
    medio TEXT NOT NULL DEFAULT 'EFECTIVO',
    cheque_id INTEGER,
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
    estado TEXT DEFAULT 'ACTIVO',
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    cantidad INTEGER,
    categoria TEXT,
    precio_unit REAL,
    total REAL NOT NULL,
    gastos_comerciales REAL DEFAULT 0,
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    usuario TEXT PRIMARY KEY,
    historial TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migraciones seguras
try { db.exec(`ALTER TABLE transacciones ADD COLUMN es_cc INTEGER DEFAULT 0`); } catch(e) {}

// Proveedores iniciales
const proveedoresIniciales = [
  { proveedor: 'AMAKAIK',          notas: 'Compra de ganado' },
  { proveedor: 'MERCADO RURAL',    notas: 'Insumos varios - cuenta corriente' },
  { proveedor: 'ZAMBRANO INSUMOS', notas: 'Insumos veterinarios y campo' },
  { proveedor: 'ZAMBRANO Y CIA',   notas: 'Insumos veterinarios y campo' },
  { proveedor: 'DIEGO PIOLI',      notas: 'Cuenta corriente - pagos frecuentes' },
  { proveedor: 'SELECTA SRL',      notas: 'Servicios' },
  { proveedor: 'INVITRO',          notas: 'Servicios veterinarios / genética' },
];
const stmtProv = db.prepare('INSERT OR IGNORE INTO cuentas_corrientes (proveedor, notas) VALUES (?, ?)');
proveedoresIniciales.forEach(p => stmtProv.run(p.proveedor, p.notas));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

// ── TIPO DE CAMBIO ────────────────────────────────────────────────────────────
let tcCache = { valor: null, fecha: null };

async function getTipoCambio() {
  const ahora = new Date();
  if (tcCache.valor && tcCache.fecha && (ahora - tcCache.fecha) < 60 * 60 * 1000) return tcCache.valor;
  try {
    const resp = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await resp.json();
    if (data?.rates?.UYU) {
      tcCache = { valor: data.rates.UYU, fecha: ahora };
      return data.rates.UYU;
    }
  } catch (e) { console.error("Error TC:", e.message); }
  return null;
}

// ── HELPERS ────────────────────────────────────────────────────────────────────
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
  return parseFloat(n || 0).toLocaleString("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Saldo CC: compras registradas como CC - pagos en cc_movimientos
function getSaldoCC(proveedor) {
  const compras = db.prepare(`
    SELECT COALESCE(SUM(egreso), 0) as total FROM transacciones
    WHERE LOWER(proveedor) = LOWER(?) AND es_cc = 1
  `).get(proveedor);
  const pagos = db.prepare(`
    SELECT COALESCE(SUM(monto), 0) as total FROM cc_movimientos
    WHERE LOWER(proveedor) = LOWER(?)
  `).get(proveedor);
  return (compras.total || 0) - (pagos.total || 0);
}

function getResumenCC() {
  return db.prepare("SELECT * FROM cuentas_corrientes ORDER BY proveedor").all()
    .map(p => ({ ...p, saldo: getSaldoCC(p.proveedor) }))
    .filter(p => Math.abs(p.saldo) > 0.01);
}

function getUltimasTransacciones(limite = 10) {
  return db.prepare("SELECT * FROM transacciones ORDER BY fecha DESC, created_at DESC LIMIT ?").all(limite);
}

function getChequesPendientes() {
  return db.prepare("SELECT * FROM cheques WHERE estado = 'PENDIENTE' ORDER BY fecha_cobro ASC").all();
}

function getInversoresActivos() {
  return db.prepare("SELECT * FROM inversores WHERE estado = 'ACTIVO' ORDER BY inversor").all();
}

function calcularDeudaInversor(inv) {
  const dias = Math.floor((new Date() - new Date(inv.fecha_ingreso)) / (1000 * 60 * 60 * 24));
  return inv.capital + inv.capital * inv.tasa * (dias / 365);
}

// ── CONTEXTO IA ───────────────────────────────────────────────────────────────
async function buildContexto() {
  const tc = await getTipoCambio();
  const ultimas = getUltimasTransacciones(10);
  const cuentasCC = getResumenCC();
  const chequesPend = getChequesPendientes();
  const inversores = getInversoresActivos();
  const totalDeudaInv = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);
  const mesActual = new Date().toISOString().slice(0, 7);
  const egresosMes = db.prepare(`
    SELECT concepto, SUM(egreso) as total FROM transacciones
    WHERE fecha LIKE ? AND egreso > 0
    GROUP BY concepto ORDER BY total DESC LIMIT 10
  `).all(`${mesActual}-%`);

  return `Sos el asistente financiero de IMPROLUX, empresa ganadera uruguaya. Respondés en español rioplatense, conciso (máximo 5 líneas por respuesta de texto).

FECHA DE HOY: ${new Date().toISOString().slice(0,10)} — SIEMPRE usar esta fecha, nunca inventar fechas.
MONEDA: TODO EN USD. TC BROU HOY: ${tc ? `$${tc.toFixed(2)} UYU/USD` : "No disponible"}
Si el usuario menciona pesos/UYU, convertir automáticamente y aclararlo.

CATEGORÍAS: ${CATEGORIAS.join(", ")}

═══════════════════════════════════════
LÓGICA CONTABLE — MUY IMPORTANTE:
═══════════════════════════════════════
FLUJO DE CAJA (tabla transacciones):
  - Registra HECHOS ECONÓMICOS REALES: compras, gastos, ventas, sueldos
  - Una compra en cuenta corriente SÍ genera egreso en transacciones (es_cc=1, proveedor=nombre)
  - Los pagos de CC NO generan egreso en transacciones — son movimientos internos

CUENTAS CORRIENTES (tabla cc_movimientos):
  - Solo registra CÓMO SE CANCELA la deuda: efectivo, cheque o transferencia
  - NO afecta el flujo de caja
  - Saldo CC = compras acumuladas (es_cc=1) - pagos en cc_movimientos

MEDIOS DE PAGO DE CC: EFECTIVO | CHEQUE | TRANSFERENCIA

═══════════════════════════════════════
ACCIONES DISPONIBLES — respondé SOLO con el JSON exacto, sin texto extra, sin markdown:
═══════════════════════════════════════

Registrar gasto/ingreso de caja (efectivo/transferencia directa, no CC):
{"accion":"registrar_transaccion","fecha":"YYYY-MM-DD","concepto":"CATEGORIA","detalle":"descripción","ingreso":0,"egreso":0,"proveedor":"","es_cc":0,"tc":${tc || 0}}

Registrar compra en cuenta corriente (genera egreso real en el rubro):
{"accion":"registrar_transaccion","fecha":"YYYY-MM-DD","concepto":"CATEGORIA","detalle":"descripción","ingreso":0,"egreso":0,"proveedor":"NOMBRE_PROVEEDOR","es_cc":1,"tc":${tc || 0}}

Pagar cuenta corriente (solo movimiento interno, NO egreso de caja):
{"accion":"pagar_cc","fecha":"YYYY-MM-DD","proveedor":"NOMBRE","monto":0,"medio":"EFECTIVO","notas":""}

Nuevo proveedor CC:
{"accion":"nuevo_proveedor","proveedor":"nombre","notas":""}

Nuevo cheque:
{"accion":"nuevo_cheque","fecha_emision":"YYYY-MM-DD","fecha_cobro":"YYYY-MM-DD","tipo":"EMITIDO","proveedor":"","monto":0,"banco":"BROU","concepto":""}

Marcar cheque cobrado/pagado:
{"accion":"marcar_cheque_cobrado","id":0}

Nuevo inversor:
{"accion":"nuevo_inversor","inversor":"nombre","capital":0,"tasa":0.08,"notas":""}

Registrar venta ganadera:
{"accion":"registrar_venta","fecha":"YYYY-MM-DD","cantidad":0,"categoria":"VAQ/NOVILLOS/TOROS","precio_unit":0,"total":0,"gastos_comerciales":0,"notas":""}

Borrar transacción:
{"accion":"borrar_transaccion","id":0}

Editar transacción:
{"accion":"editar_transaccion","id":0,"concepto":"","detalle":"","egreso":0,"ingreso":0,"proveedor":"","es_cc":0,"fecha":"YYYY-MM-DD"}

Consultas:
{"accion":"ver_ultimos"}
{"accion":"ver_cuentas"}
{"accion":"ver_cheques"}
{"accion":"ver_inversores"}
{"accion":"resumen_mes","periodo":"YYYY-MM"}
{"accion":"resumen_periodo","fecha_desde":"YYYY-MM-DD","fecha_hasta":"YYYY-MM-DD"}
{"accion":"ver_por_fecha","fecha":"YYYY-MM-DD"}
{"accion":"ver_ventas"}
{"accion":"texto","mensaje":"respuesta en texto"}

═══════════════════════════════════════
VOCABULARIO DEL USUARIO:
═══════════════════════════════════════
NAFTA/NARFA → COMBUSTIBLE CAMPO
GASOIL CAMPO → COMBUSTIBLE CAMPO
GASOIL CAMIONETA/GSAOIL CAMIONETA/COMBUSTIBE CAMPO(camioneta) → COMBUSTIBLE VIATICOS
VIATICOS/PEAJES → COMBUSTIBLE VIATICOS
PROVISTA/COMIDA/EL DORADO/SUPERMERCADO/VERDULERIA/GARRAFA → PROVISTA
GIRO EDUARDO/PAGO EDUARDO/SUELDO EDUARDO/TRANSFERENCIA EDUARDO/RECARGAS CELULAR/NAFTA CAMPO(Eduardo)/ALIMENTO PERROS/ROPA EDUARDO/BOMBACHAS EDUARDO/LIMA PARA EDUARDO/CORDERO/CADENA MOTOSIERRA EDUARDO → SUELDO JORNAL
PAGO EDUARDO (cuando es encargado) → SUELDO ENCARGADO
PORTERA/PIQUES/TORNILLOS/CLAVOS/AISLADORES/CANDADOS → MANTENIMIENTO CAMPO
SERVICIO TRACTOR/ACEITE GRUPO/ACEITE TRACTOR/ARREGLO ZORRA/SERVICIO CUATRI/REPUESTOS MOTO/CAMARA MOTO/ARREGLO CUBIERTAS → MANTENIMIENTO MAQUINARIA
GASOIL CHILQUERA/COMBUSTIBLE CHILQUERA/FERTILIZANTE/FUMIGACION/SIEMBRA → VERDEOS Y PASTURAS
INSUMOS VETERINARIOS/CARAVANAS/PAJUELAS → INSUMOS VETERINARIOS
FLETE ALIMENTO/ENVIO FLETE ALIMENTO/ROLLOS → ALIMENTACION RECRIA
PAGO LAURA TACTO/ECOGRAFIAS → TRABAJOS VETERINARIOS
BREEDPLAN/PAGO ARU → GASTOS DATOS Y PEDEGREE
PAGO FLETES/GUIAS/TRASLADO VACAS → GASTOS VENTAS GANADERAS
ENVIO PANTALLAS/PANTALLAS CAMPO/ENVIO CABLES/INVERSOR LUZ → ALQUILER ESTRUCTURA
PAGO ETIENNE/PAGO BINLADEN/ALQUILER → ALQUILER
CONTADOR/PAGO CONTADOR/PAGO MARTIN → CREACION INICIO EMPRESA Y CONTADOR → usar GASTOS ADM
TELEFONO/TELEFONO CAMPO/TELEFONO JONI → TELEFONO
BPS/PAGO BPS → BPS
COMIDA AGUSTIN/PAGO DAC/ENCOMIENDAS/STARLINK → GASTOS ADM
CUBIERTAS CAMIONETA → VEHICULOS
TIJERA → COMPRA HERRAMIENTAS
COCINA A LEÑA → ESTRUCTURA GANADERA

COMPRAS EN CC (es_cc=1):
- MERCADO RURAL → siempre cuenta corriente
- ZAMBRANO INSUMOS / ZAMBRANO Y CIA → generalmente cuenta corriente
- DIEGO PIOLI → cuenta corriente
- Cualquier compra que el usuario diga "en cuenta" o "en la cuenta de X"

PAGOS DE CC (pagar_cc, NO registrar_transaccion):
- "pago a [proveedor CC]" → pagar_cc
- "pago cuenta Diego/Zambrano/Mercado Rural" → pagar_cc
- "pago cheque [proveedor CC]" → pagar_cc con medio=CHEQUE

PERSONAS:
- EDUARDO = empleado de campo → SUELDO JORNAL
- JONI = Jonatan, dueño → GASTOS ADM si es gasto personal/empresa

═══════════════════════════════════════
DATOS ACTUALES:
═══════════════════════════════════════
Últimas transacciones: ${JSON.stringify(ultimas.map(t => ({
  id: t.id, fecha: t.fecha, concepto: t.concepto, detalle: t.detalle,
  egreso: t.egreso, ingreso: t.ingreso, proveedor: t.proveedor, es_cc: t.es_cc
})))}
Saldos CC: ${JSON.stringify(cuentasCC.map(c => ({ proveedor: c.proveedor, saldo: c.saldo.toFixed(2) })))}
Cheques pendientes: ${JSON.stringify(chequesPend.map(c => ({ id: c.id, tipo: c.tipo, proveedor: c.proveedor, monto: c.monto, vence: c.fecha_cobro })))}
Inversores activos: ${JSON.stringify(inversores.map(i => ({ inversor: i.inversor, capital: i.capital, tasa: i.tasa, deuda: calcularDeudaInversor(i).toFixed(2) })))}
Total deuda inversores: $${fmt(totalDeudaInv)} USD
Egresos mes actual: ${JSON.stringify(egresosMes)}`;
}

// ── EJECUTAR ACCIÓN ───────────────────────────────────────────────────────────
async function ejecutarAccion(accion) {
  const hoy = new Date().toISOString().split("T")[0];
  const tc = await getTipoCambio();

  // REGISTRAR TRANSACCIÓN
  if (accion.accion === "registrar_transaccion") {
    const { concepto, detalle, proveedor } = accion;
    if (!concepto) return "❌ Faltan datos para registrar.";

    let fecha = accion.fecha || hoy;
    const diff = Math.abs(new Date() - new Date(fecha)) / (1000 * 60 * 60 * 24);
    if (isNaN(new Date(fecha)) || diff > 365) fecha = hoy;

    const esCC = accion.es_cc ? 1 : 0;
    const ingreso = parseFloat(accion.ingreso) || 0;
    const egreso = parseFloat(accion.egreso) || 0;

    db.prepare(`
      INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc, tc, fuente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp')
    `).run(fecha, concepto, detalle || "", ingreso, egreso, proveedor || "", esCC, tc || 0);

    const tipo = ingreso > 0 ? `📥 Ingreso: $${fmt(ingreso)} USD` : `📤 Egreso: $${fmt(egreso)} USD`;
    const ccLabel = esCC ? `\n🔄 Cuenta corriente: ${proveedor}` : "";
    return `✅ Registrado!\n📝 ${detalle || concepto}\n${tipo}\n📁 ${concepto}${ccLabel}`;
  }

  // PAGAR CUENTA CORRIENTE (movimiento interno, no afecta flujo de caja)
  if (accion.accion === "pagar_cc") {
    const { proveedor, monto, medio, notas } = accion;
    if (!proveedor || !monto) return "❌ Faltan datos para el pago.";

    const fecha = accion.fecha || hoy;
    let chequeId = null;

    // Si el medio es cheque, registrar el cheque automáticamente
    if (medio === "CHEQUE") {
      const res = db.prepare(`
        INSERT INTO cheques (fecha_emision, fecha_cobro, tipo, proveedor, monto, estado, banco, concepto)
        VALUES (?, ?, 'EMITIDO', ?, ?, 'PENDIENTE', 'BROU', ?)
      `).run(fecha, accion.fecha_cobro || "", proveedor, parseFloat(monto), `Pago CC ${proveedor}`);
      chequeId = res.lastInsertRowid;
    }

    db.prepare(`
      INSERT INTO cc_movimientos (fecha, proveedor, monto, medio, cheque_id, notas)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fecha, proveedor, parseFloat(monto), medio || "EFECTIVO", chequeId, notas || "");

    const saldoNuevo = getSaldoCC(proveedor);
    const medioEmoji = { EFECTIVO: "💵", CHEQUE: "📝", TRANSFERENCIA: "🏦" }[medio] || "💳";
    return `✅ Pago CC registrado!\n🏪 ${proveedor}\n${medioEmoji} $${fmt(monto)} USD via ${medio || "EFECTIVO"}\n📊 Saldo pendiente: $${fmt(saldoNuevo)} USD${chequeId ? `\n📝 Cheque #${chequeId} emitido` : ""}`;
  }

  // NUEVO PROVEEDOR CC
  if (accion.accion === "nuevo_proveedor") {
    const { proveedor, notas } = accion;
    if (!proveedor) return "❌ Falta el nombre del proveedor.";
    try {
      db.prepare("INSERT INTO cuentas_corrientes (proveedor, notas) VALUES (?, ?)").run(proveedor, notas || "");
      return `✅ Proveedor CC creado!\n🏪 ${proveedor}`;
    } catch (e) {
      if (e.message.includes("UNIQUE")) return `⚠️ "${proveedor}" ya existe.`;
      return "❌ Error al crear proveedor.";
    }
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
      INSERT INTO inversores (inversor, fecha_ingreso, capital, tasa, estado, notas)
      VALUES (?, ?, ?, ?, 'ACTIVO', ?)
    `).run(hoy, hoy, parseFloat(capital), parseFloat(tasa) || 0.08, notas || "");
    return `✅ Inversor registrado!\n👤 ${inversor}\n💰 Capital: $${fmt(capital)} USD\n📈 Tasa: ${(parseFloat(tasa) * 100).toFixed(1)}% anual`;
  }

  // REGISTRAR VENTA GANADERA
  if (accion.accion === "registrar_venta") {
    const { fecha, cantidad, categoria, precio_unit, total, gastos_comerciales, notas } = accion;
    if (!total) return "❌ Falta el total de la venta.";
    const result = db.prepare(`
      INSERT INTO ventas (fecha, cantidad, categoria, precio_unit, total, gastos_comerciales, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fecha || hoy, cantidad || 0, categoria || "", precio_unit || 0, parseFloat(total), parseFloat(gastos_comerciales) || 0, notas || "");

    // También registrar como ingreso en transacciones para el flujo de caja
    db.prepare(`
      INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc, tc, fuente)
      VALUES (?, 'VENTAS', ?, ?, 0, '', 0, ?, 'whatsapp')
    `).run(fecha || hoy, `Venta ${cantidad || ""} ${categoria || ""}`.trim(), parseFloat(total), tc || 0);

    if (gastos_comerciales > 0) {
      db.prepare(`
        INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc, tc, fuente)
        VALUES (?, 'GASTOS VENTAS GANADERAS', ?, 0, ?, '', 0, ?, 'whatsapp')
      `).run(fecha || hoy, `Gastos venta ${categoria || ""}`, parseFloat(gastos_comerciales), tc || 0);
    }

    return `✅ Venta registrada! (ID: ${result.lastInsertRowid})\n🐄 ${cantidad || "?"} ${categoria || ""}\n💰 Total: $${fmt(total)} USD\n📤 Gastos comerciales: $${fmt(gastos_comerciales || 0)} USD`;
  }

  // BORRAR TRANSACCIÓN
  if (accion.accion === "borrar_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id = ?").get(accion.id);
    if (!t) return "❌ No encontré esa transacción.";
    db.prepare("DELETE FROM transacciones WHERE id = ?").run(accion.id);
    return `🗑️ Eliminado!\n📝 ${t.detalle || t.concepto}\n💰 ${t.egreso > 0 ? `-$${fmt(t.egreso)}` : `+$${fmt(t.ingreso)}`} USD\n📅 ${t.fecha}`;
  }

  // EDITAR TRANSACCIÓN
  if (accion.accion === "editar_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id = ?").get(accion.id);
    if (!t) return "❌ No encontré esa transacción.";
    const campos = {};
    if (accion.concepto)            campos.concepto = accion.concepto;
    if (accion.detalle)             campos.detalle  = accion.detalle;
    if (accion.egreso  !== undefined) campos.egreso  = parseFloat(accion.egreso);
    if (accion.ingreso !== undefined) campos.ingreso = parseFloat(accion.ingreso);
    if (accion.proveedor !== undefined) campos.proveedor = accion.proveedor;
    if (accion.es_cc   !== undefined) campos.es_cc   = accion.es_cc ? 1 : 0;
    if (accion.fecha)               campos.fecha    = accion.fecha;
    if (!Object.keys(campos).length) return "❌ No hay campos para editar.";
    const sets = Object.keys(campos).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE transacciones SET ${sets} WHERE id = ?`).run(...Object.values(campos), accion.id);
    return `✅ Transacción #${accion.id} actualizada!`;
  }

  // VER ÚLTIMOS
  if (accion.accion === "ver_ultimos") {
    const ultimos = getUltimasTransacciones(8);
    if (!ultimos.length) return "📋 No hay transacciones registradas.";
    const lineas = ultimos.map((t, i) => {
      const monto = t.egreso > 0 ? `-$${fmt(t.egreso)}` : `+$${fmt(t.ingreso)}`;
      const cc = t.es_cc ? " [CC]" : "";
      return `${i+1}. [#${t.id}] ${t.fecha} · ${t.concepto}${cc} · ${monto}${t.proveedor ? ` · ${t.proveedor}` : ""}`;
    }).join("\n");
    return `📋 *Últimas transacciones:*\n\n${lineas}\n\nPara borrar: "borrar #ID"`;
  }

  // VER CUENTAS CORRIENTES
  if (accion.accion === "ver_cuentas") {
    const cuentas = getResumenCC();
    if (!cuentas.length) return "✅ No hay saldos pendientes en cuentas corrientes.";
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
      `${c.tipo === "EMITIDO" ? "📤" : "📥"} [#${c.id}] ${c.proveedor || "Sin prov."} · $${fmt(c.monto)} · vence ${c.fecha_cobro || "sin fecha"}`
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

  // RESUMEN MES
  if (accion.accion === "resumen_mes") {
    const periodo = accion.periodo || new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT concepto, SUM(egreso) as total_egreso, SUM(ingreso) as total_ingreso
      FROM transacciones WHERE fecha LIKE ?
      GROUP BY concepto ORDER BY total_egreso DESC
    `).all(`${periodo}-%`);
    if (!rows.length) return `📊 No hay movimientos en ${periodo}.`;
    const totalEgr = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
    const totalIng = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);
    const lineas = rows.filter(r => r.total_egreso > 0)
      .map(r => `  • ${r.concepto}: $${fmt(r.total_egreso)}`).join("\n");
    return `📊 *Resumen ${periodo}*\n\n${lineas || "Sin egresos"}\n\n📤 Total egresos: $${fmt(totalEgr)} USD\n📥 Total ingresos: $${fmt(totalIng)} USD\n💰 Neto: $${fmt(totalIng - totalEgr)} USD`;
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
    const totalEgr = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
    const totalIng = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);
    const lineas = rows.filter(r => r.total_egreso > 0)
      .map(r => `  • ${r.concepto}: $${fmt(r.total_egreso)}`).join("\n");
    return `📊 *Período ${fecha_desde} → ${fecha_hasta}*\n\n${lineas || "Sin egresos"}\n\n📤 Egresos: $${fmt(totalEgr)} USD\n📥 Ingresos: $${fmt(totalIng)} USD\n💰 Neto: $${fmt(totalIng - totalEgr)} USD`;
  }

  // VER POR FECHA
  if (accion.accion === "ver_por_fecha") {
    const { fecha } = accion;
    if (!fecha) return "❌ Necesito una fecha.";
    const rows = db.prepare("SELECT * FROM transacciones WHERE fecha = ? ORDER BY created_at ASC").all(fecha);
    if (!rows.length) return `📋 No hay movimientos el ${fecha}.`;
    const lineas = rows.map((t, i) => {
      const cc = t.es_cc ? " [CC]" : "";
      return `${i+1}. [#${t.id}] ${t.concepto}${cc} · ${t.detalle} · ${t.egreso > 0 ? `-$${fmt(t.egreso)}` : `+$${fmt(t.ingreso)}`} USD`;
    }).join("\n");
    const total = rows.reduce((s, t) => s + t.egreso - t.ingreso, 0);
    return `📋 *Movimientos del ${fecha}:*\n\n${lineas}\n\n💰 Total: $${fmt(Math.abs(total))} USD`;
  }

  // VER VENTAS
  if (accion.accion === "ver_ventas") {
    const ventas = db.prepare("SELECT * FROM ventas ORDER BY fecha DESC LIMIT 10").all();
    if (!ventas.length) return "📋 No hay ventas registradas.";
    const lineas = ventas.map(v =>
      `🐄 [#${v.id}] ${v.fecha} · ${v.cantidad || "?"} ${v.categoria || ""} · $${fmt(v.total)} USD`
    ).join("\n");
    const total = ventas.reduce((s, v) => s + v.total, 0);
    return `📦 *Últimas ventas:*\n\n${lineas}\n\n💰 Total: $${fmt(total)} USD`;
  }

  if (accion.accion === "texto") return accion.mensaje;
  return "No entendí eso. Intentá de nuevo.";
}

// ── PROCESAMIENTO CENTRAL ────────────────────────────────────────────────────
async function procesarMensaje(body, usuario) {
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
    if (accion && accion.accion) return await ejecutarAccion(accion);
    return limpio;
  } catch {
    return limpio;
  }
}

// ── WEBHOOK WHATSAPP ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const body = (req.body.Body || "").trim();
    const respuesta = await procesarMensaje(body, "improlux");
    twiml.message(respuesta);
  } catch (err) {
    console.error("Error webhook:", err);
    twiml.message("❌ Ocurrió un error. Intentá de nuevo.");
  }
  res.type("text/xml").send(twiml.toString());
});

// ── WEBHOOK INTERNO (desde panel web) ────────────────────────────────────────
app.post("/webhook-interno", async (req, res) => {
  try {
    const body = (req.body.Body || "").trim();
    const respuesta = await procesarMensaje(body, "improlux");
    res.json({ respuesta });
  } catch (err) {
    console.error("Error webhook-interno:", err);
    res.json({ respuesta: "❌ Error interno. Intentá de nuevo." });
  }
});

// ── CARGA MASIVA ──────────────────────────────────────────────────────────────
app.post("/api/importar", (req, res) => {
  const { transacciones } = req.body;
  if (!Array.isArray(transacciones)) return res.status(400).json({ error: 'Formato inválido' });
  let ok = 0, errores = 0;
  const stmt = db.prepare(`
    INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc, tc, fuente)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        t.es_cc ? 1 : 0,
        t.tc || null,
        t.fuente || 'historico'
      );
      ok++;
    } catch(e) { errores++; }
  }
  res.json({ ok, errores, total: transacciones.length });
});

// Importar movimientos CC históricos
app.post("/api/importar-cc", (req, res) => {
  const { movimientos } = req.body;
  if (!Array.isArray(movimientos)) return res.status(400).json({ error: 'Formato inválido' });
  let ok = 0, errores = 0;
  const stmt = db.prepare(`
    INSERT INTO cc_movimientos (fecha, proveedor, monto, medio, notas)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const m of movimientos) {
    try {
      stmt.run(m.fecha, m.proveedor, parseFloat(m.monto), m.medio || 'EFECTIVO', m.notas || '');
      ok++;
    } catch(e) { errores++; }
  }
  res.json({ ok, errores, total: movimientos.length });
});

// ── API REST ──────────────────────────────────────────────────────────────────
app.get("/api/transacciones", (req, res) => {
  const limite = parseInt(req.query.limite) || 100;
  const desde  = req.query.desde;
  const hasta  = req.query.hasta;
  let query = "SELECT * FROM transacciones";
  const params = [];
  if (desde && hasta) {
    query += " WHERE fecha BETWEEN ? AND ?";
    params.push(desde, hasta);
  } else if (desde) {
    query += " WHERE fecha >= ?";
    params.push(desde);
  }
  query += " ORDER BY fecha DESC, created_at DESC LIMIT ?";
  params.push(limite);
  res.json(db.prepare(query).all(...params));
});

app.get("/api/cuentas", (req, res) => {
  const cuentas = db.prepare("SELECT * FROM cuentas_corrientes ORDER BY proveedor").all();
  const conSaldo = cuentas.map(c => {
    const compras = db.prepare(`SELECT COALESCE(SUM(egreso),0) as t FROM transacciones WHERE LOWER(proveedor)=LOWER(?) AND es_cc=1`).get(c.proveedor);
    const pagos   = db.prepare(`SELECT COALESCE(SUM(monto),0)  as t FROM cc_movimientos    WHERE LOWER(proveedor)=LOWER(?)`).get(c.proveedor);
    const movimientos = db.prepare(`SELECT * FROM cc_movimientos WHERE LOWER(proveedor)=LOWER(?) ORDER BY fecha DESC LIMIT 5`).all(c.proveedor);
    return { ...c, total_compras: compras.t, total_pagos: pagos.t, saldo: compras.t - pagos.t, movimientos };
  });
  res.json(conSaldo);
});

app.get("/api/cc-movimientos", (req, res) => {
  const proveedor = req.query.proveedor;
  if (proveedor) {
    res.json(db.prepare("SELECT * FROM cc_movimientos WHERE LOWER(proveedor)=LOWER(?) ORDER BY fecha DESC").all(proveedor));
  } else {
    res.json(db.prepare("SELECT * FROM cc_movimientos ORDER BY fecha DESC LIMIT 100").all());
  }
});

app.get("/api/cheques", (req, res) => {
  const estado = req.query.estado;
  if (estado) {
    res.json(db.prepare("SELECT * FROM cheques WHERE estado = ? ORDER BY fecha_cobro ASC").all(estado));
  } else {
    res.json(db.prepare("SELECT * FROM cheques ORDER BY fecha_cobro DESC").all());
  }
});

app.get("/api/inversores", (req, res) => {
  const rows = db.prepare("SELECT * FROM inversores ORDER BY inversor").all();
  res.json(rows.map(i => ({ ...i, deuda_calculada: calcularDeudaInversor(i) })));
});

app.get("/api/ventas", (req, res) => {
  res.json(db.prepare("SELECT * FROM ventas ORDER BY fecha DESC").all());
});

app.get("/api/tc", async (req, res) => {
  const tc = await getTipoCambio();
  res.json({ tc, fecha: new Date().toISOString().slice(0, 10) });
});

app.get("/api/resumen", (req, res) => {
  const mesActual = new Date().toISOString().slice(0, 7);
  const egresosMes  = db.prepare(`SELECT COALESCE(SUM(egreso),0)  as total FROM transacciones WHERE fecha LIKE ?`).get(`${mesActual}-%`);
  const ingresosMes = db.prepare(`SELECT COALESCE(SUM(ingreso),0) as total FROM transacciones WHERE fecha LIKE ?`).get(`${mesActual}-%`);
  const chequesPend = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(monto),0) as monto FROM cheques WHERE estado='PENDIENTE'").get();
  const inversores  = getInversoresActivos();
  const totalDeuda  = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);
  const totalCC     = getResumenCC().reduce((s, c) => s + c.saldo, 0);
  const totalMov    = db.prepare("SELECT COUNT(*) as total FROM transacciones").get();
  res.json({
    egresos_mes:        egresosMes.total,
    ingresos_mes:       ingresosMes.total,
    neto_mes:           ingresosMes.total - egresosMes.total,
    cheques_pendientes: chequesPend.total,
    monto_cheques:      chequesPend.monto,
    deuda_inversores:   totalDeuda,
    deuda_cc:           totalCC,
    total_movimientos:  totalMov.total,
  });
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "IMPROLUX Bot activo 🟢", version: "4.0" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IMPROLUX Bot v4.0 corriendo en puerto ${PORT}`));

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
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── BASE DE DATOS ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS transacciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha       TEXT    NOT NULL,
    concepto    TEXT    NOT NULL,
    detalle     TEXT,
    ingreso     REAL    DEFAULT 0,
    egreso      REAL    DEFAULT 0,
    proveedor   TEXT,
    es_cc       INTEGER DEFAULT 0,
    tc          REAL,
    fuente      TEXT    DEFAULT 'whatsapp',
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cuentas_corrientes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor  TEXT NOT NULL UNIQUE,
    notas      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cc_movimientos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha      TEXT    NOT NULL,
    proveedor  TEXT    NOT NULL,
    monto      REAL    NOT NULL,
    medio      TEXT    NOT NULL DEFAULT 'EFECTIVO',
    cheque_id  INTEGER,
    notas      TEXT,
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cheques (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_emision  TEXT NOT NULL,
    fecha_cobro    TEXT,
    tipo           TEXT NOT NULL,
    proveedor      TEXT,
    monto          REAL NOT NULL,
    estado         TEXT DEFAULT 'PENDIENTE',
    banco          TEXT DEFAULT 'BROU',
    concepto       TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inversores (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    inversor          TEXT NOT NULL,
    fecha_ingreso     TEXT NOT NULL,
    capital           REAL NOT NULL,
    tasa              REAL NOT NULL,
    fecha_vencimiento TEXT,
    estado            TEXT DEFAULT 'ACTIVO',
    notas             TEXT,
    created_at        TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ventas (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha               TEXT NOT NULL,
    cantidad            INTEGER,
    categoria           TEXT,
    precio_unit         REAL,
    total               REAL NOT NULL,
    gastos_comerciales  REAL DEFAULT 0,
    notas               TEXT,
    created_at          TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    usuario    TEXT PRIMARY KEY,
    historial  TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migración segura para DBs existentes
try { db.exec(`ALTER TABLE transacciones ADD COLUMN es_cc INTEGER DEFAULT 0`); } catch(_) {}

// Proveedores CC conocidos
[
  ["AMAKAIK",          "Compra de ganado"],
  ["MERCADO RURAL",    "Insumos varios - cuenta corriente"],
  ["ZAMBRANO INSUMOS", "Insumos veterinarios y campo"],
  ["ZAMBRANO Y CIA",   "Insumos veterinarios y campo"],
  ["DIEGO PIOLI",      "Cuenta corriente - pagos frecuentes"],
  ["SELECTA SRL",      "Servicios"],
  ["INVITRO",          "Servicios veterinarios / genetica"],
].forEach(([p, n]) =>
  db.prepare("INSERT OR IGNORE INTO cuentas_corrientes (proveedor, notas) VALUES (?, ?)").run(p, n)
);

// ── TIPO DE CAMBIO ────────────────────────────────────────────────────────────
let tcCache = { valor: null, fecha: null };
async function getTipoCambio() {
  const ahora = new Date();
  if (tcCache.valor && tcCache.fecha && (ahora - tcCache.fecha) < 3600000) return tcCache.valor;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const d = await r.json();
    if (d?.rates?.UYU) { tcCache = { valor: d.rates.UYU, fecha: ahora }; return d.rates.UYU; }
  } catch (e) { console.error("TC error:", e.message); }
  return null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const fmt = n => parseFloat(n || 0).toLocaleString("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function getHistorial(usuario) {
  const row = db.prepare("SELECT historial FROM sesiones WHERE usuario = ?").get(usuario);
  return row ? JSON.parse(row.historial) : [];
}

function saveHistorial(usuario, historial) {
  db.prepare(`
    INSERT INTO sesiones (usuario, historial, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(usuario) DO UPDATE SET historial = excluded.historial, updated_at = excluded.updated_at
  `).run(usuario, JSON.stringify(historial.slice(-20)));
}

// Saldo CC = compras acumuladas (es_cc=1) MENOS pagos en cc_movimientos
function getSaldoCC(proveedor) {
  const { compras } = db.prepare(
    "SELECT COALESCE(SUM(egreso),0) as compras FROM transacciones WHERE LOWER(proveedor)=LOWER(?) AND es_cc=1"
  ).get(proveedor);
  const { pagos } = db.prepare(
    "SELECT COALESCE(SUM(monto),0) as pagos FROM cc_movimientos WHERE LOWER(proveedor)=LOWER(?)"
  ).get(proveedor);
  return compras - pagos;
}

function getResumenCC() {
  return db.prepare("SELECT * FROM cuentas_corrientes ORDER BY proveedor").all()
    .map(p => ({ ...p, saldo: getSaldoCC(p.proveedor) }))
    .filter(p => Math.abs(p.saldo) > 0.01);
}

function getUltimasTransacciones(n = 10) {
  return db.prepare("SELECT * FROM transacciones ORDER BY fecha DESC, created_at DESC LIMIT ?").all(n);
}

function getChequesPendientes() {
  return db.prepare("SELECT * FROM cheques WHERE estado='PENDIENTE' ORDER BY fecha_cobro ASC").all();
}

function getInversoresActivos() {
  return db.prepare("SELECT * FROM inversores WHERE estado='ACTIVO' ORDER BY inversor").all();
}

function calcularDeudaInversor(inv) {
  const dias = Math.floor((Date.now() - new Date(inv.fecha_ingreso)) / 86400000);
  return inv.capital * (1 + inv.tasa * dias / 365);
}

// ── CONTEXTO IA ───────────────────────────────────────────────────────────────
async function buildContexto() {
  const tc         = await getTipoCambio();
  const ultimas    = getUltimasTransacciones(10);
  const cuentas    = getResumenCC();
  const cheques    = getChequesPendientes();
  const inversores = getInversoresActivos();
  const totalDeuda = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);
  const mesActual  = new Date().toISOString().slice(0, 7);
  const egresosMes = db.prepare(`
    SELECT concepto, SUM(egreso) as total FROM transacciones
    WHERE fecha LIKE ? AND egreso > 0 GROUP BY concepto ORDER BY total DESC LIMIT 10
  `).all(`${mesActual}-%`);

  return `Sos el asistente financiero de IMPROLUX, empresa ganadera uruguaya. Español rioplatense, conciso (max 5 lineas).

FECHA HOY: ${new Date().toISOString().slice(0,10)} — SIEMPRE usar esta fecha. Nunca inventar.
MONEDA: TODO EN USD. TC BROU: ${tc ? `$${tc.toFixed(2)} UYU/USD` : "no disponible"}.
Si el usuario menciona pesos → convertir a USD y aclarar.

CATEGORIAS: ${CATEGORIAS.join(", ")}

════════════════════════════════════════
LOGICA CONTABLE — CRITICO:
════════════════════════════════════════
FLUJO DE CAJA (transacciones):
  - Registra el HECHO ECONOMICO REAL: la compra del insumo/combustible/sueldo
  - Compra en CC → registrar_transaccion con es_cc:true + proveedor
  - Compra al contado → registrar_transaccion con es_cc:false
  - Venta de ganado → registrar_transaccion con ingreso > 0, concepto VENTAS

CUENTAS CORRIENTES (cc_movimientos):
  - SALDO CC = total compras (es_cc=1) MENOS total pagos en cc_movimientos
  - Pagar deuda CC (efectivo/cheque/transferencia) → usar pagar_cc
  - pagar_cc NO genera egreso en el flujo de caja. Es cancelacion de deuda interna.
  - El egreso ya existio cuando se compro el insumo.

EJEMPLOS:
  "compre alimento en Mercado Rural en cuenta corriente por $500"
    → registrar_transaccion egreso:500, es_cc:true, proveedor:"MERCADO RURAL"
  "pague $2000 a Mercado Rural con cheque"
    → pagar_cc proveedor:"MERCADO RURAL", monto:2000, medio:"CHEQUE"
  "gaste $100 en nafta al contado"
    → registrar_transaccion egreso:100, es_cc:false

════════════════════════════════════════
HERRAMIENTAS — responder SOLO con JSON exacto, sin texto ni markdown:
════════════════════════════════════════
{"accion":"registrar_transaccion","fecha":"YYYY-MM-DD","concepto":"CATEGORIA","detalle":"descripcion","ingreso":0,"egreso":0,"proveedor":"","es_cc":false,"tc":${tc||0}}
{"accion":"pagar_cc","fecha":"YYYY-MM-DD","proveedor":"nombre","monto":0,"medio":"EFECTIVO|CHEQUE|TRANSFERENCIA","notas":""}
{"accion":"nuevo_proveedor_cc","proveedor":"nombre","notas":""}
{"accion":"nuevo_cheque","fecha_emision":"YYYY-MM-DD","fecha_cobro":"YYYY-MM-DD","tipo":"EMITIDO|RECIBIDO","proveedor":"","monto":0,"banco":"BROU","concepto":""}
{"accion":"marcar_cheque_cobrado","id":0}
{"accion":"nuevo_inversor","inversor":"nombre","capital":0,"tasa":0.08,"notas":""}
{"accion":"nueva_venta","fecha":"YYYY-MM-DD","cantidad":0,"categoria":"","precio_unit":0,"total":0,"gastos_comerciales":0,"notas":""}
{"accion":"borrar_transaccion","id":0}
{"accion":"editar_transaccion","id":0,"concepto":"","detalle":"","egreso":0,"ingreso":0,"proveedor":"","fecha":"YYYY-MM-DD"}
{"accion":"ver_ultimos"}
{"accion":"ver_cc"}
{"accion":"ver_cc_movimientos","proveedor":"nombre"}
{"accion":"ver_cheques"}
{"accion":"ver_inversores"}
{"accion":"ver_ventas"}
{"accion":"resumen_mes","periodo":"YYYY-MM"}
{"accion":"resumen_periodo","fecha_desde":"YYYY-MM-DD","fecha_hasta":"YYYY-MM-DD"}
{"accion":"ver_por_fecha","fecha":"YYYY-MM-DD"}
{"accion":"texto","mensaje":"respuesta en texto"}

════════════════════════════════════════
VOCABULARIO DEL USUARIO:
════════════════════════════════════════
NAFTA/NARFA/NAFRFA → COMBUSTIBLE CAMPO
GASOIL CAMPO/NAFTA CAMPO/GASOIL CHILQUERA/COMBUSTIBLE CHILQUERA → COMBUSTIBLE CAMPO
GASOIL CAMIONETA/GSAOIL CAMIONETA/CAMIONETA GASOIL/VIATICOS → COMBUSTIBLE VIATICOS
PEAJES/COMIDA VIAJE/RECARGA TELEPEAJE → COMBUSTIBLE VIATICOS
PROVISTA/COMIDA/VERDULERIA/SUPERMERCADO/EL DORADO/GARRAFA/COMIDA EDUARDO → PROVISTA
GIRO EDUARDO/PAGO EDUARDO/SUELDO EDUARDO/TRANSFERENCIA EDUARDO/RECARGAS CELULAR EDUARDO/ROPA EDUARDO/BOMBACHAS EDUARDO/LIMA PARA EDUARDO/NAFTA CAMPO (para Eduardo)/ALIMENTO PERROS/CADENA MOTOSIERRA EDUARDO/PAGO EDUARDO PREMIO/TRASNFERENIA EDUARDO/PROVISTA EDUARDO/ENCARGUE COSAS EDUARDO → SUELDO JORNAL
PAGO EDUARDO (encargado) → SUELDO ENCARGADO
PORTERA/PIQUES/TORNILLOS/CLAVOS/AISLADORES/BATERIAS/BULONES MANGA/CANDADOS/LIMA MOTOSIERRA/PAGO LIMPIEZA/MANTENIMIENTO CAMPO → MANTENIMIENTO CAMPO
SERVICIO TRACTOR/ACEITE GRUPO/ACEITE TRACTOR/ARREGLO ZORRA/SERVICIO CUATRI/MANTENIMIENTO MOTO/REPUESTOS MOTO/CAMARA MOTO/ARREGLO CUBIERTAS → MANTENIMIENTO MAQUINARIA
INSUMOS AGRICOLAS/GASOIL CHILQUERA/FERTILIZANTE/SEMILLA/FUMIGACION/SIEMBRA/LABOREO/RAYGRASS → VERDEOS Y PASTURAS
INSUMOS VETERINARIOS/CARAVANAS/PAJUELAS/POUR ON/ECTION/ROBORANTE → INSUMOS VETERINARIOS
FLETE ALIMENTO/ROLLOS/RACION/ALIMENTO RECRIA → ALIMENTACION RECRIA
ALIMENTO TERMINACION/TERMINACION PLUS → TERMINACION
PAGO LAURA TACTO/ECOGRAFIAS/TACTO → TRABAJOS VETERINARIOS
BREEDPLAN/PAGO ARU/CRIADORES ANGUS → GASTOS DATOS Y PEDEGREE
PAGO FLETES/GUIAS/FLETE VACAS/TRASLADO VACAS/FLETE TERNERAS/ENVIO GUIA → TRASLADOS GANADEROS
ENVIO PANTALLAS/PANTALLAS CAMPO/ENVIO CABLES/INVERSOR LUZ → ALQUILER ESTRUCTURA
PAGO ETIENNE/PAGO BINLADEN/GASTOS CONTRATO MARTIN/ALQUILER → ALQUILER
CONTADOR/PAGO CONTADOR/PAGO MARTIN EMPRESA → GASTOS ADM
TELEFONO/TELEFONO CAMPO/TELEFONO JONI/ANTEL/STARLINK/INTERNET CAMPO → TELEFONO
BPS/PAGO BPS → BPS
ADMINISTRATIVOS/COMIDA AGUSTIN/PAGO DAC/ENCOMIENDAS → GASTOS ADM
CUBIERTAS CAMIONETA/LAVADO CAMIONETA/ROTACION/BALANCEO/INFORME CAMIONETA → VEHICULOS
TIJERA/SEÑALADOR/CONTROL REMOTO/DESCONGELADOR → COMPRA HERRAMIENTAS
COCINA A LEÑA/EMBARCADERO/BALANZA/COMEDERO → ESTRUCTURA GANADERA
SUELDO ADM/ROPA ADM → SUELDOS ADM

PROVEEDORES CC (compras en CC → es_cc:true):
  MERCADO RURAL, ZAMBRANO INSUMOS, ZAMBRANO Y CIA, DIEGO PIOLI, SELECTA SRL, INVITRO, AMAKAIK

REGLAS CRITICAS:
  - "compre en [proveedor CC] en cuenta corriente" → registrar_transaccion + es_cc:true + proveedor
  - "pague a [proveedor CC]" → pagar_cc (NO registrar_transaccion)
  - Compra al contado en proveedor CC → registrar_transaccion con es_cc:false
  - Gasto en pesos → convertir a USD con TC, aclarar conversion
  - "borrar/eliminar #ID" → borrar_transaccion
  - "corregir/editar #ID" → editar_transaccion
  - EDUARDO = empleado campo (SUELDO JORNAL). JONI = dueno (GASTOS ADM)
  - Si no entendes → accion:texto y preguntar

DATOS ACTUALES:
Ultimas 10 transacciones: ${JSON.stringify(ultimas.map(t=>({id:t.id,fecha:t.fecha,concepto:t.concepto,detalle:t.detalle,ingreso:t.ingreso,egreso:t.egreso,proveedor:t.proveedor,es_cc:t.es_cc})))}
CCs con saldo: ${JSON.stringify(cuentas.map(c=>({proveedor:c.proveedor,saldo:c.saldo.toFixed(2)})))}
Cheques pendientes: ${JSON.stringify(cheques.map(c=>({id:c.id,tipo:c.tipo,proveedor:c.proveedor,monto:c.monto,vence:c.fecha_cobro})))}
Inversores activos: ${JSON.stringify(inversores.map(i=>({inversor:i.inversor,capital:i.capital,tasa:i.tasa,deuda:calcularDeudaInversor(i).toFixed(2)})))}
Deuda total inversores: $${fmt(totalDeuda)} USD
Egresos mes actual: ${JSON.stringify(egresosMes)}`;
}

// ── EJECUTAR ACCIÓN ───────────────────────────────────────────────────────────
async function ejecutarAccion(accion) {
  const hoy = new Date().toISOString().slice(0, 10);
  const tc  = await getTipoCambio();

  if (accion.accion === "registrar_transaccion") {
    const { concepto, detalle, proveedor } = accion;
    const ingreso = parseFloat(accion.ingreso) || 0;
    const egreso  = parseFloat(accion.egreso)  || 0;
    const es_cc   = accion.es_cc ? 1 : 0;
    if (!concepto) return "❌ Falta el concepto.";
    let fecha = accion.fecha || hoy;
    if (isNaN(new Date(fecha)) || Math.abs(Date.now() - new Date(fecha)) > 365*86400000) fecha = hoy;
    db.prepare(`
      INSERT INTO transacciones (fecha,concepto,detalle,ingreso,egreso,proveedor,es_cc,tc,fuente)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(fecha, concepto, detalle||"", ingreso, egreso, proveedor||"", es_cc, tc||0, "whatsapp");
    const tipo  = ingreso > 0 ? `📥 Ingreso: $${fmt(ingreso)} USD` : `📤 Egreso: $${fmt(egreso)} USD`;
    const ccTag = es_cc ? `\n🔄 CC: ${proveedor}` : "";
    return `✅ Registrado!\n📝 ${detalle||concepto}\n${tipo}\n📁 ${concepto}${ccTag}`;
  }

  if (accion.accion === "pagar_cc") {
    const { proveedor, monto, medio, notas, cheque_id } = accion;
    if (!proveedor || !monto) return "❌ Faltan proveedor y monto.";
    const fecha = accion.fecha || hoy;
    db.prepare(`INSERT INTO cc_movimientos (fecha,proveedor,monto,medio,cheque_id,notas) VALUES (?,?,?,?,?,?)`)
      .run(fecha, proveedor.toUpperCase(), parseFloat(monto), medio||"EFECTIVO", cheque_id||null, notas||"");
    const saldo = getSaldoCC(proveedor);
    return `✅ Pago CC registrado!\n🏪 ${proveedor}\n💰 $${fmt(monto)} USD via ${medio||"EFECTIVO"}\n📊 Saldo pendiente: $${fmt(saldo)} USD`;
  }

  if (accion.accion === "nuevo_proveedor_cc") {
    const { proveedor, notas } = accion;
    if (!proveedor) return "❌ Falta el nombre.";
    try {
      db.prepare("INSERT INTO cuentas_corrientes (proveedor,notas) VALUES (?,?)").run(proveedor.toUpperCase(), notas||"");
      return `✅ Proveedor CC: ${proveedor.toUpperCase()}`;
    } catch(e) {
      return e.message.includes("UNIQUE") ? `⚠️ "${proveedor}" ya existe.` : "❌ Error al crear.";
    }
  }

  if (accion.accion === "nuevo_cheque") {
    const { fecha_emision, fecha_cobro, tipo, proveedor, monto, banco, concepto } = accion;
    if (!monto || !tipo) return "❌ Faltan datos del cheque.";
    const r = db.prepare(`INSERT INTO cheques (fecha_emision,fecha_cobro,tipo,proveedor,monto,estado,banco,concepto) VALUES (?,?,?,?,?,'PENDIENTE',?,?)`)
      .run(fecha_emision||hoy, fecha_cobro||"", tipo, proveedor||"", parseFloat(monto), banco||"BROU", concepto||"");
    const e = tipo==="RECIBIDO" ? "📥" : "📤";
    return `✅ Cheque #${r.lastInsertRowid} registrado!\n${e} ${tipo} · $${fmt(monto)} USD\n🏪 ${proveedor||"Sin proveedor"}\n📅 Vence: ${fecha_cobro||"Sin fecha"}`;
  }

  if (accion.accion === "marcar_cheque_cobrado") {
    const ch = db.prepare("SELECT * FROM cheques WHERE id=?").get(accion.id);
    if (!ch) return "❌ No encontre ese cheque.";
    db.prepare("UPDATE cheques SET estado='COBRADO' WHERE id=?").run(accion.id);
    return `✅ Cheque #${accion.id} cobrado.\n🏪 ${ch.proveedor} · $${fmt(ch.monto)} USD`;
  }

  if (accion.accion === "nuevo_inversor") {
    const { inversor, capital, tasa, notas } = accion;
    if (!inversor || !capital) return "❌ Faltan datos.";
    db.prepare(`INSERT INTO inversores (inversor,fecha_ingreso,capital,tasa,estado,notas) VALUES (?,?,?,?,'ACTIVO',?)`)
      .run(inversor, hoy, parseFloat(capital), parseFloat(tasa)||0.08, notas||"");
    return `✅ Inversor: ${inversor}\n💰 $${fmt(capital)} USD · ${((parseFloat(tasa)||0.08)*100).toFixed(1)}% anual`;
  }

  if (accion.accion === "nueva_venta") {
    const { fecha, cantidad, categoria, precio_unit, total, gastos_comerciales, notas } = accion;
    if (!total) return "❌ Falta el total.";
    const r = db.prepare(`INSERT INTO ventas (fecha,cantidad,categoria,precio_unit,total,gastos_comerciales,notas) VALUES (?,?,?,?,?,?,?)`)
      .run(fecha||hoy, cantidad||0, categoria||"", parseFloat(precio_unit)||0, parseFloat(total), parseFloat(gastos_comerciales)||0, notas||"");
    db.prepare(`INSERT INTO transacciones (fecha,concepto,detalle,ingreso,egreso,proveedor,es_cc,tc,fuente) VALUES (?,?,?,?,0,'',0,?,?)`)
      .run(fecha||hoy, "VENTAS", `Venta ${cantidad||""} ${categoria||""}`.trim(), parseFloat(total), tc||0, "whatsapp");
    return `✅ Venta #${r.lastInsertRowid}!\n🐄 ${cantidad||""} ${categoria}\n💰 $${fmt(total)} USD\n📊 Gastos: $${fmt(gastos_comerciales||0)} USD`;
  }

  if (accion.accion === "borrar_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id=?").get(accion.id);
    if (!t) return "❌ No encontre esa transaccion.";
    db.prepare("DELETE FROM transacciones WHERE id=?").run(accion.id);
    return `🗑️ Eliminado #${accion.id}\n📝 ${t.detalle||t.concepto}\n💰 ${t.egreso>0?`-$${fmt(t.egreso)}`:`+$${fmt(t.ingreso)}`} USD`;
  }

  if (accion.accion === "editar_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id=?").get(accion.id);
    if (!t) return "❌ No encontre esa transaccion.";
    const campos = {};
    if (accion.concepto)               campos.concepto  = accion.concepto;
    if (accion.detalle)                campos.detalle   = accion.detalle;
    if (accion.egreso  !== undefined)  campos.egreso    = parseFloat(accion.egreso);
    if (accion.ingreso !== undefined)  campos.ingreso   = parseFloat(accion.ingreso);
    if (accion.proveedor !== undefined) campos.proveedor = accion.proveedor;
    if (accion.fecha)                  campos.fecha     = accion.fecha;
    if (!Object.keys(campos).length) return "❌ Nada para editar.";
    const sets = Object.keys(campos).map(k=>`${k}=?`).join(",");
    db.prepare(`UPDATE transacciones SET ${sets} WHERE id=?`).run(...Object.values(campos), accion.id);
    return `✅ Transaccion #${accion.id} actualizada!`;
  }

  if (accion.accion === "ver_ultimos") {
    const rows = getUltimasTransacciones(8);
    if (!rows.length) return "📋 No hay transacciones.";
    const lineas = rows.map((t,i)=>
      `${i+1}. [#${t.id}] ${t.fecha} · ${t.concepto}${t.es_cc?" [CC]":""} · ${t.egreso>0?`-$${fmt(t.egreso)}`:`+$${fmt(t.ingreso)}`} USD${t.proveedor?` · ${t.proveedor}`:""}`
    ).join("\n");
    return `📋 *Ultimas transacciones:*\n\n${lineas}`;
  }

  if (accion.accion === "ver_cc") {
    const ccs = getResumenCC();
    if (!ccs.length) return "✅ Todas las CCs al dia (saldo cero).";
    const lineas = ccs.map(c=>
      `${c.saldo>0?"🔴":"🟢"} ${c.proveedor}: $${fmt(Math.abs(c.saldo))} ${c.saldo>0?"(debemos)":"(a favor)"}`
    ).join("\n");
    return `🔄 *Cuentas Corrientes:*\n\n${lineas}\n\n💳 Total adeudado: $${fmt(ccs.reduce((s,c)=>s+c.saldo,0))} USD`;
  }

  if (accion.accion === "ver_cc_movimientos") {
    const prov = accion.proveedor;
    if (!prov) return "❌ Falta el proveedor.";
    const compras = db.prepare(`SELECT fecha,concepto,detalle,egreso FROM transacciones WHERE LOWER(proveedor)=LOWER(?) AND es_cc=1 ORDER BY fecha DESC LIMIT 10`).all(prov);
    const pagos   = db.prepare(`SELECT fecha,monto,medio FROM cc_movimientos WHERE LOWER(proveedor)=LOWER(?) ORDER BY fecha DESC LIMIT 10`).all(prov);
    const saldo   = getSaldoCC(prov);
    let msg = `📊 *CC: ${prov.toUpperCase()}*\nSaldo: $${fmt(saldo)} USD\n`;
    if (compras.length) msg += `\n📤 Compras:\n` + compras.map(c=>`  ${c.fecha} ${c.detalle||c.concepto} -$${fmt(c.egreso)}`).join("\n");
    if (pagos.length)   msg += `\n\n💰 Pagos:\n`  + pagos.map(p=>`  ${p.fecha} $${fmt(p.monto)} (${p.medio})`).join("\n");
    return msg;
  }

  if (accion.accion === "ver_cheques") {
    const rows = getChequesPendientes();
    if (!rows.length) return "✅ Sin cheques pendientes.";
    const lineas = rows.map(c=>`${c.tipo==="EMITIDO"?"📤":"📥"} [#${c.id}] ${c.proveedor||"Sin prov."} · $${fmt(c.monto)} · vence ${c.fecha_cobro||"sin fecha"}`).join("\n");
    return `🏦 *Cheques pendientes:*\n\n${lineas}\n\n💳 Total: $${fmt(rows.reduce((s,c)=>s+c.monto,0))} USD`;
  }

  if (accion.accion === "ver_inversores") {
    const rows = getInversoresActivos();
    if (!rows.length) return "📋 Sin inversores activos.";
    const lineas = rows.map(i=>`👤 ${i.inversor}\n   Capital: $${fmt(i.capital)} · Tasa: ${(i.tasa*100).toFixed(1)}%\n   Deuda: $${fmt(calcularDeudaInversor(i))} USD`).join("\n\n");
    return `👥 *Inversores:*\n\n${lineas}\n\n💳 Total: $${fmt(rows.reduce((s,i)=>s+calcularDeudaInversor(i),0))} USD`;
  }

  if (accion.accion === "ver_ventas") {
    const rows = db.prepare("SELECT * FROM ventas ORDER BY fecha DESC LIMIT 10").all();
    if (!rows.length) return "📋 Sin ventas registradas.";
    const lineas = rows.map(v=>`[#${v.id}] ${v.fecha} · ${v.cantidad||""} ${v.categoria} · $${fmt(v.total)} USD`).join("\n");
    return `🐄 *Ventas:*\n\n${lineas}\n\n💰 Total: $${fmt(rows.reduce((s,v)=>s+v.total,0))} USD`;
  }

  if (accion.accion === "resumen_mes") {
    const periodo = accion.periodo || new Date().toISOString().slice(0,7);
    const rows = db.prepare(`SELECT concepto, SUM(egreso) as te, SUM(ingreso) as ti FROM transacciones WHERE fecha LIKE ? GROUP BY concepto ORDER BY te DESC`).all(`${periodo}-%`);
    if (!rows.length) return `📊 Sin movimientos en ${periodo}.`;
    const te = rows.reduce((s,r)=>s+(r.te||0),0);
    const ti = rows.reduce((s,r)=>s+(r.ti||0),0);
    const lineas = rows.filter(r=>r.te>0).map(r=>`  • ${r.concepto}: $${fmt(r.te)}`).join("\n");
    return `📊 *Resumen ${periodo}*\n\n${lineas||"Sin egresos"}\n\n📤 Egresos: $${fmt(te)}\n📥 Ingresos: $${fmt(ti)}\n💰 Neto: $${fmt(ti-te)} USD`;
  }

  if (accion.accion === "resumen_periodo") {
    const { fecha_desde, fecha_hasta } = accion;
    if (!fecha_desde || !fecha_hasta) return "❌ Necesito fecha_desde y fecha_hasta.";
    const rows = db.prepare(`SELECT concepto, SUM(egreso) as te, SUM(ingreso) as ti FROM transacciones WHERE fecha BETWEEN ? AND ? GROUP BY concepto ORDER BY te DESC`).all(fecha_desde, fecha_hasta);
    if (!rows.length) return `📊 Sin movimientos entre ${fecha_desde} y ${fecha_hasta}.`;
    const te = rows.reduce((s,r)=>s+(r.te||0),0);
    const ti = rows.reduce((s,r)=>s+(r.ti||0),0);
    const lineas = rows.filter(r=>r.te>0).map(r=>`  • ${r.concepto}: $${fmt(r.te)}`).join("\n");
    return `📊 *${fecha_desde} → ${fecha_hasta}*\n\n${lineas||"Sin egresos"}\n\n📤 Egresos: $${fmt(te)}\n📥 Ingresos: $${fmt(ti)} USD`;
  }

  if (accion.accion === "ver_por_fecha") {
    const { fecha } = accion;
    if (!fecha) return "❌ Necesito una fecha.";
    const rows = db.prepare("SELECT * FROM transacciones WHERE fecha=? ORDER BY created_at ASC").all(fecha);
    if (!rows.length) return `📋 Sin movimientos el ${fecha}.`;
    const lineas = rows.map((t,i)=>`${i+1}. [#${t.id}] ${t.concepto}${t.es_cc?" [CC]":""} · ${t.detalle} · ${t.egreso>0?`-$${fmt(t.egreso)}`:`+$${fmt(t.ingreso)}`} USD`).join("\n");
    const neto = rows.reduce((s,t)=>s+t.egreso-t.ingreso,0);
    return `📋 *${fecha}:*\n\n${lineas}\n\n💰 Neto: ${neto>=0?"-":""}$${fmt(Math.abs(neto))} USD`;
  }

  if (accion.accion === "texto") return accion.mensaje;
  return "❓ No entendi. Intenta de nuevo.";
}

// ── PROCESADOR COMPARTIDO ─────────────────────────────────────────────────────
async function procesarMensaje(body) {
  const usuario  = "improlux";
  const historial = getHistorial(usuario);
  historial.push({ role: "user", content: body });
  const contexto = await buildContexto();
  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system: contexto,
    messages: historial,
  });
  const raw = result.content[0].text.trim();
  historial.push({ role: "assistant", content: raw });
  saveHistorial(usuario, historial);
  const limpio = raw.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  try {
    const match  = limpio.match(/\{[\s\S]*"accion"[\s\S]*\}/);
    const accion = JSON.parse(match ? match[0] : limpio);
    if (accion?.accion) return await ejecutarAccion(accion);
    return limpio;
  } catch(_) { return limpio; }
}

// ── WEBHOOKS ──────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    twiml.message(await procesarMensaje((req.body.Body || "").trim()));
  } catch(err) {
    console.error("Error webhook:", err);
    twiml.message("❌ Error. Intenta de nuevo.");
  }
  res.type("text/xml").send(twiml.toString());
});

app.post("/webhook-interno", async (req, res) => {
  try {
    res.json({ respuesta: await procesarMensaje((req.body.Body || "").trim()) });
  } catch(err) {
    console.error("Error webhook-interno:", err);
    res.json({ respuesta: "❌ Error interno." });
  }
});

// ── API REST ──────────────────────────────────────────────────────────────────
app.get("/api/transacciones", (req, res) => {
  const limite = parseInt(req.query.limite) || 200;
  const desde  = req.query.desde || "";
  const hasta  = req.query.hasta || "";
  let q = "SELECT * FROM transacciones", params = [];
  if (desde && hasta) { q += " WHERE fecha BETWEEN ? AND ?"; params.push(desde, hasta); }
  q += " ORDER BY fecha DESC, created_at DESC LIMIT ?";
  params.push(limite);
  res.json(db.prepare(q).all(...params));
});

app.get("/api/cuentas", (req, res) => {
  res.json(db.prepare("SELECT * FROM cuentas_corrientes ORDER BY proveedor").all()
    .map(c => ({ ...c, saldo: getSaldoCC(c.proveedor) })));
});

app.get("/api/cc_movimientos", (req, res) => {
  const prov = req.query.proveedor;
  if (prov) res.json(db.prepare("SELECT * FROM cc_movimientos WHERE LOWER(proveedor)=LOWER(?) ORDER BY fecha DESC").all(prov));
  else      res.json(db.prepare("SELECT * FROM cc_movimientos ORDER BY fecha DESC LIMIT 100").all());
});

app.get("/api/cheques",    (req, res) => res.json(db.prepare("SELECT * FROM cheques ORDER BY fecha_cobro ASC").all()));
app.get("/api/ventas",     (req, res) => res.json(db.prepare("SELECT * FROM ventas ORDER BY fecha DESC").all()));
app.get("/api/inversores", (req, res) => res.json(
  db.prepare("SELECT * FROM inversores ORDER BY inversor").all()
    .map(i => ({ ...i, deuda_calculada: calcularDeudaInversor(i) }))
));

app.get("/api/tc", async (req, res) => {
  res.json({ tc: await getTipoCambio(), fecha: new Date().toISOString().slice(0,10) });
});

app.get("/api/resumen", (req, res) => {
  const mes = new Date().toISOString().slice(0,7);
  const em  = db.prepare("SELECT COALESCE(SUM(egreso),0) as t  FROM transacciones WHERE fecha LIKE ?").get(`${mes}-%`);
  const im  = db.prepare("SELECT COALESCE(SUM(ingreso),0) as t FROM transacciones WHERE fecha LIKE ?").get(`${mes}-%`);
  const chp = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(monto),0) as m FROM cheques WHERE estado='PENDIENTE'").get();
  const inv = getInversoresActivos();
  const tot = db.prepare("SELECT COUNT(*) as n FROM transacciones").get();
  const tcc = db.prepare("SELECT COALESCE(SUM(egreso),0) as t FROM transacciones WHERE es_cc=1").get();
  const tpg = db.prepare("SELECT COALESCE(SUM(monto),0)  as t FROM cc_movimientos").get();
  res.json({
    egresos_mes:        em.t,
    ingresos_mes:       im.t,
    cheques_pendientes: chp.n,
    monto_cheques:      chp.m,
    deuda_inversores:   inv.reduce((s,i)=>s+calcularDeudaInversor(i),0),
    total_movimientos:  tot.n,
    deuda_cc_total:     tcc.t - tpg.t,
  });
});

app.post("/api/importar", (req, res) => {
  const { transacciones } = req.body;
  if (!Array.isArray(transacciones)) return res.status(400).json({ error: "Formato invalido" });
  let ok = 0, errores = 0;
  const stmt = db.prepare(`INSERT INTO transacciones (fecha,concepto,detalle,ingreso,egreso,proveedor,es_cc,tc,fuente) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const t of transacciones) {
    try {
      stmt.run(
        t.fecha    || new Date().toISOString().slice(0,10),
        t.concepto || "OTROS",
        t.detalle  || "",
        parseFloat(t.ingreso) || 0,
        parseFloat(t.egreso)  || 0,
        t.proveedor || "",
        t.es_cc ? 1 : 0,
        t.tc    || null,
        t.fuente || "historico"
      );
      ok++;
    } catch(e) { errores++; }
  }
  res.json({ ok, errores, total: transacciones.length });
});

app.post("/api/importar_cc", (req, res) => {
  const { movimientos } = req.body;
  if (!Array.isArray(movimientos)) return res.status(400).json({ error: "Formato invalido" });
  let ok = 0, errores = 0;
  const stmt = db.prepare("INSERT INTO cc_movimientos (fecha,proveedor,monto,medio,notas) VALUES (?,?,?,?,?)");
  for (const m of movimientos) {
    try { stmt.run(m.fecha, m.proveedor, parseFloat(m.monto), m.medio||"EFECTIVO", m.notas||""); ok++; }
    catch(e) { errores++; }
  }
  res.json({ ok, errores, total: movimientos.length });
});

app.get("/", (req, res) => res.json({ status: "IMPROLUX Bot 🟢", version: "4.0" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IMPROLUX v4.0 en puerto ${PORT}`));

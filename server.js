const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const Database = require("better-sqlite3");
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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

  CREATE TABLE IF NOT EXISTS cc_movimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    proveedor TEXT NOT NULL,
    monto REAL NOT NULL,
    medio TEXT DEFAULT 'EFECTIVO',
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS presupuestos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ciclo TEXT NOT NULL,
    concepto TEXT NOT NULL,
    monto_anual REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ciclo, concepto)
  );

  CREATE TABLE IF NOT EXISTS dividendos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    socio TEXT NOT NULL,
    monto REAL NOT NULL,
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    hectareas REAL,
    ha_sembrables REAL,
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS laboreos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lote TEXT NOT NULL,
    tipo TEXT NOT NULL,
    descripcion TEXT,
    ciclo TEXT NOT NULL,
    estado TEXT DEFAULT 'PLANIFICADO',
    fecha_ejecucion TEXT,
    total_presupuestado REAL DEFAULT 0,
    total_ejecutado REAL DEFAULT 0,
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS laboreo_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    laboreo_id INTEGER NOT NULL,
    categoria TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    cantidad REAL DEFAULT 0,
    unidad TEXT DEFAULT 'ha',
    precio_unitario REAL DEFAULT 0,
    total REAL DEFAULT 0,
    ejecutado INTEGER DEFAULT 0,
    fecha_ejecucion TEXT,
    notas_ejecucion TEXT,
    FOREIGN KEY(laboreo_id) REFERENCES laboreos(id)
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
// Inicializar lotes de La Amistad si no existen
const lotesIniciales = [
  { nombre: 'EUCALIPTUS', hectareas: 11.90, ha_sembrables: 11.90 },
  { nombre: 'SAUZAL CHICO', hectareas: 5.51, ha_sembrables: 4.50 },
  { nombre: 'SAUZAL GRANDE', hectareas: 4.99, ha_sembrables: 4.99 },
  { nombre: 'BAÑADO', hectareas: 3.74, ha_sembrables: 0 },
  { nombre: 'ZARZO', hectareas: 10.20, ha_sembrables: 0 },
  { nombre: 'CORONILLAS', hectareas: 2.68, ha_sembrables: 2.00 },
  { nombre: 'VALLE 3', hectareas: 4.00, ha_sembrables: 4.00 },
  { nombre: 'VALLE 2', hectareas: 7.11, ha_sembrables: 5.10 },
  { nombre: 'VALLE 1', hectareas: 9.00, ha_sembrables: 5.56 },
  { nombre: 'TREPADA', hectareas: 8.34, ha_sembrables: 2.29 },
  { nombre: 'CORRAL 1', hectareas: 0.70, ha_sembrables: 0.50 },
  { nombre: 'CORRAL 2', hectareas: 1.00, ha_sembrables: 0.50 },
  { nombre: 'CERRO', hectareas: 12.30, ha_sembrables: 2.00 },
];
const stmtLote = db.prepare('INSERT OR IGNORE INTO lotes (nombre, hectareas, ha_sembrables) VALUES (?,?,?)');
lotesIniciales.forEach(l => stmtLote.run(l.nombre, l.hectareas, l.ha_sembrables));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic();
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
  // Compras = egresos registrados con ese proveedor (excluye pagos CC)
  const compras = db.prepare(`
    SELECT COALESCE(SUM(egreso), 0) as total
    FROM transacciones
    WHERE LOWER(proveedor) = LOWER(?)
    AND concepto != 'PAGO CUENTA CORRIENTE'
  `).get(proveedor);
  // Pagos = lo registrado en cc_movimientos
  const pagos = db.prepare(`
    SELECT COALESCE(SUM(monto), 0) as total
    FROM cc_movimientos
    WHERE LOWER(proveedor) = LOWER(?)
  `).get(proveedor);
  return (compras.total || 0) - (pagos.total || 0);
}

function getDetalleCuentaCorriente(proveedor) {
  const compras = db.prepare(`
    SELECT fecha, concepto, detalle, egreso as monto, 'COMPRA' as tipo, created_at
    FROM transacciones
    WHERE LOWER(proveedor) = LOWER(?)
    AND concepto != 'PAGO CUENTA CORRIENTE'
    AND egreso > 0
    ORDER BY fecha ASC, created_at ASC
  `).all(proveedor);
  const pagos = db.prepare(`
    SELECT fecha, 'PAGO' as concepto, COALESCE(notas, medio) as detalle, monto, 'PAGO' as tipo, created_at
    FROM cc_movimientos
    WHERE LOWER(proveedor) = LOWER(?)
    ORDER BY fecha ASC, created_at ASC
  `).all(proveedor);
  // Combinar y ordenar por fecha
  const todos = [...compras.map(c => ({...c, signo: -1})), ...pagos.map(p => ({...p, signo: 1}))]
    .sort((a,b) => a.fecha.localeCompare(b.fecha) || a.created_at.localeCompare(b.created_at));
  // Calcular saldo acumulado
  let saldoAcum = 0;
  return todos.map(t => {
    saldoAcum += t.tipo === 'COMPRA' ? t.monto : -t.monto;
    return { ...t, saldo_acumulado: saldoAcum };
  });
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
    if (PUBLIC_URL) {
      msg += `\n\n📄 PDF detallado: ${PUBLIC_URL}/api/informe-mensual-pdf?anio=${anio}&mes=${mes}`;
    }
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
{"accion":"ver_cc_detalle","proveedor":"nombre"}
{"accion":"nuevo_laboreo","lote":"NOMBRE LOTE","tipo":"PRADERA o VERDEO","descripcion":"","ciclo":"25/26","notas":""}
{"accion":"agregar_item_laboreo","laboreo_id":0,"categoria":"INSUMO o SERVICIO","descripcion":"nombre","cantidad":0,"unidad":"ha o kg o lt","precio_unitario":0}
{"accion":"ver_laboreos","lote":"","ciclo":""}
{"accion":"ver_laboreo","id":0}
{"accion":"ejecutar_laboreo","id":0}
{"accion":"ver_cheques"}
{"accion":"ver_inversores"}
{"accion":"registrar_dividendo","socio":"PABLO MASNATTA o JONATAN D ASTOLFO","monto":0,"fecha":"YYYY-MM-DD","notas":""}
{"accion":"ver_dividendos"}
{"accion":"resumen_mes"}
{"accion":"resumen_periodo","fecha_desde":"YYYY-MM-DD","fecha_hasta":"YYYY-MM-DD"}
{"accion":"ver_por_fecha","fecha":"YYYY-MM-DD"}
{"accion":"informe_ciclo","ciclo":"25/26"}
{"accion":"set_presupuesto","ciclo":"25/26","concepto":"CATEGORIA","monto_anual":0}
{"accion":"ver_presupuestos","ciclo":"25/26"}
{"accion":"informe_mensual","anio":2026,"mes":3}
{"accion":"informe_pdf","ciclo":"25/26"}
{"accion":"informe_mensual_pdf","anio":2026,"mes":3}
{"accion":"backup","tipo":"transacciones"}
{"accion":"backup","tipo":"completo"}
{"accion":"texto","mensaje":"respuesta en texto"}

CICLOS GANADEROS:
- El ciclo va de MARZO a FEBRERO del año siguiente
- "ciclo 25/26" = marzo 2025 → febrero 2026
- "ciclo 26/27" = marzo 2026 → febrero 2027
- Si piden "informe anual" sin especificar → usar ciclo actual
- "presupuesto nafta 500" → set_presupuesto con ciclo actual y la categoría correcta
- "informe pdf", "pdf anual", "generar informe anual" → usar informe_pdf con el ciclo correspondiente
- "informe pdf marzo", "pdf de marzo", "informe mensual pdf" → usar informe_mensual_pdf con mes y año
- "backup", "respaldo", "descargar datos" → usar backup tipo transacciones
- "backup completo", "respaldo total" → usar backup tipo completo

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
RETIRO PABLO/DIVIDENDO PABLO/PAGO PABLO → registrar_dividendo socio:PABLO MASNATTA
RETIRO JONI/DIVIDENDO JONI/RETIRO JONATAN/PAGO JONI → registrar_dividendo socio:JONATAN D ASTOLFO
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

// ── HELPERS LABOREOS ─────────────────────────────────────────────────────────
function calcularTotalLaboreo(laboreoId) {
  const items = db.prepare("SELECT SUM(total) as total FROM laboreo_items WHERE laboreo_id = ?").get(laboreoId);
  return items?.total || 0;
}

function getLaboreoDetalle(laboreoId) {
  const lab = db.prepare("SELECT * FROM laboreos WHERE id = ?").get(laboreoId);
  if (!lab) return null;
  const items = db.prepare("SELECT * FROM laboreo_items WHERE laboreo_id = ? ORDER BY categoria, ejecutado, id").all(laboreoId);
  const lote = db.prepare("SELECT * FROM lotes WHERE nombre = ?").get(lab.lote);
  const totalEjec = items.filter(i=>i.ejecutado).reduce((s,i)=>s+i.total,0);
  const pctAvance = items.length > 0 ? Math.round(items.filter(i=>i.ejecutado).length / items.length * 100) : 0;
  return { ...lab, items, lote, totalEjec, pctAvance };
}

function recalcularTotalLaboreo(laboreoId) {
  const total = calcularTotalLaboreo(laboreoId);
  const ejecutado = db.prepare("SELECT COALESCE(SUM(total),0) as t FROM laboreo_items WHERE laboreo_id=? AND ejecutado=1").get(laboreoId).t || 0;
  const countTotal = db.prepare("SELECT COUNT(*) as c FROM laboreo_items WHERE laboreo_id=?").get(laboreoId).c;
  const countEjec = db.prepare("SELECT COUNT(*) as c FROM laboreo_items WHERE laboreo_id=? AND ejecutado=1").get(laboreoId).c;
  // Auto-update laboreo estado
  let estado = 'PLANIFICADO';
  if (countEjec > 0 && countEjec < countTotal) estado = 'EN EJECUCION';
  if (countTotal > 0 && countEjec === countTotal) estado = 'EJECUTADO';
  db.prepare("UPDATE laboreos SET total_presupuestado=?, total_ejecutado=?, estado=? WHERE id=?").run(total, ejecutado, estado, laboreoId);
  return { total, ejecutado, estado };
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
    const { proveedor, monto, fecha, medio, notas } = accion;
    if (!proveedor || !monto) return "❌ Faltan datos para registrar el pago.";

    // Registrar en cc_movimientos — NO afecta flujo de caja
    db.prepare(`
      INSERT INTO cc_movimientos (fecha, proveedor, monto, medio, notas)
      VALUES (?, ?, ?, ?, ?)
    `).run(fecha || hoy, proveedor, parseFloat(monto), medio || 'EFECTIVO', notas || `Pago a ${proveedor}`);

    const saldoNuevo = getSaldoProveedor(proveedor);
    return `✅ Pago CC registrado!\n🏪 ${proveedor}\n💰 $${fmt(monto)} USD\n📊 Saldo pendiente: $${fmt(saldoNuevo)} USD\n💡 No afecta el flujo de caja`;
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
  if (accion.accion === "ver_cc_detalle") {
    const { proveedor } = accion;
    if (!proveedor) return "❌ Necesito el nombre del proveedor.";
    const detalle = getDetalleCuentaCorriente(proveedor);
    if (!detalle.length) return `📋 No hay movimientos para ${proveedor}.`;
    const saldo = getSaldoProveedor(proveedor);
    const lineas = detalle.slice(-15).map(t => {
      const emoji = t.tipo === 'COMPRA' ? '📤' : '💳';
      return `${emoji} ${t.fecha} · ${t.detalle||t.concepto} · $${fmt(t.monto)} · Saldo: $${fmt(t.saldo_acumulado)}`;
    }).join("\n");
    return `📊 *CC ${proveedor}*\n\n${lineas}\n\n💰 Saldo actual: $${fmt(saldo)} USD`;
  }

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

  // REGISTRAR DIVIDENDO
  if (accion.accion === "registrar_dividendo") {
    const { socio, monto, fecha, notas } = accion;
    if (!socio || !monto) return "❌ Falta socio o monto.";
    const socios = ['PABLO MASNATTA', 'JONATAN D ASTOLFO'];
    const socioNorm = socios.find(s => s.toLowerCase().includes((socio||'').toLowerCase().split(' ')[0])) || socio.toUpperCase();
    db.prepare(`INSERT INTO dividendos (fecha, socio, monto, notas) VALUES (?, ?, ?, ?)`)
      .run(fecha || hoy, socioNorm, parseFloat(monto), notas || '');
    // También registrar como egreso en transacciones para el flujo de caja
    db.prepare(`INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc, tc, fuente) VALUES (?, 'DIVIDENDOS', ?, 0, ?, ?, 0, ?, 'whatsapp')`)
      .run(fecha || hoy, `Retiro ${socioNorm}`, parseFloat(monto), socioNorm, tc || 0);
    const totalSocio = db.prepare(`SELECT COALESCE(SUM(monto),0) as total FROM dividendos WHERE LOWER(socio) LIKE LOWER(?)`).get('%' + (socio.split(' ')[0]) + '%').total;
    return `✅ Dividendo registrado!\n👤 ${socioNorm}\n💰 $${fmt(monto)} USD\n📊 Total retirado por ${socioNorm.split(' ')[0]}: $${fmt(totalSocio)} USD`;
  }

  // VER DIVIDENDOS
  if (accion.accion === "ver_dividendos") {
    const pablo = db.prepare(`SELECT COALESCE(SUM(monto),0) as total FROM dividendos WHERE LOWER(socio) LIKE '%pablo%'`).get().total;
    const joni  = db.prepare(`SELECT COALESCE(SUM(monto),0) as total FROM dividendos WHERE LOWER(socio) LIKE '%jonatan%' OR LOWER(socio) LIKE '%astolfo%'`).get().total;
    const ultimos = db.prepare(`SELECT * FROM dividendos ORDER BY fecha DESC LIMIT 10`).all();
    const lineas = ultimos.map(d => `  ${d.fecha} · ${d.socio.split(' ')[0]} · $${fmt(d.monto)}`).join('\n');
    return `💰 *Dividendos / Retiros*\n\n👤 Pablo Masnatta: $${fmt(pablo)} USD\n👤 Jonatan D Astolfo: $${fmt(joni)} USD\n📊 Total: $${fmt(pablo + joni)} USD\n\n*Últimos retiros:*\n${lineas || 'Sin retiros registrados'}`;
  }

  // ── NUEVO LABOREO ──
  if (accion.accion === "nuevo_laboreo") {
    const { lote, tipo, descripcion, ciclo, notas } = accion;
    if (!lote || !tipo) return "❌ Necesito lote y tipo de laboreo.";
    const cicloActual = (() => { const n=new Date(); const y=n.getMonth()>=2?n.getFullYear():n.getFullYear()-1; return `${String(y).slice(2)}/${String(y+1).slice(2)}`; })();
    const result = db.prepare(`
      INSERT INTO laboreos (lote, tipo, descripcion, ciclo, estado, notas)
      VALUES (?, ?, ?, ?, 'PLANIFICADO', ?)
    `).run(lote.toUpperCase(), tipo.toUpperCase(), descripcion||'', ciclo||cicloActual, notas||'');
    return `✅ Laboreo creado! (ID: ${result.lastInsertRowid})\n📍 Lote: ${lote.toUpperCase()}\n🌱 Tipo: ${tipo.toUpperCase()}\n📋 Estado: PLANIFICADO\n\nAhora podés agregar items con: "agregar item #${result.lastInsertRowid}"`;
  }

  // ── AGREGAR ITEM A LABOREO ──
  if (accion.accion === "agregar_item_laboreo") {
    const { laboreo_id, categoria, descripcion, cantidad, unidad, precio_unitario } = accion;
    if (!laboreo_id || !descripcion) return "❌ Faltan datos del item.";
    const total = (parseFloat(cantidad)||0) * (parseFloat(precio_unitario)||0);
    db.prepare(`
      INSERT INTO laboreo_items (laboreo_id, categoria, descripcion, cantidad, unidad, precio_unitario, total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(laboreo_id, categoria||'INSUMO', descripcion, parseFloat(cantidad)||0, unidad||'ha', parseFloat(precio_unitario)||0, total);
    const totalLab = recalcularTotalLaboreo(laboreo_id);
    return `✅ Item agregado!\n📝 ${descripcion}\n💰 ${fmt(cantidad||0)} ${unidad||'ha'} × $${fmt(precio_unitario||0)} = $${fmt(total)} USD\n📊 Total laboreo: $${fmt(totalLab)} USD`;
  }

  // ── VER LABOREOS ──
  if (accion.accion === "ver_laboreos") {
    const { lote, ciclo } = accion;
    let query = "SELECT l.*, lt.hectareas, lt.ha_sembrables FROM laboreos l LEFT JOIN lotes lt ON lt.nombre = l.lote WHERE 1=1";
    const params = [];
    if (lote) { query += " AND LOWER(l.lote) LIKE ?"; params.push('%'+lote.toLowerCase()+'%'); }
    if (ciclo) { query += " AND l.ciclo = ?"; params.push(ciclo); }
    query += " ORDER BY l.created_at DESC LIMIT 10";
    const labs = db.prepare(query).all(...params);
    if (!labs.length) return "📋 No hay laboreos registrados.";
    const lineas = labs.map(l => `🌱 [#${l.id}] ${l.lote} · ${l.tipo} · ${l.ciclo}\n   ${l.estado} · $${fmt(l.total_presupuestado)} USD`).join("\n");
    return `🌱 *Laboreos:*\n\n${lineas}`;
  }

  // ── VER DETALLE LABOREO ──
  if (accion.accion === "ver_laboreo") {
    const det = getLaboreoDetalle(accion.id);
    if (!det) return "❌ No encontré ese laboreo.";
    const hasSembrables = det.lote?.ha_sembrables;
    const costoPorHa = hasSembrables ? (det.total_presupuestado / det.lote.ha_sembrables) : null;
    const itemsLineas = det.items.map(i =>
      `  • ${i.descripcion}: ${i.cantidad} ${i.unidad} × $${fmt(i.precio_unitario)} = $${fmt(i.total)}`
    ).join("\n");
    return `🌱 *Laboreo #${det.id} — ${det.lote} · ${det.tipo}*\n` +
      `📅 Ciclo: ${det.ciclo} · Estado: ${det.estado}\n\n` +
      `*Items:*\n${itemsLineas||'Sin items'}\n\n` +
      `💰 Total: $${fmt(det.total_presupuestado)} USD` +
      (costoPorHa ? `\n📐 Costo/ha: $${fmt(costoPorHa)} USD` : '');
  }

  // ── CAMBIAR ESTADO LABOREO ──
  if (accion.accion === "ejecutar_laboreo") {
    const lab = db.prepare("SELECT * FROM laboreos WHERE id = ?").get(accion.id);
    if (!lab) return "❌ No encontré ese laboreo.";
    db.prepare("UPDATE laboreos SET estado = 'EJECUTADO', fecha_ejecucion = ? WHERE id = ?").run(hoy, accion.id);
    return `✅ Laboreo #${accion.id} marcado como EJECUTADO!\n📍 ${lab.lote} · ${lab.tipo}\n💰 Presupuestado: $${fmt(lab.total_presupuestado)} USD`;
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

  // INFORME PDF (devuelve link)
  if (accion.accion === "informe_pdf") {
    const cicloStr = accion.ciclo || getCicloActual().ciclo;
    const ciclo = parseCiclo(cicloStr);
    if (!ciclo) return "❌ Ciclo inválido. Usá formato 25/26.";
    const url = `${PUBLIC_URL}/api/informe-pdf?ciclo=${encodeURIComponent(cicloStr)}`;
    return `📄 *Informe PDF — Ciclo ${ciclo.label}*\n\n📥 Descargá tu informe acá:\n${url}\n\nIncluye: desglose por categoría, evolución mensual, cuentas corrientes, cheques e inversores.`;
  }

  // INFORME MENSUAL PDF (devuelve link)
  if (accion.accion === "informe_mensual_pdf") {
    const meses = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
    const anio = accion.anio || new Date().getFullYear();
    const mes = accion.mes || new Date().getMonth() + 1;
    const url = `${PUBLIC_URL}/api/informe-mensual-pdf?anio=${anio}&mes=${mes}`;
    return `📄 *Informe PDF — ${meses[mes]} ${anio}*\n\n📥 Descargá tu informe acá:\n${url}\n\nIncluye: gastos por categoría con presupuesto y totales.`;
  }

  // BACKUP CSV
  if (accion.accion === "backup") {
    const tipo = accion.tipo || "transacciones";
    if (tipo === "completo") {
      const url = `${PUBLIC_URL}/api/backup-completo`;
      return `💾 *Backup completo generado!*\n\n📥 Descargá acá:\n${url}\n\nIncluye: transacciones, cuentas corrientes, cheques, inversores y presupuestos.`;
    }
    const url = `${PUBLIC_URL}/api/backup`;
    return `💾 *Backup de transacciones generado!*\n\n📥 Descargá acá:\n${url}\n\nPara backup completo (todas las tablas) decí "backup completo".`;
  }

  return "No entendí eso. Intentá de nuevo.";
}


// ── PROCESAR IMAGEN (Claude Vision) ──────────────────────────────────────────
async function procesarImagen(mediaUrl, mediaType, bodyText) {
  const tc = await getTipoCambio();
  const hoy = new Date().toISOString().slice(0,10);

  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const imgResp = await fetch(mediaUrl, { headers: { Authorization: authHeader } });
  if (!imgResp.ok) throw new Error(`No pude descargar la imagen: ${imgResp.status}`);

  const buffer = await imgResp.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mime = (mediaType || 'image/jpeg').split(';')[0];

  const prompt = `Sos el asistente financiero de IMPROLUX, empresa ganadera uruguaya.
Analiza esta imagen (ticket, factura o comprobante) y extrae los datos.
FECHA HOY: ${hoy}. TC BROU: ${tc ? `$${tc.toFixed(2)} UYU/USD` : 'no disponible'}.
MONEDA SISTEMA: USD. Si el monto esta en pesos UYU, dividir por el TC para convertir a USD.
CATEGORIAS: ALQUILER, ALQUILER ESTRUCTURA, ALIMENTACION RECRIA, ALIMENTACION CRIA, TERMINACION, INSUMOS VETERINARIOS, TRABAJOS VETERINARIOS, COMBUSTIBLE CAMPO, COMBUSTIBLE VIATICOS, SUELDO JORNAL, SUELDO ENCARGADO, VERDEOS Y PASTURAS, ESTRUCTURA GANADERA, MANTENIMIENTO CAMPO, MANTENIMIENTO MAQUINARIA, GASTOS VENTAS GANADERAS, INVERSION MAQUINARIA, COMPRA GANADO, COMPRA HERRAMIENTAS, BPS, GASTOS ADM, PROVISTA, VEHICULOS, TELEFONO, INTERESES, OTROS
Responde SOLO con JSON valido sin texto extra ni markdown:
{"encontrado":true,"fecha":"YYYY-MM-DD","concepto":"CATEGORIA","detalle":"descripcion breve","monto_uyu":0,"egreso_usd":0,"nota":"conversion u otros detalles"}
Si no es comprobante o no podes leer los datos: {"encontrado":false,"nota":"motivo"}
${bodyText ? `El usuario tambien escribio: "${bodyText}"` : ''}`;

  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
        { type: "text", text: prompt }
      ]
    }]
  });

  const raw = result.content[0].text.trim().replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  return JSON.parse(raw);
}

// ── PROCESAR AUDIO (Whisper via Twilio URL → transcripción con Claude) ────────
async function procesarAudio(mediaUrl, mediaType) {
  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const audioResp = await fetch(mediaUrl, { headers: { Authorization: authHeader } });
  if (!audioResp.ok) throw new Error(`No pude descargar el audio: ${audioResp.status}`);

  const buffer = await audioResp.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  // Claude puede transcribir audio OGG/MP3 directamente
  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: mediaType || "audio/ogg", data: base64 }
        },
        { type: "text", text: "Transcribí exactamente lo que dice este audio de WhatsApp. Devolvé solo el texto transcripto, sin comentarios ni explicaciones." }
      ]
    }]
  });

  return result.content[0].text.trim();
}

// ── PROCESADOR CENTRAL ────────────────────────────────────────────────────────
async function procesarMensaje(body, mediaUrl, mediaType) {
  const usuario = "improlux";
  const historial = getHistorial(usuario);
  const hoy = new Date().toISOString().slice(0,10);
  const tc = await getTipoCambio();

  // ── IMAGEN ──
  if (mediaUrl && mediaType && mediaType.startsWith('image/')) {
    try {
      const datos = await procesarImagen(mediaUrl, mediaType, body);

      if (!datos.encontrado) {
        return `📷 No pude extraer datos del comprobante.
${datos.nota || "Intentá con una foto más clara."}`;
      }

      const msg = `📷 *Comprobante detectado*

` +
        `📅 Fecha: ${datos.fecha}
` +
        `📁 Concepto: ${datos.concepto}
` +
        `📝 Detalle: ${datos.detalle}
` +
        `💰 Monto: $${parseFloat(datos.egreso_usd).toFixed(2)} USD` +
        (datos.monto_uyu ? ` ($${datos.monto_uyu} UYU)` : '') +
        (datos.nota ? `
💬 ${datos.nota}` : '') +
        `

Respondé *SI* para confirmar o corregí lo que necesites.`;

      db.prepare(`INSERT INTO sesiones (usuario,historial,updated_at) VALUES (?,?,datetime('now'))
        ON CONFLICT(usuario) DO UPDATE SET historial=excluded.historial,updated_at=excluded.updated_at`)
        .run('improlux_img_pending', JSON.stringify(datos));

      historial.push({ role: "user", content: "[Foto de comprobante]" });
      historial.push({ role: "assistant", content: msg });
      saveHistorial(usuario, historial);
      return msg;
    } catch(e) {
      console.error("Error imagen:", e.message);
      return `❌ Error procesando imagen: ${e.message}`;
    }
  }

  // ── AUDIO ──
  if (mediaUrl && mediaType && (mediaType.startsWith('audio/') || mediaType.includes('ogg'))) {
    try {
      const transcripcion = await procesarAudio(mediaUrl, mediaType);
      if (!transcripcion) return "🎤 No pude transcribir el audio. Intentá de nuevo.";
      // Procesar la transcripción como si fuera texto normal
      return await procesarMensaje(transcripcion, null, null);
    } catch(e) {
      console.error("Error audio:", e.message);
      return `❌ Error procesando audio: ${e.message}`;
    }
  }

  // ── CONFIRMAR IMAGEN PENDIENTE ──
  if (body && body.trim().toUpperCase() === 'SI') {
    const pending = db.prepare("SELECT historial FROM sesiones WHERE usuario='improlux_img_pending'").get();
    if (pending) {
      try {
        const datos = JSON.parse(pending.historial);
        db.prepare(`INSERT INTO transacciones (fecha,concepto,detalle,ingreso,egreso,proveedor,es_cc,tc,fuente)
          VALUES (?,?,?,0,?,?,0,?,'whatsapp_foto')`)
          .run(datos.fecha||hoy, datos.concepto, datos.detalle, parseFloat(datos.egreso_usd)||0, "", tc||0);
        db.prepare("DELETE FROM sesiones WHERE usuario='improlux_img_pending'").run();
        const resp = `✅ Registrado!
📝 ${datos.detalle}
📤 $${parseFloat(datos.egreso_usd).toFixed(2)} USD
📁 ${datos.concepto}`;
        historial.push({ role: "user", content: "SI" });
        historial.push({ role: "assistant", content: resp });
        saveHistorial(usuario, historial);
        return resp;
      } catch(e) { console.error("Error confirmando imagen:", e); }
    }
  }

  // ── TEXTO NORMAL ──
  historial.push({ role: "user", content: body || "" });
  const contexto = await buildContexto();
  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1200,
    system: contexto,
    messages: historial,
  });
  const raw = result.content[0].text.trim();
  historial.push({ role: "assistant", content: raw });
  saveHistorial(usuario, historial);

  const limpio = raw.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  try {
    // Multi-accion: array [{...},{...}]
    const matchArray = limpio.match(/\[[\s\S]*"accion"[\s\S]*\]/);
    if (matchArray) {
      const acciones = JSON.parse(matchArray[0]);
      if (Array.isArray(acciones) && acciones.length > 0) {
        const resultados = [];
        for (const accion of acciones) {
          if (accion?.accion) resultados.push(await ejecutarAccion(accion));
        }
        if (resultados.length > 0) return resultados.join("\n\n");
      }
    }
    // Accion unica
    const matchSingle = limpio.match(/\{[\s\S]*"accion"[\s\S]*\}/);
    if (matchSingle) {
      const accion = JSON.parse(matchSingle[0]);
      if (accion?.accion) return await ejecutarAccion(accion);
    }
    return limpio;
  } catch(_) { return limpio; }
}

// ── WEBHOOK INTERNO (desde panel web) ────────────────────────────────────────
app.post("/webhook-interno", async (req, res) => {
  try {
    const body = (req.body.Body || "").trim();
    const respuesta = await procesarMensaje(body, null, null);
    res.json({ respuesta });
  } catch(err) {
    console.error("Error webhook-interno:", err);
    res.json({ respuesta: "❌ Error interno. Intentá de nuevo." });
  }
});

// ── WEBHOOK WHATSAPP ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const body      = (req.body.Body || "").trim();
    const numMedia  = parseInt(req.body.NumMedia || "0");
    const mediaUrl  = numMedia > 0 ? req.body.MediaUrl0 : null;
    const mediaType = numMedia > 0 ? (req.body.MediaContentType0 || "") : null;
    const respuesta = await procesarMensaje(body, mediaUrl, mediaType);
    twiml.message(respuesta);
  } catch(err) {
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

app.get("/api/cc_movimientos", (req, res) => {
  const proveedor = req.query.proveedor;
  if (proveedor) {
    const detalle = getDetalleCuentaCorriente(proveedor);
    const saldo = getSaldoProveedor(proveedor);
    res.json({ proveedor, saldo, movimientos: detalle });
  } else {
    const movs = db.prepare("SELECT * FROM cc_movimientos ORDER BY fecha DESC, created_at DESC LIMIT 100").all();
    res.json(movs);
  }
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

// ── INFORME PDF CICLO ANUAL ───────────────────────────────────────────────────
app.get("/api/informe-pdf", async (req, res) => {
  try {
    const cicloStr = req.query.ciclo || getCicloActual().ciclo;
    const informe = getInformeCiclo(cicloStr);
    if (!informe) return res.status(400).json({ error: "Ciclo inválido" });

    const tc = await getTipoCambio();
    const cuentas = getResumenCuentasCorrientes();
    const cheques = getChequesPendientes();
    const inversores = getInversoresActivos();
    const totalDeudaInv = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);

    // Desglose mensual del ciclo
    const mesesNombres = ["","Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
    const desgloseMensual = [];
    const cicloData = informe.ciclo;
    const anioInicio = parseInt(cicloData.fecha_desde.slice(0, 4));
    for (let m = 3; m <= 14; m++) {
      const mesReal = m <= 12 ? m : m - 12;
      const anioReal = m <= 12 ? anioInicio : anioInicio + 1;
      const periodo = `${anioReal}-${String(mesReal).padStart(2, '0')}`;
      const hoy = new Date().toISOString().slice(0, 7);
      if (periodo > hoy) break;

      const row = db.prepare(`
        SELECT SUM(egreso) as egresos, SUM(ingreso) as ingresos, COUNT(*) as cant
        FROM transacciones WHERE fecha LIKE ?
      `).get(`${periodo}-%`);

      desgloseMensual.push({
        mes: `${mesesNombres[mesReal]} ${anioReal}`,
        egresos: row?.egresos || 0,
        ingresos: row?.ingresos || 0,
        cant: row?.cant || 0
      });
    }

    // ── Generar PDF ──
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="IMPROLUX_Ciclo_${cicloStr.replace('/', '-')}.pdf"`);
    doc.pipe(res);

    const colorVerde = '#2d6a2e';
    const colorGris = '#666666';
    const colorNegro = '#1a1a1a';
    const colorFondo = '#f5f7f5';
    const colorLinea = '#c8d6c8';

    // ── ENCABEZADO ──
    doc.rect(0, 0, doc.page.width, 100).fill(colorVerde);
    doc.fontSize(28).fill('#ffffff').font('Helvetica-Bold')
       .text('IMPROLUX', 50, 30);
    doc.fontSize(12).fill('#c8e6c8').font('Helvetica')
       .text(`Informe de Ciclo Ganadero ${informe.ciclo.label}`, 50, 62);
    doc.fontSize(9).fill('#a0c8a0')
       .text(`Generado: ${new Date().toLocaleDateString('es-UY')} | Período: ${informe.ciclo.fecha_desde} → ${informe.fechaHasta}`, 50, 80);

    let y = 120;

    // ── RESUMEN EJECUTIVO ──
    doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
       .text('Resumen Ejecutivo', 50, y);
    y += 25;

    // Cajas de KPI
    const kpis = [
      { label: 'Total Egresos', valor: `$${fmt(informe.totalEgresos)} USD`, color: '#c0392b' },
      { label: 'Total Ingresos', valor: `$${fmt(informe.totalIngresos)} USD`, color: '#27ae60' },
      { label: 'Resultado Neto', valor: `$${fmt(informe.totalIngresos - informe.totalEgresos)} USD`, color: (informe.totalIngresos - informe.totalEgresos) >= 0 ? '#27ae60' : '#c0392b' },
      { label: 'Movimientos', valor: `${informe.totalMovimientos}`, color: '#2c3e50' }
    ];

    const kpiWidth = 120;
    const kpiGap = 10;
    kpis.forEach((kpi, i) => {
      const x = 50 + i * (kpiWidth + kpiGap);
      doc.rect(x, y, kpiWidth, 55).fill(colorFondo).stroke(colorLinea);
      doc.fontSize(8).fill(colorGris).font('Helvetica').text(kpi.label, x + 8, y + 8, { width: kpiWidth - 16 });
      doc.fontSize(12).fill(kpi.color).font('Helvetica-Bold').text(kpi.valor, x + 8, y + 24, { width: kpiWidth - 16 });
    });
    y += 75;

    if (tc) {
      doc.fontSize(8).fill(colorGris).font('Helvetica')
         .text(`TC BROU: $${tc.toFixed(2)} UYU/USD`, 50, y);
      y += 18;
    }

    // ── DESGLOSE POR CATEGORÍA ──
    doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
       .text('Desglose por Categoría', 50, y);
    y += 22;

    // Header tabla
    doc.rect(50, y, 495, 18).fill(colorVerde);
    doc.fontSize(8).fill('#ffffff').font('Helvetica-Bold');
    doc.text('Categoría', 55, y + 5, { width: 180 });
    doc.text('Egreso', 240, y + 5, { width: 80, align: 'right' });
    doc.text('Ingreso', 325, y + 5, { width: 80, align: 'right' });
    doc.text('Presup.', 410, y + 5, { width: 65, align: 'right' });
    doc.text('% Ejec.', 480, y + 5, { width: 60, align: 'right' });
    y += 18;

    informe.rows.forEach((r, i) => {
      if (y > 720) { doc.addPage(); y = 50; }
      const bg = i % 2 === 0 ? '#ffffff' : colorFondo;
      doc.rect(50, y, 495, 16).fill(bg);

      const presup = informe.presupuestoMap[r.concepto];
      const pct = presup ? ((r.total_egreso / presup) * 100).toFixed(0) + '%' : '-';
      const excedido = presup && r.total_egreso > presup;

      doc.fontSize(8).fill(colorNegro).font('Helvetica');
      doc.text(r.concepto, 55, y + 4, { width: 180 });
      doc.fill(r.total_egreso > 0 ? '#c0392b' : colorGris)
         .text(r.total_egreso > 0 ? `$${fmt(r.total_egreso)}` : '-', 240, y + 4, { width: 80, align: 'right' });
      doc.fill(r.total_ingreso > 0 ? '#27ae60' : colorGris)
         .text(r.total_ingreso > 0 ? `$${fmt(r.total_ingreso)}` : '-', 325, y + 4, { width: 80, align: 'right' });
      doc.fill(colorGris)
         .text(presup ? `$${fmt(presup)}` : '-', 410, y + 4, { width: 65, align: 'right' });
      doc.fill(excedido ? '#c0392b' : colorNegro).font(excedido ? 'Helvetica-Bold' : 'Helvetica')
         .text(pct + (excedido ? ' ⚠' : ''), 480, y + 4, { width: 60, align: 'right' });
      y += 16;
    });

    // Totales
    doc.rect(50, y, 495, 18).fill(colorVerde);
    doc.fontSize(8).fill('#ffffff').font('Helvetica-Bold');
    doc.text('TOTAL', 55, y + 5, { width: 180 });
    doc.text(`$${fmt(informe.totalEgresos)}`, 240, y + 5, { width: 80, align: 'right' });
    doc.text(`$${fmt(informe.totalIngresos)}`, 325, y + 5, { width: 80, align: 'right' });
    const totalPresup = Object.values(informe.presupuestoMap).reduce((s, v) => s + v, 0);
    doc.text(totalPresup > 0 ? `$${fmt(totalPresup)}` : '-', 410, y + 5, { width: 65, align: 'right' });
    doc.text(totalPresup > 0 ? `${((informe.totalEgresos / totalPresup) * 100).toFixed(0)}%` : '-', 480, y + 5, { width: 60, align: 'right' });
    y += 35;

    // ── DESGLOSE MENSUAL ──
    if (y > 620) { doc.addPage(); y = 50; }
    doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
       .text('Evolución Mensual', 50, y);
    y += 22;

    doc.rect(50, y, 495, 18).fill(colorVerde);
    doc.fontSize(8).fill('#ffffff').font('Helvetica-Bold');
    doc.text('Mes', 55, y + 5, { width: 100 });
    doc.text('Egresos', 160, y + 5, { width: 100, align: 'right' });
    doc.text('Ingresos', 265, y + 5, { width: 100, align: 'right' });
    doc.text('Neto', 370, y + 5, { width: 100, align: 'right' });
    doc.text('Mov.', 475, y + 5, { width: 65, align: 'right' });
    y += 18;

    desgloseMensual.forEach((m, i) => {
      if (y > 720) { doc.addPage(); y = 50; }
      const bg = i % 2 === 0 ? '#ffffff' : colorFondo;
      doc.rect(50, y, 495, 16).fill(bg);
      const neto = m.ingresos - m.egresos;
      doc.fontSize(8).fill(colorNegro).font('Helvetica');
      doc.text(m.mes, 55, y + 4, { width: 100 });
      doc.fill('#c0392b').text(`$${fmt(m.egresos)}`, 160, y + 4, { width: 100, align: 'right' });
      doc.fill('#27ae60').text(`$${fmt(m.ingresos)}`, 265, y + 4, { width: 100, align: 'right' });
      doc.fill(neto >= 0 ? '#27ae60' : '#c0392b').font('Helvetica-Bold')
         .text(`$${fmt(neto)}`, 370, y + 4, { width: 100, align: 'right' });
      doc.fill(colorGris).font('Helvetica').text(`${m.cant}`, 475, y + 4, { width: 65, align: 'right' });
      y += 16;
    });
    y += 20;

    // ── CUENTAS CORRIENTES ──
    if (cuentas.length > 0) {
      if (y > 620) { doc.addPage(); y = 50; }
      doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
         .text('Cuentas Corrientes', 50, y);
      y += 22;

      doc.rect(50, y, 300, 18).fill(colorVerde);
      doc.fontSize(8).fill('#ffffff').font('Helvetica-Bold');
      doc.text('Proveedor', 55, y + 5, { width: 160 });
      doc.text('Saldo', 220, y + 5, { width: 120, align: 'right' });
      y += 18;

      cuentas.forEach((c, i) => {
        const bg = i % 2 === 0 ? '#ffffff' : colorFondo;
        doc.rect(50, y, 300, 16).fill(bg);
        doc.fontSize(8).fill(colorNegro).font('Helvetica').text(c.proveedor, 55, y + 4, { width: 160 });
        doc.fill(c.saldo > 0 ? '#c0392b' : '#27ae60').font('Helvetica-Bold')
           .text(`$${fmt(Math.abs(c.saldo))} ${c.saldo > 0 ? '(debemos)' : '(a favor)'}`, 220, y + 4, { width: 120, align: 'right' });
        y += 16;
      });
      const totalCC = cuentas.reduce((s, c) => s + c.saldo, 0);
      doc.fontSize(9).fill(colorNegro).font('Helvetica-Bold')
         .text(`Total adeudado: $${fmt(totalCC)} USD`, 50, y + 5);
      y += 25;
    }

    // ── CHEQUES PENDIENTES ──
    if (cheques.length > 0) {
      if (y > 650) { doc.addPage(); y = 50; }
      doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
         .text('Cheques Pendientes', 50, y);
      y += 22;

      cheques.forEach((c, i) => {
        if (y > 720) { doc.addPage(); y = 50; }
        doc.fontSize(8).fill(colorNegro).font('Helvetica');
        const emoji = c.tipo === "EMITIDO" ? "→" : "←";
        doc.text(`${emoji} ${c.tipo} | ${c.proveedor || 'Sin prov.'} | $${fmt(c.monto)} USD | vence: ${c.fecha_cobro || 'sin fecha'}`, 55, y);
        y += 14;
      });
      const totalCheq = cheques.reduce((s, c) => s + c.monto, 0);
      doc.fontSize(9).fill(colorNegro).font('Helvetica-Bold')
         .text(`Total cheques pendientes: $${fmt(totalCheq)} USD`, 50, y + 3);
      y += 25;
    }

    // ── INVERSORES ──
    if (inversores.length > 0) {
      if (y > 620) { doc.addPage(); y = 50; }
      doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
         .text('Inversores Activos', 50, y);
      y += 22;

      doc.rect(50, y, 450, 18).fill(colorVerde);
      doc.fontSize(8).fill('#ffffff').font('Helvetica-Bold');
      doc.text('Inversor', 55, y + 5, { width: 120 });
      doc.text('Capital', 180, y + 5, { width: 90, align: 'right' });
      doc.text('Tasa', 275, y + 5, { width: 50, align: 'right' });
      doc.text('Ingreso', 330, y + 5, { width: 80, align: 'right' });
      doc.text('Deuda Actual', 415, y + 5, { width: 80, align: 'right' });
      y += 18;

      inversores.forEach((inv, i) => {
        const bg = i % 2 === 0 ? '#ffffff' : colorFondo;
        doc.rect(50, y, 450, 16).fill(bg);
        const deuda = calcularDeudaInversor(inv);
        doc.fontSize(8).fill(colorNegro).font('Helvetica');
        doc.text(inv.inversor, 55, y + 4, { width: 120 });
        doc.text(`$${fmt(inv.capital)}`, 180, y + 4, { width: 90, align: 'right' });
        doc.text(`${(inv.tasa * 100).toFixed(1)}%`, 275, y + 4, { width: 50, align: 'right' });
        doc.text(inv.fecha_ingreso, 330, y + 4, { width: 80, align: 'right' });
        doc.fill('#c0392b').font('Helvetica-Bold')
           .text(`$${fmt(deuda)}`, 415, y + 4, { width: 80, align: 'right' });
        y += 16;
      });
      doc.fontSize(9).fill(colorNegro).font('Helvetica-Bold')
         .text(`Deuda total inversores: $${fmt(totalDeudaInv)} USD`, 50, y + 5);
    }

    // ── PIE DE PÁGINA ──
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fill(colorGris).font('Helvetica')
         .text(`IMPROLUX — Informe Ciclo ${informe.ciclo.label} — Página ${i + 1} de ${pages.count}`,
           50, doc.page.height - 30, { width: doc.page.width - 100, align: 'center' });
    }

    doc.end();
  } catch (err) {
    console.error("Error generando PDF:", err);
    res.status(500).json({ error: "Error generando el informe PDF" });
  }
});

// ── INFORME MENSUAL PDF ────────────────────────────────────────────────────────
app.get("/api/informe-mensual-pdf", async (req, res) => {
  try {
    const anio = parseInt(req.query.anio) || new Date().getFullYear();
    const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
    const mesesNombres = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
    const periodo = `${anio}-${String(mes).padStart(2, '0')}`;

    const informe = getInformeMensual(anio, mes);
    const tc = await getTipoCambio();

    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="IMPROLUX_${mesesNombres[mes]}_${anio}.pdf"`);
    doc.pipe(res);

    const colorVerde = '#2d6a2e';
    const colorGris = '#666666';
    const colorNegro = '#1a1a1a';
    const colorFondo = '#f5f7f5';
    const colorLinea = '#c8d6c8';

    // ── ENCABEZADO ──
    doc.rect(0, 0, doc.page.width, 100).fill(colorVerde);
    doc.fontSize(28).fill('#ffffff').font('Helvetica-Bold')
       .text('IMPROLUX', 50, 30);
    doc.fontSize(12).fill('#c8e6c8').font('Helvetica')
       .text(`Informe Mensual — ${mesesNombres[mes]} ${anio}`, 50, 62);
    doc.fontSize(9).fill('#a0c8a0')
       .text(`Generado: ${new Date().toLocaleDateString('es-UY')}${tc ? ` | TC BROU: $${tc.toFixed(2)} UYU/USD` : ''}`, 50, 80);

    let y = 120;

    // ── RESUMEN ──
    doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
       .text('Resumen del Mes', 50, y);
    y += 25;

    const neto = informe.totalIngresos - informe.totalEgresos;
    const kpis = [
      { label: 'Total Egresos', valor: `$${fmt(informe.totalEgresos)} USD`, color: '#c0392b' },
      { label: 'Total Ingresos', valor: `$${fmt(informe.totalIngresos)} USD`, color: '#27ae60' },
      { label: 'Resultado Neto', valor: `$${fmt(neto)} USD`, color: neto >= 0 ? '#27ae60' : '#c0392b' },
    ];

    const kpiWidth = 155;
    const kpiGap = 12;
    kpis.forEach((kpi, i) => {
      const x = 50 + i * (kpiWidth + kpiGap);
      doc.rect(x, y, kpiWidth, 55).fill(colorFondo).stroke(colorLinea);
      doc.fontSize(8).fill(colorGris).font('Helvetica').text(kpi.label, x + 10, y + 8, { width: kpiWidth - 20 });
      doc.fontSize(13).fill(kpi.color).font('Helvetica-Bold').text(kpi.valor, x + 10, y + 26, { width: kpiWidth - 20 });
    });
    y += 80;

    // ── DESGLOSE POR CATEGORÍA ──
    doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
       .text('Gastos por Categoría', 50, y);
    y += 22;

    // Header
    doc.rect(50, y, 495, 18).fill(colorVerde);
    doc.fontSize(8).fill('#ffffff').font('Helvetica-Bold');
    doc.text('Categoría', 55, y + 5, { width: 180 });
    doc.text('Egreso', 240, y + 5, { width: 80, align: 'right' });
    doc.text('Ingreso', 325, y + 5, { width: 80, align: 'right' });
    doc.text('Presup. Mes', 410, y + 5, { width: 65, align: 'right' });
    doc.text('% Ejec.', 480, y + 5, { width: 60, align: 'right' });
    y += 18;

    const categoriasConGasto = informe.rows.filter(r => r.total_egreso > 0 || r.total_ingreso > 0);
    categoriasConGasto.forEach((r, i) => {
      if (y > 720) { doc.addPage(); y = 50; }
      const bg = i % 2 === 0 ? '#ffffff' : colorFondo;
      doc.rect(50, y, 495, 16).fill(bg);

      const presupMes = informe.presupuestoMap[r.concepto];
      const pct = presupMes ? ((r.total_egreso / presupMes) * 100).toFixed(0) + '%' : '-';
      const excedido = presupMes && r.total_egreso > presupMes;

      doc.fontSize(8).fill(colorNegro).font('Helvetica');
      doc.text(r.concepto, 55, y + 4, { width: 180 });
      doc.fill(r.total_egreso > 0 ? '#c0392b' : colorGris)
         .text(r.total_egreso > 0 ? `$${fmt(r.total_egreso)}` : '-', 240, y + 4, { width: 80, align: 'right' });
      doc.fill(r.total_ingreso > 0 ? '#27ae60' : colorGris)
         .text(r.total_ingreso > 0 ? `$${fmt(r.total_ingreso)}` : '-', 325, y + 4, { width: 80, align: 'right' });
      doc.fill(colorGris)
         .text(presupMes ? `$${fmt(presupMes)}` : '-', 410, y + 4, { width: 65, align: 'right' });
      doc.fill(excedido ? '#c0392b' : colorNegro).font(excedido ? 'Helvetica-Bold' : 'Helvetica')
         .text(pct + (excedido ? ' ⚠' : ''), 480, y + 4, { width: 60, align: 'right' });
      y += 16;
    });

    // Totales
    doc.rect(50, y, 495, 18).fill(colorVerde);
    doc.fontSize(8).fill('#ffffff').font('Helvetica-Bold');
    doc.text('TOTAL', 55, y + 5, { width: 180 });
    doc.text(`$${fmt(informe.totalEgresos)}`, 240, y + 5, { width: 80, align: 'right' });
    doc.text(`$${fmt(informe.totalIngresos)}`, 325, y + 5, { width: 80, align: 'right' });
    const totalPresupMes = Object.values(informe.presupuestoMap).reduce((s, v) => s + v, 0);
    doc.text(totalPresupMes > 0 ? `$${fmt(totalPresupMes)}` : '-', 410, y + 5, { width: 65, align: 'right' });
    doc.text(totalPresupMes > 0 ? `${((informe.totalEgresos / totalPresupMes) * 100).toFixed(0)}%` : '-', 480, y + 5, { width: 60, align: 'right' });
    y += 35;

    // ── TOP 10 MOVIMIENTOS DEL MES ──
    if (y > 550) { doc.addPage(); y = 50; }
    const movimientos = db.prepare(`
      SELECT * FROM transacciones 
      WHERE fecha LIKE ? 
      ORDER BY egreso DESC LIMIT 10
    `).all(`${periodo}-%`);

    if (movimientos.length > 0) {
      doc.fontSize(14).fill(colorVerde).font('Helvetica-Bold')
         .text('Top 10 Gastos del Mes', 50, y);
      y += 22;

      doc.rect(50, y, 495, 18).fill(colorVerde);
      doc.fontSize(8).fill('#ffffff').font('Helvetica-Bold');
      doc.text('Fecha', 55, y + 5, { width: 65 });
      doc.text('Concepto', 125, y + 5, { width: 120 });
      doc.text('Detalle', 250, y + 5, { width: 150 });
      doc.text('Monto', 405, y + 5, { width: 80, align: 'right' });
      y += 18;

      movimientos.forEach((t, i) => {
        if (y > 720) { doc.addPage(); y = 50; }
        const bg = i % 2 === 0 ? '#ffffff' : colorFondo;
        doc.rect(50, y, 495, 16).fill(bg);
        doc.fontSize(7).fill(colorNegro).font('Helvetica');
        doc.text(t.fecha, 55, y + 4, { width: 65 });
        doc.text(t.concepto, 125, y + 4, { width: 120 });
        doc.text((t.detalle || '').substring(0, 30), 250, y + 4, { width: 150 });
        doc.fill('#c0392b').font('Helvetica-Bold')
           .text(`$${fmt(t.egreso)}`, 405, y + 4, { width: 80, align: 'right' });
        y += 16;
      });
    }

    // ── PIE DE PÁGINA ──
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fill(colorGris).font('Helvetica')
         .text(`IMPROLUX — ${mesesNombres[mes]} ${anio} — Página ${i + 1} de ${pages.count}`,
           50, doc.page.height - 30, { width: doc.page.width - 100, align: 'center' });
    }

    doc.end();
  } catch (err) {
    console.error("Error generando PDF mensual:", err);
    res.status(500).json({ error: "Error generando el informe PDF mensual" });
  }
});

// ── BACKUP CSV ────────────────────────────────────────────────────────────────
app.get("/api/backup", (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const rows = db.prepare("SELECT * FROM transacciones ORDER BY fecha ASC, id ASC").all();

    // Header CSV
    const headers = ["id","fecha","concepto","detalle","ingreso","egreso","proveedor","es_cc","tc","fuente","created_at"];
    const csvLines = [headers.join(",")];

    for (const r of rows) {
      const line = headers.map(h => {
        let val = r[h] ?? "";
        val = String(val).replace(/"/g, '""');
        if (String(val).includes(",") || String(val).includes('"') || String(val).includes("\n")) {
          val = `"${val}"`;
        }
        return val;
      });
      csvLines.push(line.join(","));
    }

    const csv = csvLines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="IMPROLUX_backup_${hoy}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("Error generando backup:", err);
    res.status(500).json({ error: "Error generando backup" });
  }
});

// Backup de todas las tablas (ZIP-like: múltiples CSVs en una sola descarga)
app.get("/api/backup-completo", (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);

    function tableToCsv(tableName) {
      const rows = db.prepare(`SELECT * FROM ${tableName}`).all();
      if (!rows.length) return "";
      const headers = Object.keys(rows[0]);
      const lines = [headers.join(",")];
      for (const r of rows) {
        const line = headers.map(h => {
          let val = r[h] ?? "";
          val = String(val).replace(/"/g, '""');
          if (String(val).includes(",") || String(val).includes('"') || String(val).includes("\n")) val = `"${val}"`;
          return val;
        });
        lines.push(line.join(","));
      }
      return lines.join("\n");
    }

    const tablas = ["transacciones", "cuentas_corrientes", "cheques", "inversores", "presupuestos"];
    const separador = "\n\n========================================\n";
    let contenido = "";

    for (const t of tablas) {
      const csv = tableToCsv(t);
      if (csv) {
        contenido += `=== TABLA: ${t.toUpperCase()} ===\n${csv}${separador}`;
      }
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="IMPROLUX_backup_completo_${hoy}.csv"`);
    res.send(contenido);
  } catch (err) {
    console.error("Error generando backup completo:", err);
    res.status(500).json({ error: "Error generando backup" });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/api/dividendos", (req, res) => {
  const pablo = db.prepare(`SELECT COALESCE(SUM(monto),0) as total FROM dividendos WHERE LOWER(socio) LIKE '%pablo%'`).get().total;
  const joni  = db.prepare(`SELECT COALESCE(SUM(monto),0) as total FROM dividendos WHERE LOWER(socio) LIKE '%jonatan%' OR LOWER(socio) LIKE '%astolfo%'`).get().total;
  const historial = db.prepare(`SELECT * FROM dividendos ORDER BY fecha DESC`).all();
  const porMes = {};
  historial.forEach(d => {
    const mes = d.fecha.slice(0,7);
    if (!porMes[mes]) porMes[mes] = { pablo: 0, joni: 0 };
    if (d.socio.toLowerCase().includes('pablo')) porMes[mes].pablo += d.monto;
    else porMes[mes].joni += d.monto;
  });
  res.json({ pablo, joni, total: pablo + joni, historial, por_mes: porMes });
});

// ── API LOTES Y LABOREOS ──────────────────────────────────────────────────────
app.get("/api/lotes", (req, res) => {
  const lotes = db.prepare("SELECT * FROM lotes ORDER BY nombre").all();
  res.json(lotes);
});

app.post("/api/lotes", (req, res) => {
  const { nombre, hectareas, ha_sembrables, notas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
  try {
    const r = db.prepare("INSERT INTO lotes (nombre,hectareas,ha_sembrables,notas) VALUES (?,?,?,?)").run(nombre.toUpperCase(), hectareas||0, ha_sembrables||0, notas||'');
    res.json({ id: r.lastInsertRowid, nombre: nombre.toUpperCase() });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/laboreos", (req, res) => {
  const { ciclo, lote, estado } = req.query;
  let q = "SELECT l.*, lt.hectareas, lt.ha_sembrables FROM laboreos l LEFT JOIN lotes lt ON lt.nombre = l.lote WHERE 1=1";
  const p = [];
  if (ciclo) { q += " AND l.ciclo = ?"; p.push(ciclo); }
  if (lote) { q += " AND LOWER(l.lote) LIKE ?"; p.push('%'+lote.toLowerCase()+'%'); }
  if (estado) { q += " AND l.estado = ?"; p.push(estado); }
  q += " ORDER BY l.ciclo DESC, l.lote";
  const laboreos = db.prepare(q).all(...p);
  // Add items to each
  const withItems = laboreos.map(lab => ({
    ...lab,
    items: db.prepare("SELECT * FROM laboreo_items WHERE laboreo_id = ? ORDER BY categoria, id").all(lab.id)
  }));
  res.json(withItems);
});

app.post("/api/laboreos", (req, res) => {
  const { lote, tipo, descripcion, ciclo, notas } = req.body;
  if (!lote || !tipo || !ciclo) return res.status(400).json({ error: 'Faltan campos' });
  const r = db.prepare("INSERT INTO laboreos (lote,tipo,descripcion,ciclo,estado,notas) VALUES (?,?,?,?,'PLANIFICADO',?)").run(lote.toUpperCase(), tipo.toUpperCase(), descripcion||'', ciclo, notas||'');
  res.json({ id: r.lastInsertRowid });
});

app.put("/api/laboreos/:id", (req, res) => {
  const { estado, fecha_ejecucion, notas, descripcion } = req.body;
  const fields = {}; 
  if (estado) fields.estado = estado;
  if (fecha_ejecucion) fields.fecha_ejecucion = fecha_ejecucion;
  if (notas !== undefined) fields.notas = notas;
  if (descripcion !== undefined) fields.descripcion = descripcion;
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nada que actualizar' });
  const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE laboreos SET ${sets} WHERE id=?`).run(...Object.values(fields), req.params.id);
  res.json({ ok: true });
});

app.delete("/api/laboreos/:id", (req, res) => {
  db.prepare("DELETE FROM laboreo_items WHERE laboreo_id=?").run(req.params.id);
  db.prepare("DELETE FROM laboreos WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/laboreos/:id/items", (req, res) => {
  res.json(db.prepare("SELECT * FROM laboreo_items WHERE laboreo_id=? ORDER BY categoria,id").all(req.params.id));
});

app.post("/api/laboreos/:id/items", (req, res) => {
  const { categoria, descripcion, cantidad, unidad, precio_unitario } = req.body;
  if (!descripcion) return res.status(400).json({ error: 'Falta descripcion' });
  const total = (parseFloat(cantidad)||0) * (parseFloat(precio_unitario)||0);
  const r = db.prepare("INSERT INTO laboreo_items (laboreo_id,categoria,descripcion,cantidad,unidad,precio_unitario,total) VALUES (?,?,?,?,?,?,?)").run(req.params.id, categoria||'INSUMO', descripcion, parseFloat(cantidad)||0, unidad||'kg', parseFloat(precio_unitario)||0, total);
  // Recalc total
  const tot = db.prepare("SELECT COALESCE(SUM(total),0) as t FROM laboreo_items WHERE laboreo_id=?").get(req.params.id).t;
  db.prepare("UPDATE laboreos SET total_presupuestado=? WHERE id=?").run(tot, req.params.id);
  res.json({ id: r.lastInsertRowid, total });
});

app.put("/api/laboreos/:id/items/:itemId", (req, res) => {
  const { descripcion, cantidad, unidad, precio_unitario, categoria, ejecutado, fecha_ejecucion, notas_ejecucion } = req.body;
  const item = db.prepare("SELECT * FROM laboreo_items WHERE id=? AND laboreo_id=?").get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item no encontrado' });

  // Si solo se está ejecutando el item (no editando)
  if (ejecutado !== undefined && Object.keys(req.body).length <= 3) {
    const hoy = new Date().toISOString().slice(0,10);
    db.prepare("UPDATE laboreo_items SET ejecutado=?, fecha_ejecucion=?, notas_ejecucion=? WHERE id=? AND laboreo_id=?")
      .run(ejecutado ? 1 : 0, ejecutado ? (fecha_ejecucion || hoy) : null, notas_ejecucion || null, req.params.itemId, req.params.id);
  } else {
    // Edición completa
    const total = (parseFloat(cantidad||item.cantidad)||0) * (parseFloat(precio_unitario||item.precio_unitario)||0);
    db.prepare("UPDATE laboreo_items SET descripcion=?,cantidad=?,unidad=?,precio_unitario=?,total=?,categoria=?,ejecutado=?,fecha_ejecucion=?,notas_ejecucion=? WHERE id=? AND laboreo_id=?")
      .run(descripcion||item.descripcion, parseFloat(cantidad||item.cantidad)||0, unidad||item.unidad||'kg', parseFloat(precio_unitario||item.precio_unitario)||0, total, categoria||item.categoria||'INSUMO', ejecutado!==undefined?ejecutado:item.ejecutado, fecha_ejecucion||item.fecha_ejecucion, notas_ejecucion||item.notas_ejecucion, req.params.itemId, req.params.id);
  }
  const result = recalcularTotalLaboreo(req.params.id);
  res.json({ ok: true, ...result });
});

// Ejecutar item específico (shortcut)
app.post("/api/laboreos/:id/items/:itemId/ejecutar", (req, res) => {
  const hoy = new Date().toISOString().slice(0,10);
  const { fecha, notas } = req.body;
  db.prepare("UPDATE laboreo_items SET ejecutado=1, fecha_ejecucion=?, notas_ejecucion=? WHERE id=? AND laboreo_id=?")
    .run(fecha || hoy, notas || null, req.params.itemId, req.params.id);
  const result = recalcularTotalLaboreo(req.params.id);
  res.json({ ok: true, ...result });
});

// Desejecutar item
app.post("/api/laboreos/:id/items/:itemId/desejecutar", (req, res) => {
  db.prepare("UPDATE laboreo_items SET ejecutado=0, fecha_ejecucion=NULL, notas_ejecucion=NULL WHERE id=? AND laboreo_id=?")
    .run(req.params.itemId, req.params.id);
  const result = recalcularTotalLaboreo(req.params.id);
  res.json({ ok: true, ...result });
});

app.delete("/api/laboreos/:id/items/:itemId", (req, res) => {
  db.prepare("DELETE FROM laboreo_items WHERE id=? AND laboreo_id=?").run(req.params.itemId, req.params.id);
  const tot = db.prepare("SELECT COALESCE(SUM(total),0) as t FROM laboreo_items WHERE laboreo_id=?").get(req.params.id).t;
  db.prepare("UPDATE laboreos SET total_presupuestado=? WHERE id=?").run(tot, req.params.id);
  res.json({ ok: true });
});

app.get("/", (req, res) => res.json({ status: "IMPROLUX Bot activo 🟢", version: "4.2" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IMPROLUX Bot v4.1 corriendo en puerto ${PORT}`);
  scheduleInformeMensual();
});

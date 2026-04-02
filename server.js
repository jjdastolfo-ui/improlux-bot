const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 🔥 LOG GLOBAL (DEBUG)
app.use((req, res, next) => {
  console.log(`👉 ${req.method} ${req.url}`);
  next();
});

// ── DB (CORREGIDO PARA RAILWAY) ─────────────────────────────
const DB_PATH = process.env.DB_PATH || "./improlux.db";
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// ── TABLAS ──────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS transacciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT,
  concepto TEXT,
  detalle TEXT,
  ingreso REAL DEFAULT 0,
  egreso REAL DEFAULT 0,
  proveedor TEXT,
  es_cc INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cc_movimientos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT,
  proveedor TEXT,
  monto REAL,
  medio TEXT,
  notas TEXT
);
`);

// ── HELPERS ─────────────────────────────────────────────────
function fmt(n) {
  return parseFloat(n || 0).toFixed(2);
}

function getSaldoCC(proveedor) {
  const compras = db.prepare(`
    SELECT COALESCE(SUM(egreso),0) as t
    FROM transacciones
    WHERE proveedor = ? AND es_cc = 1
  `).get(proveedor);

  const pagos = db.prepare(`
    SELECT COALESCE(SUM(monto),0) as t
    FROM cc_movimientos
    WHERE proveedor = ?
  `).get(proveedor);

  return (compras.t || 0) - (pagos.t || 0);
}

// ── REGISTRAR TRANSACCIÓN ───────────────────────────────────
function registrarTransaccion(data) {
  const { fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc } = data;

  // 🚫 BLOQUEAR PAGOS CC MAL CARGADOS
  if (es_cc && ingreso > 0) {
    return "❌ Un pago de cuenta corriente debe registrarse como 'pagar_cc'";
  }

  db.prepare(`
    INSERT INTO transacciones
    (fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    fecha,
    concepto,
    detalle,
    ingreso || 0,
    egreso || 0,
    proveedor || "",
    es_cc ? 1 : 0
  );

  return "✅ Transacción registrada";
}

// ── PAGAR CC (SIN DUPLICAR) ─────────────────────────────────
function pagarCC(data) {
  const { fecha, proveedor, monto, medio } = data;

  db.prepare(`
    INSERT INTO cc_movimientos
    (fecha, proveedor, monto, medio)
    VALUES (?, ?, ?, ?)
  `).run(fecha, proveedor, monto, medio || "EFECTIVO");

  return `✅ Pago registrado. Saldo: $${fmt(getSaldoCC(proveedor))}`;
}

// ── IMPORTACIÓN INTELIGENTE (CLAVE) ─────────────────────────
app.post("/api/importar", (req, res) => {
  const { transacciones } = req.body;

  let ok = 0;
  let errores = 0;

  for (const t of transacciones) {
    try {
      const detalle = (t.detalle || "").toLowerCase();

      const esPagoCC =
        detalle.includes("cuenta corriente") ||
        detalle.includes("pago cc") ||
        detalle.includes("pago cuenta");

      if (esPagoCC) {
        db.prepare(`
          INSERT INTO cc_movimientos
          (fecha, proveedor, monto, medio, notas)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          t.fecha,
          t.proveedor,
          Math.abs(t.egreso || t.ingreso),
          "EFECTIVO",
          "importado"
        );

        ok++;
        continue;
      }

      db.prepare(`
        INSERT INTO transacciones
        (fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        t.fecha,
        t.concepto,
        t.detalle,
        t.ingreso || 0,
        t.egreso || 0,
        t.proveedor || "",
        t.es_cc ? 1 : 0
      );

      ok++;

    } catch (e) {
      errores++;
    }
  }

  res.json({ ok, errores });
});

// ── SALDOS ─────────────────────────────────────────────────
app.get("/api/saldos", (req, res) => {
  const proveedores = db.prepare(`
    SELECT DISTINCT proveedor
    FROM transacciones
    WHERE proveedor != ''
  `).all();

  const resultado = proveedores.map(p => ({
    proveedor: p.proveedor,
    saldo: getSaldoCC(p.proveedor)
  }));

  res.json(resultado);
});

// ── WEBHOOK WHATSAPP ───────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("📩 TWILIO:", req.body);

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const mensaje = (req.body.Body || "").toLowerCase();

    if (mensaje.includes("saldo")) {
      const rows = db.prepare(`
        SELECT DISTINCT proveedor FROM transacciones WHERE proveedor != ''
      `).all();

      let texto = "📊 Saldos:\n";

      rows.forEach(r => {
        const saldo = getSaldoCC(r.proveedor);
        texto += `${r.proveedor}: $${fmt(saldo)}\n`;
      });

      twiml.message(texto);
    } else {
      twiml.message("OK 👍");
    }

  } catch (e) {
    console.error(e);
    twiml.message("❌ Error");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── HEALTH CHECK ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("IMPROLUX OK");
});

// ── SERVER ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server corriendo en puerto", PORT);
});

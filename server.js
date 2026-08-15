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
// Servir archivos estáticos SIN default (para poder mapear rutas explícitas abajo)
// Sin index:false, express.static intercepta '/' y sirve index.html directamente.
// Con index:false, podemos definir manualmente qué se sirve en cada ruta.
app.use(express.static(path.join(__dirname), { index: false }));

// ══════════════════════════════════════════════════════════════════════════════
// RUTAS DE VISTAS
//
// /       → home.html    (dashboard global: Finanzas + Ganadería)
// /videla → index.html   (VIDELA — sistema financiero)
// /ade    → redirect     (ADE — sistema ganadero, vive en GitHub Pages)
//
// Los otros archivos (CSS, JS, imágenes) siguen sirviéndose vía express.static.
// ══════════════════════════════════════════════════════════════════════════════
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "home.html")));
app.get("/videla", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/finanzas", (req, res) => res.sendFile(path.join(__dirname, "index.html")));  // alias
app.get("/ade", (req, res) => res.redirect("https://jjdastolfo-ui.github.io/angus-del-este/ADE_v4.html?campo=angus_la_posta"));
app.get("/ganaderia", (req, res) => res.redirect("https://jjdastolfo-ui.github.io/angus-del-este/ADE_v4.html?campo=angus_la_posta"));  // alias

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────────
// NUMERO_ADMIN acepta uno o varios números separados por coma
const NUMEROS_ADMIN = (process.env.NUMERO_ADMIN || "")
  .split(",")
  .map(n => n.trim())
  .filter(n => n.length > 0);
// Compat con IMPROLUX que usaba variable singular
const NUMERO_ADMIN = NUMEROS_ADMIN[0] || "";

// Categorías adaptadas a Argentina
// (sin BPS - reemplazado por conceptos AR como CARGAS SOCIALES/MONOTRIBUTO)
const CATEGORIAS = [
  "ALQUILER","ALQUILER ESTRUCTURA","ALIMENTACION RECRIA","ALIMENTACION CRIA",
  "TERMINACION","INSUMOS VETERINARIOS","TRABAJOS VETERINARIOS",
  "COMBUSTIBLE CAMPO","COMBUSTIBLE VIATICOS","SUELDO PEON","SUELDO ENCARGADO","SUELDO ADM",
  "VERDEOS Y PASTURAS","ESTRUCTURA GANADERA","MANTENIMIENTO CAMPO",
  "MANTENIMIENTO MAQUINARIA","GASTOS VENTAS GANADERAS","INVERSION MAQUINARIA",
  "COMPRA GANADO","COMPRA HERRAMIENTAS","CARGAS SOCIALES","MONOTRIBUTO","IMPUESTOS",
  "GASTOS ADM","PROVISTA","VEHICULOS","TELEFONO","INTERESES","GASTO BANCARIO",
  "AMORTIZACION MAQUINARIA","FLETES","OTROS"
];

const DB_PATH = process.env.DB_PATH || "./videla.db";
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
    ingreso REAL DEFAULT 0,        -- ARS
    egreso REAL DEFAULT 0,         -- ARS
    ingreso_kg REAL DEFAULT 0,     -- kg carne INMAG
    egreso_kg REAL DEFAULT 0,      -- kg carne INMAG
    precio_mag REAL,               -- $/kg de la semana anterior (INMAG)
    semana_mag TEXT,               -- "2026-W22"
    proveedor TEXT,
    es_cc INTEGER DEFAULT 0,
    tc REAL,                       -- se mantiene por compat (=precio_mag)
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
    monto REAL NOT NULL,           -- ARS
    monto_kg REAL DEFAULT 0,       -- kg carne al momento de emisión
    precio_mag REAL,               -- precio MAG usado para la conversión
    estado TEXT DEFAULT 'PENDIENTE',
    banco TEXT DEFAULT 'NACION',
    concepto TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inversores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inversor TEXT NOT NULL,
    fecha_ingreso TEXT NOT NULL,
    capital REAL NOT NULL,         -- ARS
    capital_kg REAL DEFAULT 0,     -- kg carne al momento del ingreso
    tasa REAL NOT NULL,            -- % anual sobre el capital kg
    fecha_vencimiento TEXT,
    deuda_actual REAL,             -- ARS (referencia)
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
    monto REAL NOT NULL,           -- ARS
    monto_kg REAL DEFAULT 0,       -- kg carne
    medio TEXT DEFAULT 'EFECTIVO',
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS presupuestos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ciclo TEXT NOT NULL,
    concepto TEXT NOT NULL,
    monto_anual REAL NOT NULL,     -- kg carne INMAG (unidad estable, inmune a inflación)
    monto_anual_ars REAL DEFAULT 0, -- ARS de referencia (al momento de crearlo)
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ciclo, concepto)
  );

  CREATE TABLE IF NOT EXISTS bienes_muebles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    categoria TEXT,
    valor_compra REAL NOT NULL,       -- ARS
    valor_compra_kg REAL DEFAULT 0,   -- kg carne al momento de compra
    fecha_compra TEXT NOT NULL,
    vida_util_anios REAL NOT NULL DEFAULT 10,
    valor_residual REAL DEFAULT 0,    -- ARS
    valor_residual_kg REAL DEFAULT 0, -- kg carne
    notas TEXT,
    activo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS amortizaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bien_id INTEGER NOT NULL,
    ciclo TEXT NOT NULL,
    monto REAL NOT NULL,              -- kg carne (amortización anual en kg)
    monto_ars REAL DEFAULT 0,
    transaccion_id INTEGER,
    fecha TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(bien_id, ciclo)
  );

  CREATE TABLE IF NOT EXISTS stock_ganadero (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campo TEXT DEFAULT 'AMAKAIK',
    categoria TEXT NOT NULL,
    cantidad REAL DEFAULT 0,
    valor_cabeza REAL DEFAULT 0,      -- ARS por cabeza
    valor_cabeza_kg REAL DEFAULT 0,   -- kg carne por cabeza
    orden INTEGER DEFAULT 0,
    origen TEXT DEFAULT 'manual',
    notas TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dividendos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    socio TEXT NOT NULL,
    monto REAL NOT NULL,              -- ARS
    monto_kg REAL DEFAULT 0,          -- kg carne (unidad principal)
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

  -- ===== ÓRDENES DE TRABAJO + STOCK (v4.3) =====
  CREATE TABLE IF NOT EXISTS stock_productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    categoria TEXT DEFAULT 'OTRO',      -- SEMILLA / FERTILIZANTE / AGROQUIMICO / VETERINARIO / OTRO
    unidad TEXT DEFAULT 'kg',
    cantidad REAL DEFAULT 0,            -- stock actual
    precio_unitario REAL DEFAULT 0,     -- costo promedio ponderado (ARS)
    precio_unitario_kg REAL DEFAULT 0,  -- costo promedio ponderado (kg carne)
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_movimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL,
    fecha TEXT NOT NULL,
    tipo TEXT NOT NULL,                 -- ENTRADA / SALIDA / AJUSTE
    cantidad REAL NOT NULL,
    precio_unitario REAL DEFAULT 0,     -- ARS
    precio_unitario_kg REAL DEFAULT 0,  -- kg carne
    orden_id INTEGER,                   -- si la salida viene de ejecutar una orden
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(producto_id) REFERENCES stock_productos(id)
  );

  CREATE TABLE IF NOT EXISTS ordenes_trabajo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero INTEGER NOT NULL,            -- correlativo dentro del año
    anio INTEGER NOT NULL,
    lote TEXT,
    titulo TEXT,
    ciclo TEXT,
    hectareas REAL DEFAULT 0,           -- ha a trabajar
    estado TEXT DEFAULT 'PLANIFICADA',
    notas TEXT,
    total_planificado REAL DEFAULT 0,     -- ARS
    total_ejecutado REAL DEFAULT 0,       -- ARS
    total_planificado_kg REAL DEFAULT 0,  -- kg carne
    total_ejecutado_kg REAL DEFAULT 0,    -- kg carne
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orden_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_id INTEGER NOT NULL,
    tipo TEXT DEFAULT 'INSUMO',
    etapa TEXT DEFAULT 'GENERAL',
    producto_id INTEGER,
    descripcion TEXT NOT NULL,
    dosis REAL DEFAULT 0,
    cantidad REAL DEFAULT 0,
    unidad TEXT DEFAULT 'kg',
    precio_unitario REAL DEFAULT 0,       -- ARS
    total REAL DEFAULT 0,                  -- ARS
    precio_unitario_kg REAL DEFAULT 0,    -- kg carne
    total_kg REAL DEFAULT 0,               -- kg carne
    ejecutado INTEGER DEFAULT 0,
    cantidad_ejecutada REAL DEFAULT 0,
    total_ejecutado REAL DEFAULT 0,
    total_ejecutado_kg REAL DEFAULT 0,
    fecha_ejecucion TEXT,
    notas TEXT,
    FOREIGN KEY(orden_id) REFERENCES ordenes_trabajo(id),
    FOREIGN KEY(producto_id) REFERENCES stock_productos(id)
  );

  CREATE TABLE IF NOT EXISTS orden_cambios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orden_id INTEGER NOT NULL,
    fecha TEXT NOT NULL,
    texto TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(orden_id) REFERENCES ordenes_trabajo(id)
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- MAG: Índice Novillo Mercado Agroganadero de Cañuelas (INMAG)
  -- Es la referencia oficial de precio del kg carne en Argentina.
  -- El scraper lo actualiza automáticamente cada semana.
  -- ═══════════════════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS precios_mag (
    semana TEXT PRIMARY KEY,          -- "2026-W22"
    fecha_desde TEXT NOT NULL,
    fecha_hasta TEXT NOT NULL,
    precio_promedio REAL NOT NULL,    -- ARS/kg
    cabezas INTEGER,
    fuente TEXT DEFAULT 'scraping',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS precios_mag_diario (
    fecha TEXT PRIMARY KEY,
    indice_novillo REAL NOT NULL,
    cabezas INTEGER DEFAULT 0,
    importe_total REAL DEFAULT 0,
    kg_total REAL DEFAULT 0,
    fuente TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Socios: en IMPROLUX está en dividendos.socio como texto.
  -- Acá lo hacemos una tabla propia para poder gestionar bien y trackear retiros.
  CREATE TABLE IF NOT EXISTS socios (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    color_hex TEXT DEFAULT '#c4923a',
    activo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═════════════════════════════════════════════════════════════════════════════
  -- APORTES DE SOCIOS (patrimonio inmovilizado — NO afecta el flujo operativo)
  --
  -- Cada aporte queda registrado con:
  --   - socio        : id del socio que aporta
  --   - fecha        : cuándo se hizo el aporte (día exacto — importa para intereses)
  --   - monto_kg     : valor del aporte en kg carne INMAG (unidad principal)
  --   - monto_ars    : valor en pesos (opcional — de referencia)
  --   - precio_mag   : precio MAG usado si se cargó en ARS
  --   - detalle      : texto libre (ej: "manga metálica", "10 vaquillonas", "tanque agua")
  --
  -- MECÁNICA DE INTERÉS
  -- ═══════════════════
  -- Los aportes generan una DIFERENCIA día por día entre los socios. El que puso
  -- más tiene un "saldo a favor" contra el que puso menos. Sobre esa diferencia
  -- se devenga 4% anual (kg carne), calculado día por día desde el momento en
  -- que se generó cada tramo de desbalance.
  --
  -- Ejemplo: si el 1/8 Jonatan lleva 5.000 kg y Marcos 3.000 kg, hay una
  -- diferencia de 2.000 kg. Sobre esos 2.000 kg, Marcos le debe a Jonatan
  -- 4% anual = 0,01096% por día = 0,219 kg/día. Si al día siguiente Marcos
  -- aporta 500 kg más, la diferencia baja a 1.500 kg y desde ahí se recalcula.
  --
  -- Los intereses NO se cargan como aportes: son un cálculo derivado que se
  -- muestra en el dashboard. Se pagan en dividendo/cierre, según decidan.
  --
  -- TIPOS DE MOVIMIENTO en aportes_socios:
  --   'APORTE'       → aporte real (estructura, ganado). Positivo. Suma capital.
  --   'COMPENSACION' → ajuste contable entre socios. Puede ser +/-.
  --                    Van dos filas linkeadas por grupo_id (uno +, otro -).
  --                    Si cubre toda la diferencia, resetea intereses acumulados.
  -- ═════════════════════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS aportes_socios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL DEFAULT 'APORTE',   -- 'APORTE' o 'COMPENSACION'
    socio TEXT NOT NULL,                    -- id del socio ('jonatan', 'marcos')
    fecha TEXT NOT NULL,                    -- YYYY-MM-DD
    monto_kg REAL NOT NULL,                 -- unidad principal (kg carne) — puede ser negativo si es COMPENSACION
    monto_ars REAL DEFAULT 0,               -- referencia (opcional)
    precio_mag REAL,                        -- precio MAG usado si el input fue en ARS
    detalle TEXT,                           -- texto libre
    grupo_id TEXT,                          -- para COMPENSACION: liga las dos filas (+ y -)
    reseteo_intereses INTEGER DEFAULT 0,    -- 1 si esta compensación reseteó los intereses acumulados
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═════════════════════════════════════════════════════════════════════════════
  -- COBROS DE INTERESES (SÍ tocan flujo)
  --
  -- Cuando el socio que acumuló intereses a favor los "cobra", se registra acá.
  -- El cobro genera un retiro/dividendo (egreso del flujo) y un asiento acá que
  -- indica cuánto y cuándo se cobró. Al calcular intereses devengados, se resta
  -- lo ya cobrado para no cobrarlo dos veces.
  --
  -- Puede ser:
  --   - Total (cobra todo el acumulado hasta hoy)
  --   - Parcial (cobra un monto específico, el resto sigue devengando)
  -- ═════════════════════════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS intereses_cobros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    socio_acreedor TEXT NOT NULL,          -- socio que cobra (el que puso más)
    socio_deudor TEXT NOT NULL,            -- socio que paga (el que puso menos)
    monto_kg REAL NOT NULL,                -- monto cobrado en kg carne
    monto_ars REAL DEFAULT 0,              -- ARS al momento del cobro
    precio_mag REAL,
    tipo_cobro TEXT DEFAULT 'PARCIAL',     -- 'TOTAL' o 'PARCIAL'
    dividendo_id INTEGER,                  -- fk a dividendos (el que genera el egreso del flujo)
    notas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed inicial de socios de Cabaña Amakaik
try {
  db.prepare(`INSERT OR IGNORE INTO socios (id, nombre, color_hex) VALUES (?, ?, ?)`)
    .run("jonatan", "Jonatan Dastolfo", "#8b5cf6");
  db.prepare(`INSERT OR IGNORE INTO socios (id, nombre, color_hex) VALUES (?, ?, ?)`)
    .run("marcos", "Marcos Gullo", "#c4923a");
} catch(e) { console.warn("⚠️  No pude seedear socios:", e.message); }

// Inicializar proveedores conocidos de Cabaña Amakaik (Argentina)
// (podés agregar/editar desde el dashboard después)
const proveedoresIniciales = [
  { proveedor: 'INVERNADEROS DEL SUR', notas: 'Alimentación y balanceados' },
  { proveedor: 'AGROPECUARIA VIDELA', notas: 'Insumos varios' },
  { proveedor: 'VETERINARIA CENTRAL', notas: 'Sanidad y trabajos veterinarios' },
  { proveedor: 'YPF ESTACION', notas: 'Combustible' },
  { proveedor: 'SRA', notas: 'Sociedad Rural Argentina' },
  { proveedor: 'AAA', notas: 'Asociación Argentina de Angus' },
];
try {
  const stmtProv = db.prepare('INSERT OR IGNORE INTO cuentas_corrientes (proveedor, notas) VALUES (?, ?)');
  proveedoresIniciales.forEach(p => stmtProv.run(p.proveedor, p.notas));
} catch(e) { console.warn("⚠️  No pude seedear proveedores:", e.message); }

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRACIONES DEFENSIVAS PARA `lotes`
// Si la DB viene de VIDELA v1 (u otra versión) puede que la tabla `lotes` exista
// con columnas distintas. CREATE TABLE IF NOT EXISTS no re-crea la tabla, solo la
// respeta. Estas ALTER TABLE agregan las columnas que necesitamos, ignorando si
// ya existen (por eso el try/catch por cada una).
// ═══════════════════════════════════════════════════════════════════════════════
try { db.exec(`ALTER TABLE lotes ADD COLUMN hectareas REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE lotes ADD COLUMN ha_sembrables REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE lotes ADD COLUMN notas TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE lotes ADD COLUMN poligono TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE lotes ADD COLUMN campo TEXT DEFAULT 'AMAKAIK'`); } catch(e) {}
try { db.exec(`ALTER TABLE lotes ADD COLUMN created_at TEXT`); } catch(e) {}

// Inicializar lotes de Cabaña Amakaik si no existen
// (21 ha alquiladas en Videla Dorna, BA — vas a poder editarlos desde el dashboard)
const lotesIniciales = [
  { nombre: 'POTRERO NORTE', hectareas: 7.00, ha_sembrables: 7.00 },
  { nombre: 'POTRERO SUR', hectareas: 8.00, ha_sembrables: 8.00 },
  { nombre: 'CORRALES', hectareas: 1.00, ha_sembrables: 0.00 },
  { nombre: 'MANGA', hectareas: 0.50, ha_sembrables: 0.00 },
  { nombre: 'CAMINO', hectareas: 0.50, ha_sembrables: 0.00 },
  { nombre: 'RESERVA', hectareas: 4.00, ha_sembrables: 4.00 },
];
try {
  const stmtLote = db.prepare('INSERT OR IGNORE INTO lotes (nombre, hectareas, ha_sembrables) VALUES (?,?,?)');
  lotesIniciales.forEach(l => stmtLote.run(l.nombre, l.hectareas, l.ha_sembrables));
} catch(e) { console.warn("⚠️  No pude seedear lotes:", e.message); }

// ── MIGRACIONES ─────────────────────────────────────────────────────────────
try { db.exec(`ALTER TABLE laboreo_items ADD COLUMN ejecutado INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE laboreo_items ADD COLUMN fecha_ejecucion TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE laboreo_items ADD COLUMN notas_ejecucion TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE laboreos ADD COLUMN total_ejecutado REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE orden_items ADD COLUMN etapa TEXT DEFAULT 'GENERAL'`); } catch(e) {}
try { db.exec(`ALTER TABLE ordenes_trabajo ADD COLUMN hectareas REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ordenes_trabajo ADD COLUMN lotes TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE orden_items ADD COLUMN dosis REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE bienes_muebles ADD COLUMN fecha_baja TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE bienes_muebles ADD COLUMN valor_venta REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE stock_ganadero ADD COLUMN registro TEXT DEFAULT 'GENERAL'`); } catch(e) {}
try { db.exec(`ALTER TABLE stock_ganadero ADD COLUMN kg_estimado REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE stock_ganadero ADD COLUMN cantidad_venta REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS diario_campo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campo TEXT DEFAULT 'AMAKAIK',
  fecha TEXT NOT NULL,
  tipo TEXT DEFAULT 'ACONTECIMIENTO',
  mm REAL,
  titulo TEXT,
  detalle TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS tareas_campo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campo TEXT,
  texto TEXT NOT NULL,
  estado TEXT DEFAULT 'PENDIENTE',
  origen TEXT DEFAULT 'web',
  created_at TEXT DEFAULT (datetime('now')),
  done_at TEXT
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS proyeccion_ajustes (
  mes TEXT PRIMARY KEY,
  egreso_estimado REAL,
  ingreso_estimado REAL,
  notas TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}
try { db.exec(`ALTER TABLE lotes ADD COLUMN poligono TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE inversores ADD COLUMN deuda_actual REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE inversores ADD COLUMN fecha_vencimiento TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE inversores ADD COLUMN notas TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE patrimonio_snapshots ADD COLUMN fondo REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE patrimonio_snapshots ADD COLUMN deuda_cheques REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE patrimonio_snapshots ADD COLUMN deuda_cc REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE patrimonio_snapshots ADD COLUMN deuda_inversores REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE stock_productos ADD COLUMN rubro TEXT DEFAULT 'AGRICOLA'`); } catch(e) {}
// Qué implanta la orden. Lo lee ADE para saber si el costo se amortiza (pastura,
// 5 años) o va todo al año (verdeo, fertilización, control). Vacío = no implanta.
try { db.exec(`ALTER TABLE ordenes_trabajo ADD COLUMN tipo_implantacion TEXT`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT, updated_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS patrimonio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ciclo TEXT,
  fecha TEXT,
  caja REAL DEFAULT 0,
  ganado REAL DEFAULT 0,
  bienes REAL DEFAULT 0,
  stock REAL DEFAULT 0,
  total REAL DEFAULT 0,
  notas TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ciclo)
)`); } catch(e) {}
try { db.exec(`UPDATE laboreo_items SET ejecutado=0 WHERE ejecutado IS NULL`); } catch(e) {}
// ── BASE DE CAMPO (multi-campo): lo físico se etiqueta por campo ───────────────
try { db.exec(`CREATE TABLE IF NOT EXISTS campos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  activo INTEGER DEFAULT 1,
  orden INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}
try { db.exec(`INSERT OR IGNORE INTO campos (nombre, orden) VALUES ('AMAKAIK', 0)`); } catch(e) {}
// El bot ganadero guardaba el diario bajo "LA POSTA", nombre que esta pantalla
// nunca consulta: esos registros quedaban invisibles. Se traen al campo real.
try {
  const r = db.prepare("UPDATE diario_campo SET campo = 'AMAKAIK' WHERE campo = 'LA POSTA'").run();
  if (r.changes) console.log(`Diario: ${r.changes} registros movidos de LA POSTA a AMAKAIK`);
} catch(e) {}
try { db.exec(`ALTER TABLE lotes ADD COLUMN campo TEXT DEFAULT 'AMAKAIK'`); } catch(e) {}
try { db.exec(`ALTER TABLE ordenes_trabajo ADD COLUMN campo TEXT DEFAULT 'AMAKAIK'`); } catch(e) {}
try { db.exec(`ALTER TABLE stock_productos ADD COLUMN campo TEXT DEFAULT 'AMAKAIK'`); } catch(e) {}
try { db.exec(`ALTER TABLE bienes_muebles ADD COLUMN campo TEXT DEFAULT 'AMAKAIK'`); } catch(e) {}
// Rellenar los registros viejos (por si la columna quedó en NULL)
try { db.exec(`UPDATE lotes SET campo='AMAKAIK' WHERE campo IS NULL OR campo=''`); } catch(e) {}
try { db.exec(`UPDATE ordenes_trabajo SET campo='AMAKAIK' WHERE campo IS NULL OR campo=''`); } catch(e) {}
try { db.exec(`UPDATE stock_productos SET campo='AMAKAIK' WHERE campo IS NULL OR campo=''`); } catch(e) {}
try { db.exec(`UPDATE bienes_muebles SET campo='AMAKAIK' WHERE campo IS NULL OR campo=''`); } catch(e) {}
try { db.exec(`UPDATE stock_ganadero SET campo='AMAKAIK' WHERE campo IS NULL OR campo=''`); } catch(e) {}

// ── MIGRACIONES v4 → VIDELA (dualidad ARS/kg carne) ────────────────────────
// Estas ALTER TABLE agregan las columnas _kg si no existen (por si ya había DB).
// El CREATE TABLE del schema principal ya las crea; esto es solo para DBs preexistentes.
try { db.exec(`ALTER TABLE transacciones ADD COLUMN ingreso_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE transacciones ADD COLUMN egreso_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE transacciones ADD COLUMN precio_mag REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE transacciones ADD COLUMN semana_mag TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE cheques ADD COLUMN monto_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE cheques ADD COLUMN precio_mag REAL`); } catch(e) {}
try { db.exec(`ALTER TABLE inversores ADD COLUMN capital_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE cc_movimientos ADD COLUMN monto_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE dividendos ADD COLUMN monto_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE bienes_muebles ADD COLUMN valor_compra_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE bienes_muebles ADD COLUMN valor_residual_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE amortizaciones ADD COLUMN monto_ars REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE stock_ganadero ADD COLUMN valor_cabeza_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE stock_productos ADD COLUMN precio_unitario_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE stock_movimientos ADD COLUMN precio_unitario_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ordenes_trabajo ADD COLUMN total_planificado_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ordenes_trabajo ADD COLUMN total_ejecutado_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE orden_items ADD COLUMN precio_unitario_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE orden_items ADD COLUMN total_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE orden_items ADD COLUMN total_ejecutado_kg REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE presupuestos ADD COLUMN monto_anual_ars REAL DEFAULT 0`); } catch(e) {}
// Migraciones defensivas para aportes v2 (compensaciones + intereses)
try { db.exec(`ALTER TABLE aportes_socios ADD COLUMN tipo TEXT NOT NULL DEFAULT 'APORTE'`); } catch(e) {}
try { db.exec(`ALTER TABLE aportes_socios ADD COLUMN grupo_id TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE aportes_socios ADD COLUMN reseteo_intereses INTEGER DEFAULT 0`); } catch(e) {}

console.log('Migraciones aplicadas');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic();
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const ADE_URL = (process.env.ADE_URL || "https://angus-del-este-production.up.railway.app").replace(/\/$/, "");

// ── HELPERS DE SEMANA (lunes a viernes operativos del MAG) ────────────────────
function getISOWeek(date) {
  // Devuelve identificador YYYY-Www estable (ISO-8601, lunes como inicio)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function getRangoSemana(date) {
  // Devuelve {desde, hasta} en formato YYYY-MM-DD para la semana ISO de la fecha dada
  const d = new Date(date);
  const day = d.getDay();
  const diffLunes = day === 0 ? -6 : 1 - day; // domingo = -6, lunes = 0
  const lunes = new Date(d);
  lunes.setDate(d.getDate() + diffLunes);
  const viernes = new Date(lunes);
  viernes.setDate(lunes.getDate() + 4);
  return {
    desde: lunes.toISOString().slice(0, 10),
    hasta: viernes.toISOString().slice(0, 10),
    semana: getISOWeek(lunes)
  };
}

function getSemanaAnterior(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - 7);
  return getRangoSemana(d);
}

function fmtFechaArg(yyyymmdd) {
  // 2026-04-24 → 24/04/2026
  const [y, m, d] = yyyymmdd.split("-");
  return `${d}/${m}/${y}`;
}

// ── SCRAPING MAG ──────────────────────────────────────────────────────────────
// La página devuelve una tabla HTML con filas tipo:
//   | Vi 24/04/2026 | 6.837 | 4.418,815 | ... |
// Estrategia: pedimos un rango de fechas (lun a vie) y promediamos los días
// que tengan índice cerrado.

// ── SCRAPING MAG ──────────────────────────────────────────────────────────────
// Estrategia multi-fuente:
//   1. La Nación (más confiable, nota del cierre del viernes con "promedio semanal de $X")
//   2. Sitio oficial del MAG (fallback, aunque su form de fechas no funciona via URL)
//   3. Si todo falla, devuelve null y se puede cargar manualmente

async function scrapearPrecioMAG(fechaDesde, fechaHasta) {
  console.log(`📡 Intentando obtener MAG para ${fechaDesde} → ${fechaHasta}`);

  // ═══ Estrategia 1: LA NACIÓN (promedio semanal oficial cerrado) ═══════════
  // La Nación publica cada viernes la frase "promedio semanal de $X" que es el
  // VWAP semanal CERRADO y DEFINITIVO calculado por el MAG. Es la fuente más
  // confiable para el dato semanal. Verificado contra datos oficiales del MAG.
  try {
    const resultado = await scrapearLaNacion(fechaDesde, fechaHasta);
    if (resultado) {
      console.log(`✅ La Nación: $${resultado.promedio.toFixed(2)} (${resultado.cabezas} cab)`);
      return resultado;
    }
  } catch (e) {
    console.error(`⚠️ La Nación falló: ${e.message}`);
  }

  // ═══ Estrategia 2: CALCULAR DESDE DIARIOS CACHEADOS (solo si COMPLETOS) ════
  // Si el cron diario guardó precios de la semana, calculamos el VWAP. PERO solo
  // si los datos están completos (sanity check estricto): mínimo 3 días con datos
  // y al menos 10.000 cabezas acumuladas (una semana típica tiene 15-25 mil).
  // Esto evita el bug histórico de usar datos parciales del MAG diario.
  try {
    const sem = { desde: fechaDesde, hasta: fechaHasta, semana: getISOWeek(new Date(fechaDesde + "T12:00:00Z")) };
    const resultado = calcularPromedioSemanalDesdeDiarios(sem);
    if (resultado && resultado.promedio > 0 && resultado.dias >= 3 && resultado.cabezas >= 10000) {
      console.log(`✅ Calculado desde diarios: $${resultado.promedio.toFixed(2)} (${resultado.dias} días, ${resultado.cabezas} cab)`);
      return resultado;
    } else if (resultado) {
      console.log(`⏭️ Diarios incompletos (${resultado.dias} días, ${resultado.cabezas} cab) — no son confiables, sigo a otras fuentes`);
    }
  } catch (e) {
    console.error(`⚠️ Cálculo desde diarios falló: ${e.message}`);
  }

  // ═══ Estrategia 3: API consignatarias.com.ar ═════════════════════════════
  // API REST pública (puede estar desactualizada según vimos)
  try {
    const resultado = await scrapearConsignatariasAPI(fechaDesde, fechaHasta);
    if (resultado) {
      console.log(`✅ API Consignatarias: $${resultado.promedio.toFixed(2)} (${resultado.dias} días)`);
      return resultado;
    }
  } catch (e) {
    console.error(`⚠️ API Consignatarias falló: ${e.message}`);
  }

  // ═══ Estrategia 4: Sitio oficial MAG con rango de fechas ══════════════════
  try {
    const resultado = await scrapearSitioMAG(fechaDesde, fechaHasta);
    if (resultado) {
      console.log(`✅ Sitio MAG: $${resultado.promedio.toFixed(2)}`);
      return resultado;
    }
  } catch (e) {
    console.error(`⚠️ Sitio MAG falló: ${e.message}`);
  }

  console.log(`❌ Ningún scraper pudo obtener el precio MAG`);
  return null;
}

// ── Estrategia 1: API CONSIGNATARIAS.COM.AR ───────────────────────────────────
// API REST pública del INMAG (Índice Novillo Mercado Agroganadero).
// Endpoint: GET /api/market/history?from=YYYY-MM-DD&to=YYYY-MM-DD
// Devuelve serie de precios diarios + estadísticas (min, max, avg, VWAP).
// Es la fuente más confiable porque viene directo del MAG vía API.

async function scrapearConsignatariasAPI(fechaDesde, fechaHasta) {
  const url = `https://www.consignatarias.com.ar/api/market/history?from=${fechaDesde}&to=${fechaHasta}`;
  console.log(`🔗 GET ${url}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "VIDELA-Bot/1.0 (https://videla-production.up.railway.app)"
      }
    });
    clearTimeout(timeoutId);

    console.log(`📡 Respuesta API: HTTP ${resp.status}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();

    // La API puede devolver formato {success:true, data:{series:[...], stats:{...}}}
    // o directamente el array. Manejamos ambos casos.
    const payload = data.data || data;
    const series = payload.series || payload.history || payload.prices || (Array.isArray(payload) ? payload : []);
    const stats = payload.stats || payload.estadisticas || {};

    if (!Array.isArray(series) || series.length === 0) {
      console.log(`⚠️ API devolvió sin series. Payload: ${JSON.stringify(data).substring(0, 300)}`);
      return null;
    }

    // DEBUG: mostrar el primer y último registro para entender estructura
    console.log(`📊 API devolvió ${series.length} registros. Primer registro: ${JSON.stringify(series[0])}`);
    console.log(`📊 Último registro: ${JSON.stringify(series[series.length - 1])}`);
    if (Object.keys(stats).length) {
      console.log(`📊 Stats: ${JSON.stringify(stats).substring(0, 300)}`);
    }

    // Función para extraer fecha de un registro en cualquier formato común
    function extraerFecha(p) {
      const raw = p.fecha || p.date || p.day || p.timestamp || p.created_at || p.dia || p.fecha_hora;
      if (!raw) return null;
      // Normalizar a YYYY-MM-DD
      const s = String(raw);
      // Si viene como "2026-04-27T00:00:00Z" o similar, agarrar los primeros 10
      if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.substring(0, 10);
      // Si viene como "27/04/2026"
      const argMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (argMatch) return `${argMatch[3]}-${argMatch[2]}-${argMatch[1]}`;
      // Si es timestamp Unix
      const tsNum = parseInt(s);
      if (!isNaN(tsNum) && tsNum > 1000000000) {
        const d = new Date(tsNum * (s.length === 10 ? 1000 : 1));
        return d.toISOString().substring(0, 10);
      }
      return null;
    }

    function extraerPrecio(p) {
      const raw = p.precio || p.price || p.value || p.indice || p.indice_novillo || p.inmag || p.cierre || p.close;
      const n = parseFloat(raw);
      return isFinite(n) && n > 0 ? n : null;
    }

    function extraerCabezas(p) {
      const raw = p.cabezas || p.head_count || p.volume || p.volumen || p.ingreso;
      const n = parseInt(raw);
      return isFinite(n) ? n : 0;
    }

    // Filtrar al rango pedido
    const filtrados = series.filter(p => {
      const f = extraerFecha(p);
      if (!f) return false;
      return f >= fechaDesde && f <= fechaHasta;
    });

    if (!filtrados.length) {
      // Si no hay datos en el rango, mostramos las fechas disponibles cercanas
      const fechasDisponibles = series
        .map(p => extraerFecha(p))
        .filter(f => f && f >= fechaDesde.substring(0, 7))  // mismo mes o posterior
        .slice(0, 10);
      console.log(`⚠️ API: sin datos en rango ${fechaDesde} → ${fechaHasta}. Disponibles: ${series.length}. Fechas cercanas: ${JSON.stringify(fechasDisponibles)}`);
      return null;
    }

    console.log(`✅ Filtrados ${filtrados.length} días en rango`);

    // Calcular promedio ponderado por cabezas (VWAP)
    let totalKgPond = 0;
    let totalCabezas = 0;
    let validos = 0;
    const detalle = [];

    for (const p of filtrados) {
      const precio = extraerPrecio(p);
      const cab = extraerCabezas(p);
      if (precio && precio > 0) {
        validos++;
        if (cab > 0) {
          totalKgPond += precio * cab;
          totalCabezas += cab;
        }
        detalle.push({
          fecha: extraerFecha(p),
          indice: precio,
          cabezas: cab
        });
      }
    }

    if (!validos) {
      console.log(`⚠️ API: registros encontrados pero sin precios válidos`);
      return null;
    }

    // Si tenemos cabezas, usamos VWAP. Si no, promedio simple.
    let promedio;
    if (totalCabezas > 0) {
      promedio = totalKgPond / totalCabezas;
      console.log(`📊 VWAP: $${promedio.toFixed(2)} (${totalCabezas} cabezas, ${validos} días)`);
    } else {
      const sumaSimple = detalle.reduce((s, d) => s + d.indice, 0);
      promedio = sumaSimple / detalle.length;
      console.log(`📊 Promedio simple: $${promedio.toFixed(2)} (${validos} días, sin datos de cabezas)`);
    }

    return {
      promedio,
      cabezas: totalCabezas,
      dias: validos,
      fuente: "consignatarias-api",
      detalle
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") throw new Error("timeout 20s");
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCRAPERS DIARIOS — Obtienen el INMAG del DÍA ACTUAL desde 3 fuentes distintas
// Se ejecutan cada día hábil a las 18 hs. Guardan en tabla precios_mag_diario.
// Al final de cada semana (cron del lunes), se calcula el promedio ponderado
// y se guarda en precios_mag.
// ═══════════════════════════════════════════════════════════════════════════════

const UA_NAVEGADOR = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Helper: parser robusto de número argentino.
// El formato argentino usa "." como separador de miles y "," como decimal:
//   "4.211,453" → 4211.453
//   "22.883"    → 22883     (sin coma → es entero con miles)
//   "1.108.243.200,00" → 1108243200
// PERO algunos sitios escriben puntos como decimales tipo "4.18":
//   regla: si después del último punto hay exactamente 3 dígitos, es separador
//   de miles; si hay 1, 2 o 4+ dígitos, es decimal.
function parseArNumber(s) {
  if (s === null || s === undefined) return NaN;
  const limpio = String(s).trim().replace(/\$/g, "").replace(/\s/g, "");
  if (!limpio) return NaN;

  // Tiene coma → la coma es siempre decimal en ARG
  if (limpio.includes(",")) {
    return parseFloat(limpio.replace(/\./g, "").replace(",", "."));
  }

  // No tiene coma. Caso especial: solo dígitos sin punto.
  if (!limpio.includes(".")) return parseFloat(limpio);

  // Tiene puntos pero no coma. Heurística: si TODOS los segmentos
  // después de puntos tienen exactamente 3 dígitos, son separadores de miles.
  // Si el último segmento tiene !=3 dígitos, es separador decimal en formato US.
  const partes = limpio.split(".");
  const ultimaParte = partes[partes.length - 1];

  if (ultimaParte.length === 3 && partes.length >= 2) {
    // Verificar que TODAS las partes intermedias tengan 3 dígitos también
    const todasMiles = partes.slice(1).every(p => p.length === 3);
    if (todasMiles) {
      return parseFloat(limpio.replace(/\./g, ""));  // separador de miles → entero
    }
  }

  // Es decimal formato US ("4.18") o "12.5"
  return parseFloat(limpio);
}

// Helpers más específicos para validación
function parsearEnteroAr(s) {
  // Para cabezas, kilos totales: debería ser entero o casi entero
  const n = parseArNumber(s);
  if (!isFinite(n)) return NaN;
  return Math.round(n);
}

function parsearImporteAr(s) {
  // Para importes en pesos: pueden tener centavos pero suelen ser >>1000
  const n = parseArNumber(s);
  return isFinite(n) ? n : NaN;
}

// Sanity check de un dato diario antes de guardarlo.
// Valida coherencia: índice razonable, kg/cabezas con proporción realista, etc.
function validarDatoDiario({ indice, cabezas, importeTotal, kgTotal, fuente }) {
  // 1. Índice debe estar en rango razonable ($1000 - $20000/kg)
  if (!isFinite(indice) || indice < 1000 || indice > 20000) {
    return { ok: false, razon: `índice fuera de rango razonable (${indice})` };
  }

  // 2. Si hay datos de kg/cabezas, validar proporción (un novillo pesa 300-700 kg)
  if (kgTotal > 0 && cabezas > 0) {
    const kgPorCabeza = kgTotal / cabezas;
    if (kgPorCabeza < 50 || kgPorCabeza > 2000) {
      return { ok: false, razon: `proporción kg/cabezas anormal (${kgPorCabeza.toFixed(1)} kg/cab para ${cabezas} cab y ${kgTotal} kg). Probable error de parsing.` };
    }
  }

  // 3. Si hay importe total, validar consistencia con kg × precio
  if (importeTotal > 0 && kgTotal > 0) {
    const precioImplicito = importeTotal / kgTotal;
    const ratioError = Math.abs(precioImplicito - indice) / indice;
    if (ratioError > 0.05) {  // más del 5% de diferencia
      return { ok: false, razon: `inconsistencia importe/kg (${precioImplicito.toFixed(2)}) vs índice (${indice.toFixed(2)}). Error ${(ratioError*100).toFixed(1)}%` };
    }
  }

  // 4. Datos mínimos: al menos 100 cabezas para que el promedio tenga sentido
  // (las fuentes oficiales no calculan INMAG cuando hay menos de 300 cabezas)
  if (cabezas > 0 && cabezas < 100) {
    return { ok: false, razon: `muy pocas cabezas (${cabezas}) — el INMAG oficial requiere mínimo 300` };
  }

  return { ok: true };
}

// ── Scraper diario 1: MAG hacienda1.dll/haciinfo000002 ────────────────────────
// Es la fuente más oficial: el sitio del MAG publica los precios del día con
// detalle por categoría. La línea "NOVILLOS" (suma de mestizos + regulares + overos)
// trae el INMAG ponderado del día.
async function scrapearMAGDiario() {
  const url = "https://www.mercadoagroganadero.com.ar/dll/hacienda1.dll/haciinfo000002";
  console.log(`🔗 [MAG-diario] ${url}`);

  const resp = await fetch(url, {
    headers: { "User-Agent": UA_NAVEGADOR, "Accept-Language": "es-AR,es;q=0.9" }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  // Detectar la fecha del informe: "Mercado Agroganadero S.A. 17:44 martes 5 de mayo de 2026"
  const fechaMatch = html.match(/(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})/i);
  let fechaDia;
  if (fechaMatch) {
    const meses = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12 };
    const d = String(fechaMatch[1]).padStart(2,"0");
    const m = String(meses[fechaMatch[2].toLowerCase()]).padStart(2,"0");
    fechaDia = `${fechaMatch[3]}-${m}-${d}`;
  } else {
    fechaDia = new Date().toISOString().slice(0,10);
  }

  // El INMAG es el subtotal después de las filas NOVILLOS (mestizos, regulares, overos)
  // Buscamos el patrón: filas NOVILLOS → línea de "------- ... -------- ... número (INMAG)"
  // El INMAG aparece como: <td>4.211,453</td> en la línea que viene después de 7 filas NOVILLOS

  // Estrategia robusta: agarramos TODAS las filas NOVILLOS y calculamos el promedio
  // ponderado nosotros (igual hace el MAG)
  const regexFila = /<tr[^>]*>\s*<td[^>]*>\s*(NOVILLOS\s+[^<]+?)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*\$([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>/gi;

  let m;
  let cabezas = 0;
  let importeTotal = 0;
  let kgTotal = 0;
  let filasEncontradas = 0;

  while ((m = regexFila.exec(html)) !== null) {
    const [, nombre, , , promedio, , cab, importe, kg] = m;
    // Solo filas de NOVILLOS (no novillitos, vaquillonas, etc.)
    if (!/^NOVILLOS\s/i.test(nombre)) continue;

    const cabNum = parseArNumber(cab);
    const importeNum = parseArNumber(importe);
    const kgNum = parseArNumber(kg);
    const promNum = parseArNumber(promedio);

    if (isFinite(cabNum) && isFinite(importeNum) && isFinite(kgNum) && cabNum > 0) {
      cabezas += cabNum;
      importeTotal += importeNum;
      kgTotal += kgNum;
      filasEncontradas++;
      console.log(`   ${nombre.trim()}: ${cabNum} cab, prom $${promNum.toFixed(2)}`);
    }
  }

  if (!filasEncontradas || kgTotal === 0) {
    console.log(`⚠️ [MAG-diario] No se encontraron filas NOVILLOS válidas`);
    return null;
  }

  const indiceNovillo = importeTotal / kgTotal;

  // SANITY CHECK: validar coherencia de los datos parseados
  const sanity = validarDatoDiario({ indice: indiceNovillo, cabezas, importeTotal, kgTotal, fuente: "mag-hacienda1" });
  if (!sanity.ok) {
    console.log(`⚠️ [MAG-diario] Datos rechazados: ${sanity.razon}`);
    return null;
  }

  console.log(`✅ [MAG-diario] ${fechaDia} INMAG=$${indiceNovillo.toFixed(3)} (${cabezas} cab, ${filasEncontradas} categorías)`);

  return {
    fecha: fechaDia,
    indice: indiceNovillo,
    cabezas,
    importeTotal,
    kgTotal,
    fuente: "mag-hacienda1"
  };
}

// ── Scraper diario 2: deCampoaCampo ───────────────────────────────────────────
// La página principal muestra "Arrendamiento: 4.211,45" — ese es el INMAG del día.
async function scrapearDeCampoaCampo() {
  const url = "https://www.decampoacampo.com/__dcac/outside/canuelas/precios";
  console.log(`🔗 [deCampoaCampo] ${url}`);

  const resp = await fetch(url, {
    headers: { "User-Agent": UA_NAVEGADOR, "Accept-Language": "es-AR,es;q=0.9" }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  // Buscar bloque "Arrendamiento" seguido del valor
  // Patrón observado: <strong>4.211,45</strong> ... Arrendamiento
  const arrMatch = html.match(/Arrendamiento[\s\S]{0,400}?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i)
    || html.match(/<strong[^>]*>\s*([\d.,]+)\s*<\/strong>[\s\S]{0,200}?Arrendamiento/i);

  // Buscar también el ingreso (cabezas)
  const ingMatch = html.match(/Ingreso[\s\S]{0,400}?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i)
    || html.match(/<strong[^>]*>\s*([\d.,]+)\s*<\/strong>[\s\S]{0,200}?Ingreso/i);

  if (!arrMatch) {
    console.log(`⚠️ [deCampoaCampo] No se encontró valor de Arrendamiento`);
    return null;
  }

  const indice = parseArNumber(arrMatch[1]);
  const cabezas = ingMatch ? parseInt(parseArNumber(ingMatch[1])) || 0 : 0;

  if (!isFinite(indice) || indice <= 0) {
    console.log(`⚠️ [deCampoaCampo] Valor inválido: ${arrMatch[1]}`);
    return null;
  }

  const fechaDia = new Date().toISOString().slice(0,10);
  console.log(`✅ [deCampoaCampo] ${fechaDia} INMAG=$${indice.toFixed(3)} (${cabezas} cab)`);

  return {
    fecha: fechaDia,
    indice,
    cabezas,
    importeTotal: 0,
    kgTotal: 0,
    fuente: "decampoacampo"
  };
}

// ── Scraper diario 3: ganaderiaynegocios.com ──────────────────────────────────
// Tabla con todas las categorías. Calculamos el INMAG sumando filas NOVILLOS.
async function scrapearGanaderiaYNegocios() {
  const url = "https://ganaderiaynegocios.com/precios-mercado-agroganadero-canuelas/";
  console.log(`🔗 [GyN] ${url}`);

  const resp = await fetch(url, {
    headers: { "User-Agent": UA_NAVEGADOR, "Accept-Language": "es-AR,es;q=0.9" }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  // Detectar fecha
  const fechaMatch = html.match(/Datos correspondientes a:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  let fechaDia;
  if (fechaMatch) {
    const d = String(fechaMatch[1]).padStart(2,"0");
    const m = String(fechaMatch[2]).padStart(2,"0");
    fechaDia = `${fechaMatch[3]}-${m}-${d}`;
  } else {
    fechaDia = new Date().toISOString().slice(0,10);
  }

  // La tabla es: Categoría | Min | Max | Prom | Mediana | Cabezas | Importe | Kg Total | Kg Prom
  // Buscamos filas que empiezan con "NOVILLOS"
  // En HTML típico: <tr><td>NOVILLOS Mest.EyB + 520</td><td>3,650</td>...
  const regexFila = /<tr[^>]*>\s*<td[^>]*>\s*(NOVILLOS[^<]+?)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+)\s*<\/td>/gi;

  let m;
  let cabezas = 0;
  let importeTotal = 0;
  let kgTotal = 0;
  let filasEncontradas = 0;

  while ((m = regexFila.exec(html)) !== null) {
    const [, nombre, , , prom, , cab, importe, kgT] = m;
    if (!/^NOVILLOS\s/i.test(nombre)) continue;

    const cabNum = parseArNumber(cab);
    const importeNum = parseArNumber(importe);
    const kgNum = parseArNumber(kgT);
    const promNum = parseArNumber(prom);

    if (isFinite(cabNum) && isFinite(importeNum) && isFinite(kgNum) && cabNum > 0 && kgNum > 0) {
      cabezas += cabNum;
      importeTotal += importeNum;
      kgTotal += kgNum;
      filasEncontradas++;
      console.log(`   ${nombre.trim()}: ${cabNum} cab, prom $${promNum.toFixed(2)}`);
    }
  }

  if (!filasEncontradas || kgTotal === 0) {
    console.log(`⚠️ [GyN] No se encontraron filas NOVILLOS válidas`);
    return null;
  }

  const indiceNovillo = importeTotal / kgTotal;

  // SANITY CHECK
  const sanity = validarDatoDiario({ indice: indiceNovillo, cabezas, importeTotal, kgTotal, fuente: "ganaderiaynegocios" });
  if (!sanity.ok) {
    console.log(`⚠️ [GyN] Datos rechazados: ${sanity.razon}`);
    return null;
  }

  console.log(`✅ [GyN] ${fechaDia} INMAG=$${indiceNovillo.toFixed(3)} (${cabezas} cab, ${filasEncontradas} categorías)`);

  return {
    fecha: fechaDia,
    indice: indiceNovillo,
    cabezas,
    importeTotal,
    kgTotal,
    fuente: "ganaderiaynegocios"
  };
}

// ── Función orquestadora: scrapea el INMAG del día desde múltiples fuentes ────
async function scrapearINMAGDelDia() {
  const fuentes = [
    { nombre: "MAG hacienda1", fn: scrapearMAGDiario },
    { nombre: "Ganadería y Negocios", fn: scrapearGanaderiaYNegocios },
    { nombre: "deCampoaCampo", fn: scrapearDeCampoaCampo },
  ];

  for (const f of fuentes) {
    try {
      const r = await f.fn();
      if (r && r.indice && r.indice > 0) {
        return r;
      }
    } catch (e) {
      console.log(`⚠️ [${f.nombre}] falló: ${e.message}`);
    }
  }

  return null;
}

// ── Función: calcular promedio semanal desde diarios guardados ────────────────
// Toma los precios diarios de la semana cerrada, calcula el promedio ponderado
// (igual que hace el MAG), y guarda en precios_mag.
function calcularPromedioSemanalDesdeDiarios(semanaInfo) {
  const diarios = db.prepare(
    "SELECT * FROM precios_mag_diario WHERE fecha BETWEEN ? AND ? ORDER BY fecha"
  ).all(semanaInfo.desde, semanaInfo.hasta);

  if (!diarios.length) {
    console.log(`⚠️ [Semana ${semanaInfo.semana}] Sin datos diarios para calcular promedio`);
    return null;
  }

  let cabezasTotal = 0;
  let importeTotal = 0;
  let kgTotal = 0;
  let promediosSimples = [];

  for (const d of diarios) {
    if (d.cabezas > 0 && d.kg_total > 0 && d.importe_total > 0) {
      cabezasTotal += d.cabezas;
      importeTotal += d.importe_total;
      kgTotal += d.kg_total;
    }
    promediosSimples.push(d.indice_novillo);
  }

  let promedio;
  if (kgTotal > 0) {
    // VWAP (volume weighted average price) — más preciso
    promedio = importeTotal / kgTotal;
    console.log(`📊 [Semana ${semanaInfo.semana}] VWAP $${promedio.toFixed(3)} (${cabezasTotal} cab, ${diarios.length} días)`);
  } else {
    // Promedio simple si no tenemos importe/kg
    promedio = promediosSimples.reduce((s, v) => s + v, 0) / promediosSimples.length;
    console.log(`📊 [Semana ${semanaInfo.semana}] Promedio simple $${promedio.toFixed(3)} (${diarios.length} días)`);
  }

  return {
    promedio,
    cabezas: cabezasTotal,
    dias: diarios.length,
    fuente: "calculado-diarios",
    detalle: diarios.map(d => ({ fecha: d.fecha, indice: d.indice_novillo, cabezas: d.cabezas }))
  };
}

// ── Estrategia 1: LA NACIÓN ───────────────────────────────────────────────────
// Las notas de La Nación tienen URLs tipo:
//   /economia/campo/vacunos-cierre-de-semana-...-nidDDMMYYYY/
// Donde DD es el día del viernes del cierre. Usamos DuckDuckGo para encontrar
// la nota más reciente (sin pagar Google), y de ahí parseamos.

async function scrapearLaNacion(fechaDesde, fechaHasta) {
  const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // ── Construir múltiples fechas candidatas ──
  // El cierre semanal NORMALMENTE se publica el viernes, pero:
  //  - Si el viernes es feriado, puede ser el jueves
  //  - Si es lunes feriado o problemas, puede ser el lunes/martes siguiente
  // Así que probamos varios días alrededor del fin de semana.
  const desdeDate = new Date(fechaDesde + "T12:00:00Z"); // mediodía UTC para evitar problemas de zona horaria
  const fechasCandidatas = [];
  // Lunes(0) Mar(1) Mie(2) Jue(3) Vie(4) → la semana objetivo
  // Probamos: jueves (3), viernes (4) — días del cierre normal
  // Y también: lunes siguiente (7), martes siguiente (8) — por si publicaron retrasado
  for (const offset of [4, 3, 7, 8, 5, 6]) {
    const d = new Date(desdeDate);
    d.setDate(desdeDate.getDate() + offset);
    fechasCandidatas.push(d);
  }

  // ── Templates conocidos del título de las notas de La Nación ──
  const slugTemplates = [
    "vacunos-cierre-de-semana-en-positivo-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-semana-en-baja-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-semana-con-leves-alzas-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-semana-con-altibajos-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-semana-en-alza-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-mes-con-demanda-tranquila-y-precios-estables-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-mes-en-positivo-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-mes-en-baja-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-mes-con-altibajos-en-el-mercado-agroganadero-de-canuelas",
    "vacunos-cierre-de-mes-en-alza-en-el-mercado-agroganadero-de-canuelas",
  ];

  // ── Intento 1: URLs directas combinando fechas × templates ──
  // Limitamos a las primeras 30 combinaciones para no demorar mucho
  let intentos = 0;
  for (const fecha of fechasCandidatas) {
    const ddmmyyyy = `${String(fecha.getDate()).padStart(2,"0")}${String(fecha.getMonth()+1).padStart(2,"0")}${fecha.getFullYear()}`;
    for (const slug of slugTemplates) {
      if (intentos++ >= 30) break;
      const url = `https://www.lanacion.com.ar/economia/campo/${slug}-nid${ddmmyyyy}/`;
      try {
        const datos = await intentarParsearLaNacion(url, userAgent, fecha);
        if (datos) {
          console.log(`✅ La Nación encontró nota: ${url}`);
          return datos;
        }
      } catch (e) {}
    }
    if (intentos >= 30) break;
  }

  // ── Intento 2: Scrapear el LISTADO del tag "canuelas" de La Nación ──
  // La Nación tiene una página que lista todas las notas con tag "Cañuelas"
  // Esto trae las últimas notas sin importar el título
  console.log(`🔍 Buscando notas recientes en el tag de La Nación...`);
  const tagsListado = [
    "https://www.lanacion.com.ar/tema/canuelas-tid56983/",
    "https://www.lanacion.com.ar/tema/mercado-agroganadero-tid61322/",
  ];

  for (const tagUrl of tagsListado) {
    try {
      const resp = await fetch(tagUrl, { headers: { "User-Agent": userAgent } });
      if (!resp.ok) {
        console.log(`   ${tagUrl} → HTTP ${resp.status}`);
        continue;
      }
      const html = await resp.text();

      // Sacar las URLs de las notas listadas (ordenadas por más nueva primero)
      const urlsListado = [...html.matchAll(/href="(\/economia\/campo\/[^"]*-nid\d{8}\/?)"/g)]
        .map(m => `https://www.lanacion.com.ar${m[1]}`)
        .filter((u, i, arr) => arr.indexOf(u) === i)
        .slice(0, 8);

      console.log(`🔍 ${tagUrl} → ${urlsListado.length} URLs encontradas`);

      for (const url of urlsListado) {
        try {
          const datos = await intentarParsearLaNacion(url, userAgent, null);
          if (datos) {
            console.log(`✅ Encontrada en listado: ${url}`);
            return datos;
          }
        } catch (e) {}
      }
    } catch (e) {
      console.log(`   ${tagUrl} → ${e.message}`);
    }
  }

  // ── Intento 3: Búsqueda en Google (HTML público) ──
  console.log(`🔍 Buscando en Google...`);
  const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const viernes = fechasCandidatas[0];
  const queryGoogle = `site:lanacion.com.ar mercado agroganadero cañuelas ${meses[viernes.getMonth()]} ${viernes.getFullYear()}`;
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(queryGoogle)}&hl=es`;

  try {
    const resp = await fetch(googleUrl, {
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "es-AR,es;q=0.9"
      }
    });
    if (!resp.ok) throw new Error(`Google HTTP ${resp.status}`);
    const html = await resp.text();

    const urlsEncontradas = [...html.matchAll(/https?:\/\/(?:www\.)?lanacion\.com\.ar\/economia\/campo\/[^"\s<>&]*nid\d+[\/]?/gi)]
      .map(m => m[0].replace(/&amp;.*$/, ""))
      .filter((url, i, arr) => arr.indexOf(url) === i);

    console.log(`🔍 Google encontró ${urlsEncontradas.length} URLs`);
    for (const url of urlsEncontradas.slice(0, 5)) {
      try {
        const datos = await intentarParsearLaNacion(url, userAgent, null);
        if (datos) {
          console.log(`✅ Encontrada vía Google: ${url}`);
          return datos;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error(`⚠️ Google falló: ${e.message}`);
  }

  return null;
}

async function intentarParsearLaNacion(url, userAgent, viernesObjetivo) {
  console.log(`🔗 Probando: ${url}`);
  const resp = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!resp.ok) {
    console.log(`   HTTP ${resp.status}`);
    return null;
  }
  const html = await resp.text();
  console.log(`   📄 ${html.length} bytes`);

  // Patrón principal: "promedio semanal de $X.XXX,XXX"
  // En todas las notas de La Nación aparece la frase exacta:
  //   "el Índice Novillo del Mercado Agroganadero quedó en $X con un promedio semanal de $Y"
  // Buscamos el "promedio semanal" que viene DESPUÉS de "Índice Novillo" para
  // asegurarnos de que es el del novillo y no el del índice general.
  let promedio = null;

  // Intento 1: el más específico — "Índice Novillo ... promedio semanal de $Y"
  const matchNovillo = html.match(/[ÍI]ndice\s+Novillo[\s\S]{0,200}?promedio\s+semanal\s+de\s+\$?\s*([\d.]+,\d+)/i);
  if (matchNovillo) {
    promedio = parseFloat(matchNovillo[1].replace(/\./g, "").replace(",", "."));
  }

  // Intento 2: genérico — primer "promedio semanal de $X" que aparezca
  if (!promedio || !isFinite(promedio) || promedio <= 0) {
    const matchPromedio = html.match(/promedio\s+semanal\s+de\s+\$?\s*([\d.]+,\d+)/i);
    if (matchPromedio) {
      promedio = parseFloat(matchPromedio[1].replace(/\./g, "").replace(",", "."));
    }
  }

  if (!promedio || !isFinite(promedio) || promedio <= 0) {
    console.log(`   ⚠️ No matchea patrón "promedio semanal de $X"`);
    return null;
  }

  // Validación de rango razonable
  if (promedio < 1000 || promedio > 20000) {
    console.log(`   ⚠️ Promedio fuera de rango: ${promedio}`);
    return null;
  }

  // Extraer cabezas del acumulado semanal
  let cabezas = null;
  const matchCab = html.match(/acumulado\s+semanal\s+de\s+([\d.]+)\s+animales/i);
  if (matchCab) {
    cabezas = parseInt(matchCab[1].replace(/\./g, ""));
  }

  // Validación de coherencia: el acumulado semanal debería ser > 5.000 cabezas
  // (una semana típica tiene 15.000-25.000). Si es muy bajo, puede ser un parseo raro.
  if (cabezas !== null && cabezas < 5000) {
    console.log(`   ⚠️ Acumulado semanal sospechosamente bajo: ${cabezas} cab. Verificar.`);
    // No lo rechazamos pero lo logueamos — el promedio puede estar bien igual
  }

  console.log(`   ✅ Promedio semanal: $${promedio.toFixed(3)} (${cabezas || "?"} cabezas)`);

  return {
    promedio,
    cabezas: cabezas || 0,
    dias: 5, // promedio semanal completo
    fuente: "lanacion",
    url
  };
}

// ── Estrategia 2: SITIO OFICIAL MAG (fallback) ────────────────────────────────
async function scrapearSitioMAG(fechaDesde, fechaHasta) {
  const desdeArg = fmtFechaArg(fechaDesde);
  const hastaArg = fmtFechaArg(fechaHasta);
  const url = `https://www.mercadoagroganadero.com.ar/dll/hacienda2.dll/haciinfo000013?fecha_inicial=${encodeURIComponent(desdeArg)}&fecha_final=${encodeURIComponent(hastaArg)}`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-AR,es;q=0.9"
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  const datos = parsearTablaMAG(html);
  if (datos) datos.fuente = "mag-oficial";
  return datos;
}

function parsearTablaMAG(html) {
  // Buscamos filas tipo:
  //   <tr><td>Vi 24/04/2026</td><td>6.837</td><td>4.418,815</td>...
  // Devolvemos array de {fecha, cabezas, indice}
  const filas = [];

  // Match de filas con fecha tipo "Lu 21/04/2026" seguida de números
  const regexFila = /<tr[^>]*>\s*<td[^>]*>\s*[A-Za-zÁÉÍÓÚáéíóú]{2,3}\s+(\d{2}\/\d{2}\/\d{4})\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>\s*<td[^>]*>\s*([\d.,]*)\s*<\/td>\s*<td[^>]*>\s*([\d.,]+|Falta Cerrar|NAN)\s*<\/td>/gi;

  let m;
  while ((m = regexFila.exec(html)) !== null) {
    const [, fechaArg, cabezasStr, , indiceStr] = m;
    if (indiceStr === "Falta Cerrar" || indiceStr === "NAN") continue;

    // Argentina: punto = miles, coma = decimales → "4.418,815" → 4418.815
    const indice = parseFloat(indiceStr.replace(/\./g, "").replace(",", "."));
    const cabezas = parseInt(cabezasStr.replace(/\./g, ""));
    if (!isFinite(indice) || indice <= 0) continue;

    const [d, mes, y] = fechaArg.split("/");
    filas.push({
      fecha: `${y}-${mes}-${d}`,
      cabezas,
      indice
    });
  }

  if (!filas.length) return null;

  // Promedio ponderado por cabezas
  const totalCabezas = filas.reduce((s, f) => s + f.cabezas, 0);
  const sumaPond = filas.reduce((s, f) => s + f.indice * f.cabezas, 0);
  const promedio = totalCabezas > 0 ? sumaPond / totalCabezas : null;

  return {
    promedio,
    cabezas: totalCabezas,
    dias: filas.length,
    detalle: filas
  };
}

// ── PRECIO MAG (semana actual de referencia) ──────────────────────────────────
// La regla del usuario: cuando se carga un movimiento, se usa el promedio de
// la SEMANA ANTERIOR (semana cerrada). Si hoy es martes, uso lun-vie de la
// semana pasada. Si hoy es lunes, también la pasada (la actual aún no cerró).

async function getPrecioReferencia(fecha) {
  // fecha = YYYY-MM-DD del movimiento → devolver {precio, semana} de la
  // semana anterior a esa fecha.
  const fechaDate = fecha ? new Date(fecha) : new Date();
  const semAnt = getSemanaAnterior(fechaDate);

  // Buscar en cache
  let row = db.prepare("SELECT * FROM precios_mag WHERE semana = ?").get(semAnt.semana);
  if (row) return { precio: row.precio_promedio, semana: row.semana, cabezas: row.cabezas };

  // No está en cache → scrapear
  console.log(`📡 Scrapeando MAG para semana ${semAnt.semana} (${semAnt.desde} a ${semAnt.hasta})...`);
  const datos = await scrapearPrecioMAG(semAnt.desde, semAnt.hasta);
  if (!datos || !datos.promedio) {
    console.warn(`⚠️ No se pudo obtener precio MAG para ${semAnt.semana}`);
    // Fallback: último precio guardado
    const ultimo = db.prepare("SELECT * FROM precios_mag ORDER BY semana DESC LIMIT 1").get();
    if (ultimo) {
      console.log(`Usando último precio disponible: ${ultimo.semana} = $${ultimo.precio_promedio}`);
      return { precio: ultimo.precio_promedio, semana: ultimo.semana, cabezas: ultimo.cabezas, fallback: true };
    }
    return null;
  }

  // SANITY CHECK FINAL: una semana válida del MAG tiene mínimo ~8.000 cabezas.
  // Si tenemos menos, es muy probable que sea un cálculo parcial (datos diarios
  // incompletos sumados). Mejor NO guardar y forzar carga manual o reintentar.
  // Si La Nación devuelve cabezas=0 (no las parsea) lo consideramos OK porque
  // el promedio viene oficial pre-calculado.
  const cabezasMinimas = 8000;
  if (datos.fuente !== "lanacion" && datos.cabezas > 0 && datos.cabezas < cabezasMinimas) {
    console.warn(`🚫 RECHAZADO: ${semAnt.semana} con solo ${datos.cabezas} cab (mínimo ${cabezasMinimas}). Datos probablemente parciales. NO se guarda.`);
    // Devolver el último precio bueno como fallback, sin guardar el malo
    const ultimo = db.prepare("SELECT * FROM precios_mag ORDER BY semana DESC LIMIT 1").get();
    if (ultimo) {
      return { precio: ultimo.precio_promedio, semana: ultimo.semana, cabezas: ultimo.cabezas, fallback: true };
    }
    return null;
  }

  // Guardar
  db.prepare(`
    INSERT OR REPLACE INTO precios_mag (semana, fecha_desde, fecha_hasta, precio_promedio, cabezas, fuente)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(semAnt.semana, semAnt.desde, semAnt.hasta, datos.promedio, datos.cabezas, datos.fuente || 'scraping');

  console.log(`✅ Precio MAG ${semAnt.semana}: $${datos.promedio.toFixed(2)} ARS/kg (${datos.cabezas} cab, ${datos.dias} días, fuente: ${datos.fuente})`);
  return { precio: datos.promedio, semana: semAnt.semana, cabezas: datos.cabezas, fuente: datos.fuente };
}

// Versión sincrónica: solo lee cache, no scrapea. Usada por endpoints rápidos
// (registrar retiros, etc) donde no queremos bloquear la respuesta esperando red.
function getPrecioReferenciaSync(fecha) {
  const fechaDate = fecha ? new Date(fecha) : new Date();
  const semAnt = getSemanaAnterior(fechaDate);
  const row = db.prepare("SELECT * FROM precios_mag WHERE semana = ?").get(semAnt.semana);
  if (row) return { precio: row.precio_promedio, semana: row.semana, cabezas: row.cabezas };
  // Fallback: último precio guardado
  const ultimo = db.prepare("SELECT * FROM precios_mag ORDER BY semana DESC LIMIT 1").get();
  if (ultimo) return { precio: ultimo.precio_promedio, semana: ultimo.semana, cabezas: ultimo.cabezas, fallback: true };
  return null;
}

// Cron: cada lunes a las 9am, scrapea la semana que terminó el viernes pasado
function scheduleScrapingMAG() {
  let ultimoIntentoExitoso = null;

  // ═══ CICLO DIARIO ═════════════════════════════════════════════════════════
  // Intenta scrapear el INMAG del DÍA actual desde las 3 fuentes nuevas.
  // Se ejecuta cada hora. Si ya tenemos datos del día, no hace nada (no spamea).
  // Si no tenemos, intenta. La idea es que durante el día hábil, alguna llamada
  // entre las 17 y 22 hs caiga después del cierre del MAG (que cierra ~17 hs).
  //
  // IMPORTANTE: Railway corre en UTC. Argentina es UTC-3.
  // Si decimos "20 hs Argentina", en UTC son las 23 hs.
  // Usamos un helper que SIEMPRE devuelve la hora local de Argentina,
  // independientemente del timezone del servidor.
  function getAhoraAR() {
    // Devuelve {date, hour, day, dayOfWeek} en zona Argentina
    const now = new Date();
    // Argentina = UTC-3 (no tiene DST desde 2009)
    const argMs = now.getTime() - (3 * 60 * 60 * 1000);
    const argDate = new Date(argMs);
    return {
      raw: argDate,
      iso: argDate.toISOString().slice(0, 10), // YYYY-MM-DD
      hour: argDate.getUTCHours(),              // 0-23 en hora Argentina
      day: argDate.getUTCDate(),                // día del mes
      dayOfWeek: argDate.getUTCDay()            // 0=dom 6=sab
    };
  }

  async function intentarScrapeDiario() {
    const ar = getAhoraAR();
    const hoy = ar.iso;

    // Solo días hábiles (lun-vie). Sábado y domingo no opera el MAG.
    if (ar.dayOfWeek === 0 || ar.dayOfWeek === 6) return;

    // Solo intentar después de las 20 hs ARGENTINA (cuando el MAG cerró totalmente
    // y publicó datos finales). El MAG opera durante el día y termina ~17-18h
    // pero los datos finales se consolidan después.
    if (ar.hour < 20) return;

    // ¿Ya tenemos el dato del día con datos COMPLETOS?
    // Una semana típica tiene 15-25 mil cabezas en 3-4 días con índice válido.
    // Eso da ~5.000-8.000 cabezas por día. Si tenemos menos de 5.000, es parcial.
    const yaTenemos = db.prepare("SELECT fecha, cabezas FROM precios_mag_diario WHERE fecha = ?").get(hoy);
    if (yaTenemos && yaTenemos.cabezas >= 5000) return;  // dato completo, no tocar

    if (yaTenemos) {
      console.log(`🐂 [Cron diario] Re-intentando ${hoy} (dato anterior incompleto: ${yaTenemos.cabezas} cab)`);
    } else {
      console.log(`🐂 [Cron diario] Intentando obtener INMAG del ${hoy} (hora AR ${ar.hour}h)...`);
    }

    try {
      const r = await scrapearINMAGDelDia();
      if (r && r.indice > 0) {
        // Sólo guardar si tenemos más cabezas que el dato anterior (evita pisar dato bueno con incompleto)
        if (!yaTenemos || r.cabezas > yaTenemos.cabezas) {
          db.prepare(`
            INSERT OR REPLACE INTO precios_mag_diario
            (fecha, indice_novillo, cabezas, importe_total, kg_total, fuente)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(r.fecha, r.indice, r.cabezas || 0, r.importeTotal || 0, r.kgTotal || 0, r.fuente);
          console.log(`✅ [Cron diario] ${r.fecha} INMAG=$${r.indice.toFixed(3)} guardado (${r.cabezas} cab, fuente: ${r.fuente})`);
        } else {
          console.log(`⏭️ [Cron diario] Scrape devolvió ${r.cabezas} cab, dato anterior ${yaTenemos.cabezas} cab. Manteniendo el mejor.`);
        }
      }
    } catch (e) {
      console.error(`❌ [Cron diario] Error: ${e.message}`);
    }
  }

  // ═══ CICLO SEMANAL ════════════════════════════════════════════════════════
  // Cada hora chequea si tenemos completa la semana cerrada anterior. Si no,
  // intenta calcularla desde los diarios o scrapearla de las fuentes semanales.
  async function intentarScrapeSemanal() {
    const ahora = new Date();
    const semAnt = getSemanaAnterior(ahora);

    const yaTenemos = db.prepare("SELECT semana FROM precios_mag WHERE semana = ?").get(semAnt.semana);
    if (yaTenemos) {
      ultimoIntentoExitoso = semAnt.semana;
      return;
    }

    console.log(`📅 [Cron semanal] Falta semana ${semAnt.semana} (${semAnt.desde} → ${semAnt.hasta})`);
    try {
      const r = await getPrecioReferencia(ahora.toISOString().slice(0, 10));
      if (r && !r.fallback) {
        console.log(`✅ [Cron semanal] MAG ${r.semana} = $${r.precio.toFixed(2)}`);
        ultimoIntentoExitoso = r.semana;

        // Aviso WhatsApp a admins
        if (NUMEROS_ADMIN.length && TWILIO_NUMBER) {
          const msg = `🐂 *MAG semanal actualizado*\n📅 Semana ${r.semana}\n💰 $${fmtArs(r.precio)}/kg\n📊 Fuente: ${r.fuente || "scraping"}`;
          for (const numAdmin of NUMEROS_ADMIN) {
            try {
              await twilioClient.messages.create({ body: msg, from: TWILIO_NUMBER, to: numAdmin });
            } catch (e) {
              console.error(`Error notificando a ${numAdmin}: ${e.message}`);
            }
          }
        }
      } else {
        console.warn(`⚠️ [Cron semanal] sin datos aún para ${semAnt.semana}, reintenta en 1h`);
      }
    } catch (e) {
      console.error(`❌ [Cron semanal] Error: ${e.message}`);
    }
  }

  // ═══ CICLO DE AVISO ═══════════════════════════════════════════════════════
  // Una vez al día (10am Argentina), si pasaron muchos días sin precio, avisa por WhatsApp.
  async function chequearDatosViejos() {
    const ar = getAhoraAR();
    if (ar.hour !== 10) return;

    const ultimo = db.prepare("SELECT semana, fecha_hasta, fuente FROM precios_mag ORDER BY semana DESC LIMIT 1").get();
    if (!ultimo) return;

    const fechaUltima = new Date(ultimo.fecha_hasta);
    const ahora = new Date();
    const diasSinDatos = Math.floor((ahora - fechaUltima) / (1000 * 60 * 60 * 24));

    if (diasSinDatos > 10 && NUMEROS_ADMIN.length && TWILIO_NUMBER) {
      const msg = `⚠️ *Aviso VIDELA*\n\nEl último precio MAG semanal es de hace ${diasSinDatos} días (${ultimo.semana}).\n\nProbá: \`cargar mag XXXX\` con el promedio que veas en el sitio del MAG.`;
      for (const numAdmin of NUMEROS_ADMIN) {
        try {
          await twilioClient.messages.create({ body: msg, from: TWILIO_NUMBER, to: numAdmin });
        } catch (e) {}
      }
    }
  }

  // Arranque: scrape inicial 30s después de bootear
  setTimeout(async () => {
    await intentarScrapeDiario();
    await intentarScrapeSemanal();
  }, 30000);

  // Loop cada hora — el orden importa: primero diario (puede generar nuevo dato),
  // luego semanal (puede usar el diario que se acaba de generar).
  setInterval(async () => {
    await intentarScrapeDiario();
    await intentarScrapeSemanal();
    await chequearDatosViejos();
  }, 60 * 60 * 1000);

  console.log("📅 Cron MAG configurado: diario (lun-vie ≥17h) + semanal (cada hora) + aviso si 10+ días sin datos");
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
  // Formato ARS (Argentina)
  return parseFloat(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtKg(n) {
  // Formato kg carne (con 1 decimal)
  return parseFloat(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// Helper: insertar una transacción calculando automáticamente ingreso_kg y egreso_kg
// desde el precio MAG de la semana anterior a la fecha del movimiento.
// Esto reemplaza el patrón viejo: INSERT INTO transacciones (fecha, ..., tc, fuente) VALUES (...)
async function insertTransaccion(fields) {
  const {
    fecha, concepto, detalle = "", ingreso = 0, egreso = 0,
    proveedor = "", fuente = "whatsapp", es_cc = 0
  } = fields;
  const mag = await getPrecioReferencia(fecha);
  const precio = mag?.precio || null;
  const ingreso_kg = precio && ingreso ? ingreso / precio : 0;
  const egreso_kg = precio && egreso ? egreso / precio : 0;
  return db.prepare(`
    INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, es_cc, tc, fuente)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg,
        precio, mag?.semana || null, proveedor, es_cc, precio || 0, fuente);
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

// Saldo en kg carne (unidad estable). Es el que muestra el dashboard como principal.
function getSaldoProveedorKg(proveedor) {
  const compras = db.prepare(`
    SELECT COALESCE(SUM(egreso_kg), 0) as total
    FROM transacciones
    WHERE LOWER(proveedor) = LOWER(?)
    AND concepto != 'PAGO CUENTA CORRIENTE'
  `).get(proveedor);
  const pagos = db.prepare(`
    SELECT COALESCE(SUM(monto_kg), 0) as total
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

// Desglose por proveedor: compras, pagos y saldo, ya calculados.
// Va al resumen del bot para que no tenga que armar SQL —los pagos viven en
// cc_movimientos y armarlo mal era la fuente de errores.
function getDetalleCuentasParaBot() {
  const proveedores = db.prepare("SELECT proveedor FROM cuentas_corrientes ORDER BY proveedor").all();
  return proveedores.map(p => {
    const compras = db.prepare(`SELECT COALESCE(SUM(egreso_kg),0) t, COALESCE(SUM(egreso),0) t_ars FROM transacciones
      WHERE LOWER(proveedor) = LOWER(?) AND concepto != 'PAGO CUENTA CORRIENTE'`).get(p.proveedor).t;
    const pagos = db.prepare(`SELECT COALESCE(SUM(monto_kg),0) t, COALESCE(SUM(monto),0) t_ars, COUNT(*) n, MAX(fecha) ult
      FROM cc_movimientos WHERE LOWER(proveedor) = LOWER(?)`).get(p.proveedor);
    return { proveedor: p.proveedor,
      compras: Math.round(compras * 100) / 100,
      pagos: Math.round(pagos.t * 100) / 100,
      n_pagos: pagos.n, ultimo_pago: pagos.ult || null,
      saldo: Math.round((compras - pagos.t) * 100) / 100 };
  }).filter(x => x.compras || x.pagos);
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
function parseCiclo(cicloStr, tipo = 'productivo') {
  // Acepta "25/26", "2025/2026", "25-26", etc.
  const match = String(cicloStr).match(/(\d{2,4})[\/\-](\d{2,4})/);
  if (!match) return null;
  let anioInicio = parseInt(match[1]);
  let anioFin = parseInt(match[2]);
  if (anioInicio < 100) anioInicio += 2000;
  if (anioFin < 100) anioFin += 2000;
  const contable = tipo === 'contable';
  return {
    ciclo: `${anioInicio % 100}/${anioFin % 100}`,
    tipo: contable ? 'contable' : 'productivo',
    mesInicio: contable ? 7 : 3,                 // contable: jul→jun · productivo: mar→feb
    fecha_desde: contable ? `${anioInicio}-07-01` : `${anioInicio}-03-01`,
    fecha_hasta: contable ? `${anioFin}-06-30` : `${anioFin}-02-29`,
    label: `${anioInicio}/${anioFin}`
  };
}

function getCicloActual(tipo = 'productivo') {
  const hoy = new Date();
  const mes = hoy.getMonth() + 1; // 1-12
  const anio = hoy.getFullYear();
  const mesInicio = tipo === 'contable' ? 7 : 3;
  // Si estamos en el mes de inicio o después → ciclo es anio/anio+1; si no, anio-1/anio
  if (mes >= mesInicio) {
    return parseCiclo(`${anio}/${anio + 1}`, tipo);
  } else {
    return parseCiclo(`${anio - 1}/${anio}`, tipo);
  }
}

function getInformeCiclo(cicloStr, tipo = 'productivo') {
  const ciclo = parseCiclo(cicloStr, tipo);
  if (!ciclo) return null;

  const hoy = new Date().toISOString().slice(0, 10);
  const fechaHasta = ciclo.fecha_hasta < hoy ? ciclo.fecha_hasta : hoy;

  const rows = db.prepare(`
    SELECT concepto,
           SUM(egreso_kg) as total_egreso,
           SUM(ingreso_kg) as total_ingreso,
           SUM(egreso)     as total_egreso_ars,
           SUM(ingreso)    as total_ingreso_ars,
           COUNT(*) as cant_movimientos
    FROM transacciones
    WHERE fecha >= ? AND fecha <= ?
    GROUP BY concepto ORDER BY total_egreso DESC
  `).all(ciclo.fecha_desde, fechaHasta);

  // En kg (unidad principal) y en ARS de referencia.
  const totalEgresos = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
  const totalIngresos = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);
  const totalEgresosArs = rows.reduce((s, r) => s + (r.total_egreso_ars || 0), 0);
  const totalIngresosArs = rows.reduce((s, r) => s + (r.total_ingreso_ars || 0), 0);
  const totalMovimientos = rows.reduce((s, r) => s + r.cant_movimientos, 0);

  // Presupuestos del ciclo
  const presupuestos = db.prepare(
    "SELECT * FROM presupuestos WHERE ciclo = ?"
  ).all(ciclo.ciclo);
  const presupuestoMap = {};
  presupuestos.forEach(p => { presupuestoMap[p.concepto] = p.monto_anual; });

  return { ciclo, rows, totalEgresos, totalIngresos, totalEgresosArs, totalIngresosArs, totalMovimientos, presupuestoMap, fechaHasta, unidad: "kg" };
}

function getInformeMensual(anio, mes) {
  const periodo = `${anio}-${String(mes).padStart(2, '0')}`;
  const rows = db.prepare(`
    SELECT concepto,
           SUM(egreso_kg) as total_egreso,
           SUM(ingreso_kg) as total_ingreso,
           SUM(egreso)     as total_egreso_ars,
           SUM(ingreso)    as total_ingreso_ars,
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
  
  let msg = `📊 *VIDELA — Informe ${meses[mes]} ${anio}*\n\n`;
  
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
    msg += `\n\n📤 Egresos: $${fmt(informe.totalEgresos)} ARS`;
    msg += `\n📥 Ingresos: $${fmt(informe.totalIngresos)} ARS`;
    msg += `\n💰 Neto: $${fmt(informe.totalIngresos - informe.totalEgresos)} ARS`;
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
// ── HERRAMIENTA DE CONSULTA (el bot lee TODA la base con SQL de solo lectura) ──
const DB_SCHEMA = `Base SQLite de VIDELA (Cabaña Amakaik, Argentina). Montos duales: campos sin sufijo están en ARS, campos con sufijo _kg están en kg carne INMAG. El ciclo ganadero va de MARZO a FEBRERO del año siguiente. Tablas y columnas:
- transacciones(id, fecha 'YYYY-MM-DD', concepto [=categoría de gasto/ingreso], detalle, ingreso, egreso, proveedor, es_cc, tc, fuente) — TODOS los movimientos.
- cuentas_corrientes(id, proveedor, notas) — solo el nombre y las notas, NO tiene saldo.
- cc_movimientos(id, fecha, proveedor, monto, medio, notas) — LOS PAGOS a proveedores de cuenta corriente. Son movimientos internos: NO están en transacciones y NO afectan el flujo de caja.
  ATENCIÓN: los pagos a un proveedor NUNCA están en transacciones.ingreso. Están acá.
  Compras de un proveedor = SUM(egreso_kg) FROM transacciones WHERE LOWER(proveedor)=LOWER(?) AND concepto != 'PAGO CUENTA CORRIENTE'
  Pagos de un proveedor    = SUM(monto)  FROM cc_movimientos WHERE LOWER(proveedor)=LOWER(?)
  Saldo (deuda)            = compras - pagos
  Si al calcular la deuda de un proveedor te da que no hay pagos, casi seguro estás mirando transacciones en vez de cc_movimientos.
- cheques(id, fecha_emision, fecha_cobro, tipo 'EMITIDO'/'RECIBIDO', proveedor, monto, estado 'PENDIENTE'/'COBRADO', banco, concepto)
- inversores(id, inversor, fecha_ingreso, capital, tasa, estado, notas)
- dividendos(id, socio, monto, fecha, notas)
- lotes(id, nombre, hectareas, ha_sembrables [=ha aprovechables que se siembran], notas)
- ordenes_trabajo(id, numero, anio [AÑO CALENDARIO: 2026, 2027, etc. — NO es el ciclo ganadero], lote, titulo, ciclo, hectareas, estado 'PLANIFICADA'/'EN_EJECUCION'/'EJECUTADA', total_planificado, total_ejecutado). Un lote multi puede venir como "A + B + C". IMPORTANTE: las órdenes se filtran por anio (año calendario): "las órdenes/insumos de 2026" = WHERE anio = 2026. NO uses el ciclo ganadero (marzo-febrero) para las órdenes; el ciclo es solo para transacciones/finanzas.
- orden_items(id, orden_id, tipo 'INSUMO'/'SERVICIO', etapa, producto_id, descripcion, dosis, cantidad, unidad, precio_unitario, total, ejecutado 0/1, cantidad_ejecutada, total_ejecutado)
- stock_productos(id, nombre, categoria, unidad, cantidad [=stock actual], precio_unitario [=costo promedio])
- stock_movimientos(id, producto_id, fecha, tipo 'ENTRADA'/'SALIDA'/'AJUSTE', cantidad, precio_unitario)
- presupuestos(id, ciclo, concepto, monto_anual). monto_anual está en KG DE CARNE, no en pesos.

UNIDAD DEL SISTEMA: todo se informa en KG DE CARNE (índice novillo MAG), que no se
licúa con la inflación. Cada movimiento tiene su par: ingreso/egreso en ARS e
ingreso_kg/egreso_kg en kilos. Para totales, presupuestos, comparaciones entre
períodos y cualquier análisis, usá SIEMPRE las columnas _kg. Mostrá los pesos
sólo si te los piden expresamente o para un movimiento puntual reciente.
- diario_campo(id, campo, fecha, tipo 'LLUVIA'/'ACONTECIMIENTO', mm, titulo, detalle). El registro pluviométrico del campo: las lluvias son las filas con tipo='LLUVIA' y los milímetros están en mm. Para acumulados usá SUM(mm) filtrando por fecha (ej: lo que va del mes = WHERE tipo='LLUVIA' AND substr(fecha,1,7)='2026-08').
- tareas_campo(id, campo, texto, estado 'PENDIENTE'/'HECHA', fecha)
Insumos faltantes de un año = por cada orden_items con tipo='INSUMO', ejecutado=0 y producto_id, sumar cantidad por producto y restar stock_productos.cantidad.`;

const DASHBOARD_TOOL = {
  name: "consultar_datos",
  description: "Ejecuta una consulta SQL de SOLO LECTURA (SELECT) sobre la base de VIDELA para responder cualquier pregunta del usuario sobre sus datos. Usala SIEMPRE que necesites un dato que no tengas a mano (gastos, ingresos, saldos, cheques, stock, órdenes, insumos faltantes, lo que sea). Podés hacer varias consultas si hace falta.\n\n" + DB_SCHEMA,
  input_schema: {
    type: "object",
    properties: { sql: { type: "string", description: "Una única consulta SELECT válida de SQLite (solo lectura)." } },
    required: ["sql"]
  }
};

function consultarDB(input) {
  try {
    const q = String(input?.sql || "").trim().replace(/;+\s*$/, "");
    if (!/^select\b/i.test(q)) return JSON.stringify({ error: "Solo se permiten consultas SELECT." });
    if (/\b(insert|update|delete|drop|alter|attach|detach|pragma|create|replace|vacuum|reindex)\b/i.test(q))
      return JSON.stringify({ error: "Consulta no permitida (solo lectura)." });
    if (q.includes(";")) return JSON.stringify({ error: "Una sola consulta por vez." });
    const rows = db.prepare(q).all();
    const cap = rows.slice(0, 300);
    return JSON.stringify({ filas: cap, total_filas: rows.length, truncado: rows.length > 300 });
  } catch (e) {
    return JSON.stringify({ error: String(e.message).slice(0, 200) });
  }
}


async function buildContexto() {
  const mag = await getPrecioReferencia(new Date().toISOString().slice(0,10));
  const precio = mag?.precio || 0;
  const ultimas = getUltimasTransacciones(15);
  const cuentas = getResumenCuentasCorrientes();
  const chequesPend = getChequesPendientes();
  const inversores = getInversoresActivos();
  const totalDeuda = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);

  // Resumen de egresos del mes actual
  const mesActual = new Date().toISOString().slice(0, 7);
  const egresosMes = db.prepare(`
    SELECT concepto, SUM(egreso_kg) as total, SUM(egreso) as total_ars
    FROM transacciones
    WHERE fecha LIKE ? AND egreso > 0
    GROUP BY concepto ORDER BY total DESC LIMIT 10
  `).all(`${mesActual}-%`);

  // ── DATOS DEL DASHBOARD (para responder consultas) ──
  const cicloAct = getCicloActual();
  const inf = cicloAct ? getInformeCiclo(cicloAct.ciclo) : null;
  const evol = db.prepare(`
    SELECT substr(fecha,1,7) as mes,
           SUM(egreso_kg) as egresos, SUM(ingreso_kg) as ingresos,
           SUM(egreso) as egresos_ars, SUM(ingreso) as ingresos_ars, COUNT(*) as movs
    FROM transacciones GROUP BY mes ORDER BY mes DESC LIMIT 24
  `).all();
  // ── STOCK, LOTES, ÓRDENES (resumen liviano; el detalle lo consulta el bot con la herramienta) ──
  const stock = db.prepare("SELECT nombre, categoria, unidad, cantidad, precio_unitario, ROUND(cantidad * COALESCE(precio_unitario,0), 2) AS valor_ars FROM stock_productos ORDER BY categoria, nombre").all();
  const lotes = db.prepare("SELECT nombre, hectareas, ha_sembrables FROM lotes ORDER BY nombre").all();
  const ordenesCtx = db.prepare("SELECT numero, anio, lote, titulo, estado, hectareas, total_planificado, total_ejecutado FROM ordenes_trabajo ORDER BY anio DESC, numero DESC").all()
    .map(o => ({ num: `${o.numero}/${o.anio}`, lote: o.lote, titulo: o.titulo, estado: o.estado, ha: o.hectareas, plan: Math.round(o.total_planificado || 0), ejec: Math.round(o.total_ejecutado || 0) }));


  return `Sos el asistente financiero de VIDELA (Cabaña Amakaik), Cabaña Amakaik (empresa ganadera argentina). Respondés en español rioplatense, claro y al grano (apto para WhatsApp, sin relleno).

FECHA DE HOY: ${new Date().toISOString().slice(0,10)} — SIEMPRE usar esta fecha en los registros, nunca inventar fechas.
MONEDA DEL SISTEMA: PESOS ARGENTINOS (ARS).
UNIDAD DE VALOR REAL: KG CARNE (Índice Novillo MAG Cañuelas / INMAG).
PRECIO MAG SEMANA ANTERIOR: ${precio ? `$${precio.toFixed(2)} ARS/kg carne (semana ${mag?.semana || "?"})` : "No disponible"}
Cada monto en ARS se convierte automáticamente a kg carne usando el promedio MAG de la semana ANTERIOR a la fecha.

CATEGORÍAS DE GASTO: ${CATEGORIAS.join(", ")}

HERRAMIENTAS — cuando sea una acción respondé SOLO con JSON exacto sin texto extra, sin markdown, sin bloques de código. NUNCA muestres el JSON al usuario — es solo para uso interno del sistema:
{"accion":"registrar_transaccion","fecha":"YYYY-MM-DD","concepto":"CATEGORIA","detalle":"descripción","ingreso":0,"egreso":0,"proveedor":"nombre o vacío"}
{"accion":"compra_insumo","fecha":"YYYY-MM-DD","producto":"nombre del insumo","rubro":"VETERINARIO/AGRICOLA/ALIMENTO","categoria":"tipo","envases":0,"contenido_envase":0,"unidad":"ml/kg/unidad","precio_envase":0,"proveedor":"nombre o vacío"}
// USAR compra_insumo cuando compran un INSUMO que se guarda en stock (veterinario, alimento, agrícola). Ej: "compré 10 frascos de ivermectina de 250ml a 20000 pesos en Zambrano" → {"accion":"compra_insumo","producto":"Ivermectina","rubro":"VETERINARIO","categoria":"ANTIPARASITARIO","envases":10,"contenido_envase":250,"unidad":"ml","precio_envase":20000,"proveedor":"Zambrano"}. Esto genera el egreso Y la entrada de stock a la vez — NO usar también registrar_transaccion para lo mismo.
// REPREGUNTAR OBLIGATORIO en compras stockeables: si el usuario dice que compró un insumo pero FALTAN datos para el stock (cantidad de envases/frascos, o el contenido por envase como ml/cc/kg por frasco, o el precio), NO registres todavía. Respondé con accion "texto" pidiendo lo que falta, ej: "Para cargarlo bien al stock necesito: ¿cuántos frascos y cuántos ml por frasco?". Recién cuando tengas producto + envases + contenido_envase + precio, emitís compra_insumo.
{"accion":"nuevo_proveedor","proveedor":"nombre","notas":""}
{"accion":"pago_proveedor","proveedor":"nombre","monto":0,"fecha":"YYYY-MM-DD"}
{"accion":"nuevo_cheque","fecha_emision":"YYYY-MM-DD","fecha_cobro":"YYYY-MM-DD","tipo":"EMITIDO o RECIBIDO","proveedor":"nombre","monto":0,"banco":"NACION","concepto":""}
{"accion":"marcar_cheque_cobrado","id":0}
{"accion":"nuevo_inversor","inversor":"nombre","capital":0,"tasa":0.08,"notas":""}
{"accion":"pago_inversor","inversor":"nombre","fecha":"YYYY-MM-DD"}
// nuevo_inversor: el capital ENTRA como ingreso de cash automáticamente. pago_inversor: SALE el cash (capital + intereses acumulados) y cierra al inversor.
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
{"accion":"informe_ciclo","ciclo":"25/26","tipo":"productivo"}
{"accion":"set_presupuesto","ciclo":"25/26","concepto":"CATEGORIA","monto_anual":0}
{"accion":"ver_presupuestos","ciclo":"25/26"}
{"accion":"informe_mensual","anio":2026,"mes":3}
{"accion":"informe_pdf","ciclo":"25/26","tipo":"productivo"}
{"accion":"informe_mensual_pdf","anio":2026,"mes":3}
{"accion":"backup","tipo":"transacciones"}
// TIPOS DE INFORME: "productivo" = ciclo ganadero MARZO→FEBRERO (default). "contable" = ciclo CONTABLE 1/JULIO→30/JUNIO. Si el usuario pide "informe" o "informe productivo" → tipo:"productivo". Si pide "informe contable" → tipo:"contable". El ciclo "25/26" significa jul2025→jun2026 para contable, o mar2025→feb2026 para productivo.
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
- Gastos en pesos ARS → el sistema los convierte automáticamente a kg carne usando MAG semana anterior
- "borrar", "eliminar", "anular" + ID → usar borrar_transaccion (borra permanentemente)
- "corregir", "editar", "cambiar" + ID → usar editar_transaccion
- Para consultas de períodos específicos → usar resumen_periodo o ver_por_fecha
- EDUARDO = empleado de campo (SUELDO JORNAL generalmente)
- JONI = Jonatan, dueño (gastos administrativos/personales de la empresa)
- Si no entendés bien → usar accion texto y preguntar

DATOS DEL DASHBOARD — RESUMEN (vista rápida; para el detalle o cualquier dato que no esté acá, usá la herramienta consultar_datos):
${inf ? `CICLO ACTUAL ${inf.ciclo.label} (mar→feb): egresos $${fmt(inf.totalEgresos)}, ingresos $${fmt(inf.totalIngresos)}, neto $${fmt(inf.totalIngresos - inf.totalEgresos)}, ${inf.totalMovimientos} movimientos.
GASTOS DEL CICLO POR CATEGORÍA: ${JSON.stringify(inf.rows.filter(r => r.total_egreso > 0).map(r => ({ cat: r.concepto, egreso: Math.round(r.total_egreso) })))}` : ''}
EVOLUCIÓN MENSUAL (últimos 24 meses, más reciente primero): ${JSON.stringify(evol.map(m => ({ mes: m.mes, egresos: Math.round(m.egresos || 0), ingresos: Math.round(m.ingresos || 0), neto: Math.round((m.ingresos || 0) - (m.egresos || 0)), movs: m.movs })))}
CUENTAS CORRIENTES — compras, pagos y saldo YA CALCULADOS (los pagos salen de cc_movimientos, NO de transacciones). Usá estos números tal cual: NO los recalcules con SQL.
${JSON.stringify(getDetalleCuentasParaBot())}
CHEQUES PENDIENTES: ${JSON.stringify(chequesPend.map(c => ({ id: c.id, tipo: c.tipo, proveedor: c.proveedor, monto: c.monto, vence: c.fecha_cobro })))}
INVERSORES: ${JSON.stringify(inversores.map(i => ({ inversor: i.inversor, capital: i.capital, tasa: i.tasa, deuda: calcularDeudaInversor(i).toFixed(2) })))}
LOTES: ${JSON.stringify(lotes.map(l => ({ lote: l.nombre, ha: l.hectareas, ha_aprovechable: l.ha_sembrables })))}
STOCK DE INSUMOS ACTUAL: ${JSON.stringify(stock.map(s => ({ producto: s.nombre, categoria: s.categoria, cantidad: s.cantidad, unidad: s.unidad, costo_unit: s.precio_unitario })))}
ÓRDENES DE TRABAJO (resumen): ${JSON.stringify(ordenesCtx)}
Últimas 15 transacciones: ${JSON.stringify(ultimas.map(t => ({ id: t.id, fecha: t.fecha, concepto: t.concepto, detalle: t.detalle, ingreso: t.ingreso, egreso: t.egreso, proveedor: t.proveedor })))}

CÓMO RESPONDER CONSULTAS (muy importante):
- Tenés acceso COMPLETO a todos los datos del sistema mediante la herramienta *consultar_datos* (SQL de solo lectura). NUNCA digas que no tenés acceso ni le pidas al usuario que te pase planillas, stock, laboreos o nada: consultá vos.
- Si la respuesta ya está en el RESUMEN de arriba, contestá directo. Si te falta cualquier detalle (una transacción puntual, un gasto por categoría y mes, los items de una orden, insumos faltantes, movimientos de stock, comparaciones, etc.), llamá a consultar_datos con una consulta SELECT y después respondé.
- Para insumos faltantes de un año: tomá SOLO las ordenes_trabajo con anio = <ese año calendario> (ej: 2026 → WHERE anio=2026, NO el ciclo 26/27). Sumá cantidad de sus orden_items (tipo='INSUMO', ejecutado=0, con producto_id) y restá stock_productos.cantidad. Si el usuario pide "2026", es el año calendario 2026, no marzo2026-febrero2027.
- Respondé natural, preciso y al grano (apto WhatsApp), en español rioplatense. Redondeá y aclará las unidades (ARS y kg carne).
- Usá JSON SOLO para ACCIONES que crean o modifican datos (registrar, pagar, borrar, editar, informe/pdf, backup). Para preguntas, nunca uses JSON.
- Sé como un buen contador que conoce el campo.`;
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

// ── HELPERS ÓRDENES DE TRABAJO + STOCK (v4.3) ─────────────────────────────────
function getNextNumeroOrden(anio) {
  const row = db.prepare("SELECT COALESCE(MAX(numero),0) as m FROM ordenes_trabajo WHERE anio = ?").get(anio);
  return (row.m || 0) + 1;
}

function logCambioOrden(ordenId, texto) {
  const hoy = new Date().toISOString().slice(0, 10);
  db.prepare("INSERT INTO orden_cambios (orden_id, fecha, texto) VALUES (?,?,?)").run(ordenId, hoy, texto);
}

// Recalcula totales y estado de la orden (planificado, ejecutado, avance)
function recalcularOrden(ordenId) {
  const planificado = db.prepare("SELECT COALESCE(SUM(total),0) as t FROM orden_items WHERE orden_id=?").get(ordenId).t || 0;
  const ejecutado = db.prepare("SELECT COALESCE(SUM(total_ejecutado),0) as t FROM orden_items WHERE orden_id=? AND ejecutado=1").get(ordenId).t || 0;
  const countTotal = db.prepare("SELECT COUNT(*) as c FROM orden_items WHERE orden_id=?").get(ordenId).c;
  const countEjec = db.prepare("SELECT COUNT(*) as c FROM orden_items WHERE orden_id=? AND ejecutado=1").get(ordenId).c;
  let estado = 'PLANIFICADA';
  if (countEjec > 0 && countEjec < countTotal) estado = 'EN_EJECUCION';
  if (countTotal > 0 && countEjec === countTotal) estado = 'EJECUTADA';
  db.prepare("UPDATE ordenes_trabajo SET total_planificado=?, total_ejecutado=?, estado=? WHERE id=?")
    .run(planificado, ejecutado, estado, ordenId);
  const pctAvance = countTotal > 0 ? Math.round(countEjec / countTotal * 100) : 0;
  return { total_planificado: planificado, total_ejecutado: ejecutado, estado, pctAvance };
}

function getOrdenDetalle(ordenId) {
  const ord = db.prepare("SELECT * FROM ordenes_trabajo WHERE id = ?").get(ordenId);
  if (!ord) return null;
  const items = db.prepare(`
    SELECT oi.*, sp.nombre as producto_nombre, sp.cantidad as stock_actual
    FROM orden_items oi
    LEFT JOIN stock_productos sp ON sp.id = oi.producto_id
    WHERE oi.orden_id = ? ORDER BY oi.tipo, oi.ejecutado, oi.id
  `).all(ordenId);
  const cambios = db.prepare("SELECT * FROM orden_cambios WHERE orden_id = ? ORDER BY id DESC").all(ordenId);
  const pctAvance = items.length ? Math.round(items.filter(i=>i.ejecutado).length / items.length * 100) : 0;
  // ha sembrables del lote (referencia para sugerir ha de la orden)
  const loteInfo = ord.lote ? db.prepare("SELECT hectareas, ha_sembrables FROM lotes WHERE nombre = ?").get(ord.lote) : null;
  return { ...ord, numero_display: `${ord.numero}/${ord.anio}`, items, cambios, pctAvance,
    lote_hectareas: loteInfo?.hectareas ?? null, lote_ha_sembrables: loteInfo?.ha_sembrables ?? null };
}

// Recalcula cantidad/total de los items con dosis>0 (no ejecutados) según las ha de la orden
function recomputarDosisOrden(ordenId) {
  const ord = db.prepare("SELECT hectareas FROM ordenes_trabajo WHERE id = ?").get(ordenId);
  const ha = parseFloat(ord?.hectareas) || 0;
  if (ha <= 0) return;
  const items = db.prepare("SELECT * FROM orden_items WHERE orden_id = ? AND ejecutado = 0 AND dosis > 0").all(ordenId);
  const upd = db.prepare("UPDATE orden_items SET cantidad = ?, total = ? WHERE id = ?");
  items.forEach(i => { const cant = i.dosis * ha; upd.run(cant, cant * i.precio_unitario, i.id); });
}

// Suma de ha aprovechables (sembrables) de una lista de nombres de lote
function haDeLotes(loteArr) {
  return (loteArr || []).reduce((s, n) => {
    const lt = db.prepare("SELECT ha_sembrables FROM lotes WHERE nombre = ?").get(n);
    return s + (parseFloat(lt?.ha_sembrables) || 0);
  }, 0);
}
// Normaliza el input de lotes (array o string) → array de nombres en mayúscula
function normalizarLotes(lotes, lote) {
  let arr = Array.isArray(lotes) ? lotes : (lote ? [lote] : []);
  return arr.filter(Boolean).map(x => String(x).toUpperCase().trim());
}

// ENTRADA de stock: suma cantidad y recalcula costo promedio ponderado
function entradaStock(productoId, cantidad, precioUnitario, fecha, notas, precioUnitarioKg = 0, ordenId = null) {
  const p = db.prepare("SELECT * FROM stock_productos WHERE id = ?").get(productoId);
  if (!p) return null;
  const cant = parseFloat(cantidad) || 0;
  const precio = parseFloat(precioUnitario) || 0;
  const precioKg = parseFloat(precioUnitarioKg) || 0;
  const nuevaCantidad = (p.cantidad || 0) + cant;
  // Promedio ponderado (en ARS y en kg carne)
  let nuevoPrecio = p.precio_unitario || 0;
  let nuevoPrecioKg = p.precio_unitario_kg || 0;
  if (precio > 0 && nuevaCantidad > 0) {
    nuevoPrecio = ((p.cantidad || 0) * (p.precio_unitario || 0) + cant * precio) / nuevaCantidad;
  }
  if (precioKg > 0 && nuevaCantidad > 0) {
    nuevoPrecioKg = ((p.cantidad || 0) * (p.precio_unitario_kg || 0) + cant * precioKg) / nuevaCantidad;
  }
  db.prepare("UPDATE stock_productos SET cantidad=?, precio_unitario=?, precio_unitario_kg=? WHERE id=?")
    .run(nuevaCantidad, nuevoPrecio, nuevoPrecioKg, productoId);
  db.prepare("INSERT INTO stock_movimientos (producto_id,fecha,tipo,cantidad,precio_unitario,precio_unitario_kg,orden_id,notas) VALUES (?,?,'ENTRADA',?,?,?,?,?)")
    .run(productoId, fecha, cant, precio, precioKg, ordenId, notas || '');
  return { cantidad: nuevaCantidad, precio_unitario: nuevoPrecio, precio_unitario_kg: nuevoPrecioKg };
}

// Concepto contable por defecto según el rubro del insumo (para no inventar conceptos)
function conceptoPorRubro(rubro, categoria) {
  const r = (rubro || '').toUpperCase();
  if (r === 'VETERINARIO') return 'INSUMOS VETERINARIOS';
  if (r === 'ALIMENTO') return 'ALIMENTACION RECRIA';
  if (r === 'GENETICA') return 'INSUMOS VETERINARIOS';
  if (r === 'AGRICOLA') return 'VERDEOS Y PASTURAS';
  return 'INSUMOS VETERINARIOS';
}

// COMPRA que carga stock: un solo movimiento → egreso en el flujo + entrada al stock.
// Presentación opcional: N envases × contenido (ej. 10 frascos × 250 ml) a precio por envase.
function comprarInsumo(o) {
  const campo = (o.campo || 'AMAKAIK').toUpperCase();
  const fecha = o.fecha || new Date().toISOString().slice(0, 10);
  const nombre = (o.producto || o.nombre || '').trim();
  if (!nombre) return { error: 'Falta el nombre del insumo' };

  const envases = parseFloat(o.envases) || 0;
  const contenido = parseFloat(o.contenido_envase) || 0;
  const precioEnvase = parseFloat(o.precio_envase);
  const unidad = o.unidad || (contenido > 0 ? 'ml' : 'unidad');

  let cantTotal, costoTotal;
  if (contenido > 0 && envases > 0) {
    cantTotal = envases * contenido;
    costoTotal = envases * (isNaN(precioEnvase) ? (parseFloat(o.precio_unitario) || 0) * contenido : precioEnvase);
  } else {
    cantTotal = envases > 0 ? envases : (parseFloat(o.cantidad) || 0);
    const pu = !isNaN(precioEnvase) ? precioEnvase : (parseFloat(o.precio_unitario) || 0);
    costoTotal = cantTotal * pu;
  }
  const precioUnit = cantTotal > 0 ? costoTotal / cantTotal : 0;
  if (cantTotal <= 0) return { error: 'La cantidad de la compra es 0' };

  // Conversión a kg carne para el flujo y el stock
  const magCI = getPrecioReferenciaSync(fecha);
  const precioMagCI = magCI?.precio || null;
  const costoTotalKg = precioMagCI ? costoTotal / precioMagCI : 0;
  const precioUnitKg = precioMagCI ? precioUnit / precioMagCI : 0;

  let prod = db.prepare("SELECT * FROM stock_productos WHERE LOWER(nombre) = LOWER(?)").get(nombre);
  if (!prod) {
    const r = db.prepare("INSERT INTO stock_productos (nombre,rubro,categoria,unidad,cantidad,precio_unitario,precio_unitario_kg,campo) VALUES (?,?,?,?,0,0,0,?)")
      .run(nombre.toUpperCase(), (o.rubro || 'VETERINARIO').toUpperCase(), (o.categoria || 'OTRO').toUpperCase(), unidad, campo);
    prod = db.prepare("SELECT * FROM stock_productos WHERE id = ?").get(r.lastInsertRowid);
  }

  // 1) Entrada al stock (recalcula costo promedio ponderado en ARS y en kg carne)
  const presentacion = contenido > 0 && envases > 0 ? `${envases} × ${contenido}${prod.unidad || unidad}` : `${cantTotal} ${prod.unidad || unidad}`;
  const detalleStock = `Compra ${presentacion}${o.proveedor ? ' — ' + o.proveedor : ''}`;
  entradaStock(prod.id, cantTotal, precioUnit, fecha, detalleStock, precioUnitKg);

  // 2) Egreso en el flujo (ARS + kg carne)
  const concepto = o.concepto || conceptoPorRubro(prod.rubro || o.rubro, prod.categoria || o.categoria);
  const detalleFlujo = `Compra ${presentacion} de ${prod.nombre}`;
  const tr = db.prepare(`INSERT INTO transacciones
    (fecha,concepto,detalle,ingreso,egreso,ingreso_kg,egreso_kg,precio_mag,semana_mag,proveedor,tc,fuente)
    VALUES (?,?,?,0,?,0,?,?,?,?,?,'compra_insumo')`)
    .run(fecha, concepto, detalleFlujo,
         Math.round(costoTotal * 100) / 100,
         Math.round(costoTotalKg * 100) / 100,
         precioMagCI, magCI?.semana || null,
         o.proveedor || '', precioMagCI || 0);

  return {
    ok: true, producto_id: prod.id, producto: prod.nombre, campo,
    cantidad_total: cantTotal, unidad: prod.unidad || unidad,
    costo_total: Math.round(costoTotal * 100) / 100,
    costo_total_kg: Math.round(costoTotalKg * 100) / 100,
    precio_unitario: Math.round(precioUnit * 10000) / 10000,
    precio_unitario_kg: Math.round(precioUnitKg * 10000) / 10000,
    concepto, proveedor: o.proveedor || '', transaccion_id: tr.lastInsertRowid
  };
}

// SALIDA de stock: descuenta cantidad (permite negativo, sin bloquear ni alertar)
function salidaStock(productoId, cantidad, fecha, notas, ordenId = null) {
  const p = db.prepare("SELECT * FROM stock_productos WHERE id = ?").get(productoId);
  if (!p) return null;
  const cant = parseFloat(cantidad) || 0;
  const nuevaCantidad = (p.cantidad || 0) - cant;
  db.prepare("UPDATE stock_productos SET cantidad=? WHERE id=?").run(nuevaCantidad, productoId);
  db.prepare("INSERT INTO stock_movimientos (producto_id,fecha,tipo,cantidad,precio_unitario,orden_id,notas) VALUES (?,?,'SALIDA',?,?,?,?)")
    .run(productoId, fecha, cant, p.precio_unitario || 0, ordenId, notas || '');
  return { cantidad: nuevaCantidad, precio_unitario: p.precio_unitario || 0 };
}

function getStockValorizado(campo) {
  const productos = campo
    ? db.prepare("SELECT * FROM stock_productos WHERE campo = ? ORDER BY rubro, categoria, nombre").all(campo)
    : db.prepare("SELECT * FROM stock_productos ORDER BY rubro, categoria, nombre").all();
  // Cada producto también valorizado en kg de carne al precio de hoy: así se
  // ve cuánto vale el stock en la unidad del sistema, sin que la inflación lo
  // infle. Si el producto guardó su precio en kg al comprarlo, se usa ese.
  const mag = (getPrecioReferenciaSync(new Date().toISOString().slice(0, 10)) || {}).precio || 0;
  return productos.map(p => {
    const valor = (p.cantidad || 0) * (p.precio_unitario || 0);
    const porKg = p.precio_unitario_kg != null && p.precio_unitario_kg > 0
      ? (p.cantidad || 0) * p.precio_unitario_kg          // precio de la compra
      : (mag > 0 ? valor / mag : 0);                      // al MAG de hoy
    return {
      ...p,
      rubro: p.rubro || 'AGRICOLA',
      valor,                                              // ARS
      valor_kg: Math.round(porKg * 100) / 100,            // kg de carne
      precio_unitario_kg_hoy: mag > 0 ? Math.round(((p.precio_unitario || 0) / mag) * 1000) / 1000 : 0
    };
  });
}

// ── EJECUTAR ACCIÓN ───────────────────────────────────────────────────────────
async function ejecutarAccion(accion) {
  const hoy = new Date().toISOString().split("T")[0];

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

    // Conversión a kg carne usando promedio MAG de semana anterior
    const mag = await getPrecioReferencia(fecha);
    const precio = mag?.precio || null;
    const ingArs = parseFloat(ingreso) || 0;
    const egArs = parseFloat(egreso) || 0;
    const ingKg = precio && ingArs ? ingArs / precio : 0;
    const egKg = precio && egArs ? egArs / precio : 0;

    db.prepare(`
      INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, tc, fuente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp')
    `).run(fecha, concepto, detalle || "",
      ingArs, egArs, ingKg, egKg,
      precio, mag?.semana || null,
      proveedor || "", precio || 0);

    const tipo = ingArs > 0
      ? `📥 Ingreso: $${fmt(ingArs)} ARS · ${fmt(ingKg)} kg`
      : `📤 Egreso: $${fmt(egArs)} ARS · ${fmt(egKg)} kg`;
    const magInfo = precio ? `\n🐂 MAG ${mag.semana}: $${fmt(precio)}/kg` : "\n⚠️ Sin precio MAG disponible";
    return `✅ Registrado!\n📝 ${detalle || concepto}\n${tipo}\n📁 ${concepto}${proveedor ? `\n🏪 ${proveedor}` : ""}${magInfo}`;
  }

  // COMPRA DE INSUMO (egreso en flujo + entrada al stock, un solo paso)
  if (accion.accion === "compra_insumo") {
    const r = comprarInsumo(accion);
    if (r.error) return `❌ ${r.error}`;
    return `✅ Compra registrada!\n📦 ${r.producto}: +${fmt(r.cantidad_total)} ${r.unidad}\n📤 Egreso: $${fmt(r.costo_total)} ARS (${r.concepto})${r.proveedor ? `\n🏪 ${r.proveedor}` : ""}\n💧 Costo: $${r.precio_unitario}/${r.unidad}\n\n_Impactó en el flujo y en el stock. No lo cargues de nuevo como gasto._`;
  }

  // NUEVO PROVEEDOR
  if (accion.accion === "nuevo_proveedor") {
    const { proveedor, notas } = accion;
    if (!proveedor) return "❌ Falta el nombre del proveedor.";
    try {
      db.prepare("INSERT INTO cuentas_corrientes (proveedor, notas) VALUES (?, ?)").run(proveedor, notas || "");
      return `✅ Proveedor creado!\n🏪 ${proveedor}\nSaldo inicial: $0.00 ARS`;
    } catch (e) {
      if (e.message.includes("UNIQUE")) return `⚠️ El proveedor "${proveedor}" ya existe en cuentas corrientes.`;
      return "❌ Error al crear proveedor.";
    }
  }

  // PAGO A PROVEEDOR
  if (accion.accion === "pago_proveedor") {
    const { proveedor, monto, fecha, medio, notas } = accion;
    if (!proveedor || !monto) return "❌ Faltan datos para registrar el pago.";

    const fp = fecha || hoy;
    const magPP = await getPrecioReferencia(fp);
    const precioPP = magPP?.precio || null;
    const montoNumPP = parseFloat(monto);
    const montoKgPP = precioPP ? montoNumPP / precioPP : 0;

    // Registrar en cc_movimientos — NO afecta flujo de caja
    db.prepare(`
      INSERT INTO cc_movimientos (fecha, proveedor, monto, monto_kg, medio, notas)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fp, proveedor, montoNumPP, montoKgPP, medio || 'EFECTIVO', notas || `Pago a ${proveedor}`);

    const saldoNuevo = getSaldoProveedor(proveedor);
    return `✅ Pago CC registrado!\n🏪 ${proveedor}\n💰 $${fmt(montoNumPP)} ARS · ${fmtKg(montoKgPP)} kg\n📊 Saldo pendiente: $${fmt(saldoNuevo)} ARS\n💡 No afecta el flujo de caja`;
  }

  // NUEVO CHEQUE
  if (accion.accion === "nuevo_cheque") {
    const { fecha_emision, fecha_cobro, tipo, proveedor, monto, banco, concepto } = accion;
    if (!monto || !tipo) return "❌ Faltan datos para el cheque.";

    // Conversión kg carne al momento de emisión
    const fechaEm = fecha_emision || hoy;
    const magCh = await getPrecioReferencia(fechaEm);
    const precioCh = magCh?.precio || null;
    const montoNum = parseFloat(monto);
    const montoKg = precioCh ? montoNum / precioCh : 0;

    const result = db.prepare(`
      INSERT INTO cheques (fecha_emision, fecha_cobro, tipo, proveedor, monto, monto_kg, precio_mag, estado, banco, concepto)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?, ?)
    `).run(fechaEm, fecha_cobro || "", tipo, proveedor || "", montoNum, montoKg, precioCh, banco || "NACION", concepto || "");

    const emoji = tipo === "RECIBIDO" ? "📥" : "📤";
    return `✅ Cheque registrado! (ID: ${result.lastInsertRowid})\n${emoji} ${tipo}\n🏪 ${proveedor || "Sin proveedor"}\n💰 $${fmt(montoNum)} ARS · ${fmtKg(montoKg)} kg\n📅 Vence: ${fecha_cobro || "Sin fecha"}`;
  }

  // MARCAR CHEQUE COBRADO
  if (accion.accion === "marcar_cheque_cobrado") {
    const cheque = db.prepare("SELECT * FROM cheques WHERE id = ?").get(accion.id);
    if (!cheque) return "❌ No encontré ese cheque.";
    db.prepare("UPDATE cheques SET estado = 'COBRADO' WHERE id = ?").run(accion.id);
    return `✅ Cheque #${accion.id} marcado como cobrado.\n🏪 ${cheque.proveedor}\n💰 $${fmt(cheque.monto)} ARS`;
  }

  // NUEVO INVERSOR
  if (accion.accion === "nuevo_inversor") {
    const { inversor, capital, tasa, notas } = accion;
    if (!inversor || !capital) return "❌ Faltan datos del inversor.";
    const cap = parseFloat(capital);
    const fecha = accion.fecha || hoy;

    // Convertir capital a kg carne
    const magInv = await getPrecioReferencia(fecha);
    const precioInv = magInv?.precio || null;
    const capKg = precioInv ? cap / precioInv : 0;

    db.prepare(`
      INSERT INTO inversores (inversor, fecha_ingreso, capital, capital_kg, tasa, deuda_actual, estado, notas)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO', ?)
    `).run(inversor, fecha, cap, capKg, parseFloat(tasa) || 0.08, cap, notas || "");

    // El capital entra como INGRESO de cash en el flujo (con kg carne)
    db.prepare(`INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, tc, fuente)
      VALUES (?, 'INGRESO INVERSOR', ?, ?, 0, ?, 0, ?, ?, ?, ?, 'inversor')`)
      .run(fecha, `Ingreso capital inversor ${inversor}`, cap, capKg, precioInv, magInv?.semana || null, inversor, precioInv || 0);

    return `✅ Inversor registrado!\n👤 ${inversor}\n💰 Capital: $${fmt(cap)} ARS · ${fmtKg(capKg)} kg carne\n📥 Ingresó al flujo como cash\n📈 Tasa: ${(parseFloat(tasa || 0.08) * 100).toFixed(1)}% anual sobre kg\n📅 ${fecha}`;
  }

  // PAGO / DEVOLUCIÓN A INVERSOR (sale cash: capital + intereses)
  if (accion.accion === "pago_inversor" || accion.accion === "devolucion_inversor") {
    const inv = db.prepare("SELECT * FROM inversores WHERE LOWER(inversor) = LOWER(?) AND estado = 'ACTIVO'").get(accion.inversor);
    if (!inv) return `❌ No encontré un inversor activo llamado "${accion.inversor}".`;
    const fecha = accion.fecha || hoy;
    const deudaTotal = calcularDeudaInversor(inv);
    const interes = Math.round((deudaTotal - inv.capital) * 100) / 100;

    // Precio MAG del día del pago para conversiones
    const magPago = await getPrecioReferencia(fecha);
    const precioPago = magPago?.precio || null;
    const capitalKg = precioPago ? inv.capital / precioPago : 0;
    const interesKg = precioPago && interes > 0 ? interes / precioPago : 0;

    // Egreso 1: devolución del capital
    db.prepare(`INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, tc, fuente)
      VALUES (?, 'DEVOLUCION INVERSOR', ?, 0, ?, 0, ?, ?, ?, ?, ?, 'inversor')`)
      .run(fecha, `Devolución capital ${inv.inversor}`, inv.capital, capitalKg, precioPago, magPago?.semana || null, inv.inversor, precioPago || 0);
    // Egreso 2: intereses (si hay)
    if (interes > 0) {
      db.prepare(`INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, tc, fuente)
        VALUES (?, 'INTERESES', ?, 0, ?, 0, ?, ?, ?, ?, ?, 'inversor')`)
        .run(fecha, `Intereses inversor ${inv.inversor}`, interes, interesKg, precioPago, magPago?.semana || null, inv.inversor, precioPago || 0);
    }
    db.prepare("UPDATE inversores SET estado = 'PAGADO', deuda_actual = 0 WHERE id = ?").run(inv.id);

    return `✅ Inversor pagado!\n👤 ${inv.inversor}\n💵 Capital: $${fmt(inv.capital)} ARS · ${fmtKg(capitalKg)} kg\n📈 Intereses: $${fmt(interes)} ARS · ${fmtKg(interesKg)} kg\n📤 Salida total: $${fmt(deudaTotal)} ARS`;
  }

  // BORRAR TRANSACCIÓN (borrado real)
  if (accion.accion === "anular_transaccion" || accion.accion === "borrar_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id = ?").get(accion.id);
    if (!t) return "❌ No encontré esa transacción con ese ID.";
    db.prepare("DELETE FROM transacciones WHERE id = ?").run(accion.id);
    return `🗑️ Eliminado!\n📝 ${t.detalle || t.concepto}\n💰 ${t.egreso > 0 ? `-$${fmt(t.egreso)}` : `+$${fmt(t.ingreso)}`} ARS
📅 ${t.fecha}`;
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
    return `📊 *CC ${proveedor}*\n\n${lineas}\n\n💰 Saldo actual: $${fmt(saldo)} ARS`;
  }

  if (accion.accion === "ver_cuentas") {
    const cuentas = getResumenCuentasCorrientes();
    if (!cuentas.length) return "📋 No hay cuentas corrientes con saldo pendiente.";
    const lineas = cuentas.map(c =>
      `${c.saldo > 0 ? "🔴" : "🟢"} ${c.proveedor}: $${fmt(Math.abs(c.saldo))} ARS ${c.saldo > 0 ? "(debemos)" : "(a favor)"}`
    ).join("\n");
    const total = cuentas.reduce((s, c) => s + c.saldo, 0);
    return `🔄 *Cuentas Corrientes:*\n\n${lineas}\n\n💳 Total adeudado: $${fmt(total)} ARS`;
  }

  // VER CHEQUES
  if (accion.accion === "ver_cheques") {
    const cheques = getChequesPendientes();
    if (!cheques.length) return "✅ No hay cheques pendientes.";
    const lineas = cheques.map(c =>
      `${c.tipo === "EMITIDO" ? "📤" : "📥"} [#${c.id}] ${c.proveedor || "Sin prov."} · $${fmt(c.monto)} ARS · vence ${c.fecha_cobro || "sin fecha"}`
    ).join("\n");
    const total = cheques.reduce((s, c) => s + c.monto, 0);
    return `🏦 *Cheques pendientes:*\n\n${lineas}\n\n💳 Total: $${fmt(total)} ARS`;
  }

  // VER INVERSORES
  if (accion.accion === "ver_inversores") {
    const inversores = getInversoresActivos();
    if (!inversores.length) return "📋 No hay inversores activos.";
    const lineas = inversores.map(i => {
      const deuda = calcularDeudaInversor(i);
      return `👤 ${i.inversor}\n   Capital: $${fmt(i.capital)} · Tasa: ${(i.tasa * 100).toFixed(1)}%\n   Deuda actual: $${fmt(deuda)} ARS`;
    }).join("\n\n");
    const totalDeuda = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);
    return `👥 *Inversores activos:*\n\n${lineas}\n\n💳 Deuda total: $${fmt(totalDeuda)} ARS`;
  }

  // RESUMEN MES — acepta mes/año específico
  if (accion.accion === "resumen_mes") {
    // Detectar si piden un mes específico (ej: "marzo 2026" → fecha_desde en el JSON)
    const periodo = accion.periodo || new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT concepto, SUM(egreso_kg) as total_egreso, SUM(ingreso_kg) as total_ingreso,
             SUM(egreso) as total_egreso_ars, SUM(ingreso) as total_ingreso_ars
      FROM transacciones WHERE fecha LIKE ?
      GROUP BY concepto ORDER BY total_egreso DESC
    `).all(`${periodo}-%`);

    if (!rows.length) return `📊 No hay movimientos en ${periodo}.`;

    const totalEgresos = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
    const totalIngresos = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);
    const lineas = rows.filter(r => r.total_egreso > 0)
      .map(r => `  • ${r.concepto}: $${fmt(r.total_egreso)}`).join("\n");

    return `📊 *Resumen ${periodo}*\n\n${lineas || "Sin egresos"}\n\n📤 Total egresos: $${fmt(totalEgresos)} ARS
📥 Total ingresos: $${fmt(totalIngresos)} ARS
💰 Neto: $${fmt(totalIngresos - totalEgresos)} ARS`;
  }

  // RESUMEN POR PERÍODO
  if (accion.accion === "resumen_periodo") {
    const { fecha_desde, fecha_hasta } = accion;
    if (!fecha_desde || !fecha_hasta) return "❌ Necesito fecha_desde y fecha_hasta.";

    const rows = db.prepare(`
      SELECT concepto, SUM(egreso_kg) as total_egreso, SUM(ingreso_kg) as total_ingreso,
             SUM(egreso) as total_egreso_ars, SUM(ingreso) as total_ingreso_ars
      FROM transacciones WHERE fecha BETWEEN ? AND ?
      GROUP BY concepto ORDER BY total_egreso DESC
    `).all(fecha_desde, fecha_hasta);

    if (!rows.length) return `📊 No hay movimientos entre ${fecha_desde} y ${fecha_hasta}.`;

    const totalEgresos = rows.reduce((s, r) => s + (r.total_egreso || 0), 0);
    const totalIngresos = rows.reduce((s, r) => s + (r.total_ingreso || 0), 0);
    const lineas = rows.filter(r => r.total_egreso > 0)
      .map(r => `  • ${r.concepto}: $${fmt(r.total_egreso)}`).join("\n");

    return `📊 *Período ${fecha_desde} → ${fecha_hasta}*\n\n${lineas || "Sin egresos"}\n\n📤 Egresos: $${fmt(totalEgresos)} ARS
📥 Ingresos: $${fmt(totalIngresos)} ARS`;
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
      `${i+1}. [#${t.id}] ${t.concepto} · ${t.detalle} · ${t.egreso > 0 ? `-$${fmt(t.egreso)}` : `+$${fmt(t.ingreso)}`} ARS`
    ).join("\n");
    const total = rows.reduce((s, t) => s + t.egreso - t.ingreso, 0);

    return `📋 *Movimientos del ${fecha}:*\n\n${lineas}\n\n💰 Total del día: $${fmt(Math.abs(total))} ARS`;
  }

  // REGISTRAR DIVIDENDO (retiro de socio)
  if (accion.accion === "registrar_dividendo") {
    const { socio, monto, fecha, notas } = accion;
    if (!socio || !monto) return "❌ Falta socio o monto.";
    // Socios reales de Cabaña Amakaik
    const socios = ['JONATAN DASTOLFO', 'MARCOS GULLO'];
    const socioNorm = socios.find(s => s.toLowerCase().includes((socio||'').toLowerCase().split(' ')[0])) || socio.toUpperCase();

    // Conversión kg carne
    const fd = fecha || hoy;
    const magD = await getPrecioReferencia(fd);
    const precioD = magD?.precio || null;
    const montoNumD = parseFloat(monto);
    const montoKgD = precioD ? montoNumD / precioD : 0;

    db.prepare(`INSERT INTO dividendos (fecha, socio, monto, monto_kg, notas) VALUES (?, ?, ?, ?, ?)`)
      .run(fd, socioNorm, montoNumD, montoKgD, notas || '');
    // También registrar como egreso en transacciones para el flujo de caja
    db.prepare(`INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, es_cc, tc, fuente)
      VALUES (?, 'DIVIDENDOS', ?, 0, ?, 0, ?, ?, ?, ?, 0, ?, 'whatsapp')`)
      .run(fd, `Retiro ${socioNorm}`, montoNumD, montoKgD, precioD, magD?.semana || null, socioNorm, precioD || 0);
    const totalSocio = db.prepare(`SELECT COALESCE(SUM(monto_kg),0) as total FROM dividendos WHERE LOWER(socio) LIKE LOWER(?)`).get('%' + (socio.split(' ')[0]) + '%').total;
    return `✅ Dividendo registrado!\n👤 ${socioNorm}\n💰 $${fmt(montoNumD)} ARS · ${fmtKg(montoKgD)} kg\n📊 Total retirado por ${socioNorm.split(' ')[0]}: ${fmtKg(totalSocio)} kg carne`;
  }

  // VER DIVIDENDOS (por socio)
  if (accion.accion === "ver_dividendos") {
    const jonatan = db.prepare(`SELECT COALESCE(SUM(monto_kg),0) as total FROM dividendos WHERE LOWER(socio) LIKE '%jonatan%' OR LOWER(socio) LIKE '%dastolfo%'`).get().total;
    const marcos  = db.prepare(`SELECT COALESCE(SUM(monto_kg),0) as total FROM dividendos WHERE LOWER(socio) LIKE '%marcos%' OR LOWER(socio) LIKE '%gullo%'`).get().total;
    const ultimos = db.prepare(`SELECT * FROM dividendos ORDER BY fecha DESC LIMIT 10`).all();
    const lineas = ultimos.map(d => `  ${d.fecha} · ${d.socio.split(' ')[0]} · ${fmtKg(d.monto_kg)} kg`).join('\n');
    return `💰 *Dividendos / Retiros*\n\n👤 Jonatan Dastolfo: ${fmtKg(jonatan)} kg carne\n👤 Marcos Gullo: ${fmtKg(marcos)} kg carne\n📊 Total: ${fmtKg(jonatan + marcos)} kg carne\n\n*Últimos retiros:*\n${lineas || 'Sin retiros registrados'}`;
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
    return `✅ Item agregado!\n📝 ${descripcion}\n💰 ${fmt(cantidad||0)} ${unidad||'ha'} × $${fmt(precio_unitario||0)} = $${fmt(total)} ARS
📊 Total laboreo: $${fmt(totalLab)} ARS`;
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
    const lineas = labs.map(l => `🌱 [#${l.id}] ${l.lote} · ${l.tipo} · ${l.ciclo}\n   ${l.estado} · $${fmt(l.total_presupuestado)} ARS`).join("\n");
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
      `💰 Total: $${fmt(det.total_presupuestado)} ARS` +
      (costoPorHa ? `\n📐 Costo/ha: $${fmt(costoPorHa)} ARS` : '');
  }

  // ── CAMBIAR ESTADO LABOREO ──
  if (accion.accion === "ejecutar_laboreo") {
    const lab = db.prepare("SELECT * FROM laboreos WHERE id = ?").get(accion.id);
    if (!lab) return "❌ No encontré ese laboreo.";
    db.prepare("UPDATE laboreos SET estado = 'EJECUTADO', fecha_ejecucion = ? WHERE id = ?").run(hoy, accion.id);
    return `✅ Laboreo #${accion.id} marcado como EJECUTADO!\n📍 ${lab.lote} · ${lab.tipo}\n💰 Presupuestado: $${fmt(lab.total_presupuestado)} ARS`;
  }

  // ─── COMANDOS MAG ────────────────────────────────────────────────────────
  // Cargar precio MAG manual (fallback si el scraping falla):
  //   "cargar mag 4368.62"              → semana anterior (cerrada)
  //   "cargar mag W22 4159.83 cabezas 18871"  → semana específica
  if (accion.accion === "cargar_mag") {
    const precioIn = parseFloat(accion.precio);
    if (!precioIn || precioIn <= 0) return "❌ Precio inválido. Ej: 'cargar mag 4159.83' o 'cargar mag W22 4159.83'";

    let semInfo;
    const semanaInput = accion.semana_explicita || "";
    const matchSemanaCompleta = semanaInput.match(/^(\d{4})-W(\d{1,2})$/i);
    const matchSemanaCorta = semanaInput.match(/^W(\d{1,2})$/i);
    if (matchSemanaCompleta) {
      const anio = parseInt(matchSemanaCompleta[1]);
      const wk = parseInt(matchSemanaCompleta[2]);
      const lunes = new Date(anio, 0, 1);
      lunes.setDate(lunes.getDate() + (wk - 1) * 7);
      semInfo = getRangoSemana(lunes);
    } else if (matchSemanaCorta) {
      const wk = parseInt(matchSemanaCorta[1]);
      const anio = new Date().getFullYear();
      const lunes = new Date(anio, 0, 1);
      lunes.setDate(lunes.getDate() + (wk - 1) * 7);
      semInfo = getRangoSemana(lunes);
    } else {
      const nowD = new Date();
      const cualSemana = (accion.semana || "anterior").toLowerCase();
      semInfo = cualSemana === "actual" ? getRangoSemana(nowD) : getSemanaAnterior(nowD);
    }

    db.prepare(`
      INSERT OR REPLACE INTO precios_mag (semana, fecha_desde, fecha_hasta, precio_promedio, cabezas, fuente)
      VALUES (?, ?, ?, ?, ?, 'manual')
    `).run(semInfo.semana, semInfo.desde, semInfo.hasta, precioIn, parseInt(accion.cabezas) || 0);

    return `✅ Precio MAG cargado manualmente!\n📅 Semana ${semInfo.semana} (${semInfo.desde} → ${semInfo.hasta})\n💰 $${fmt(precioIn)}/kg${accion.cabezas ? `\n🐂 ${accion.cabezas} cabezas` : ""}`;
  }

  // Ver últimos precios MAG
  if (accion.accion === "ver_mag") {
    const ult = db.prepare("SELECT * FROM precios_mag ORDER BY semana DESC LIMIT 6").all();
    if (!ult.length) return "📊 No hay precios MAG cargados todavía.";
    const lineas = ult.map(p =>
      `📅 ${p.semana} (${p.fecha_desde} → ${p.fecha_hasta}): $${fmt(p.precio_promedio)}/kg${p.cabezas ? ` (${p.cabezas.toLocaleString("es-AR")} cab)` : ""}`
    ).join("\n");
    return `🐂 *Precios Índice Novillo MAG:*\n\n${lineas}`;
  }

  if (accion.accion === "texto") return accion.mensaje;

  // INFORME CICLO GANADERO
  if (accion.accion === "informe_ciclo") {
    const tipo = (accion.tipo === 'contable') ? 'contable' : 'productivo';
    const cicloStr = accion.ciclo || `${getCicloActual(tipo).ciclo}`;
    const informe = getInformeCiclo(cicloStr, tipo);
    if (!informe) return "❌ No pude interpretar el ciclo. Usá formato 25/26.";

    if (!informe.rows.length) return `📊 No hay movimientos en el ciclo ${informe.ciclo.tipo === 'contable' ? 'contable' : 'productivo'} ${informe.ciclo.label}.`;

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

    let msg = `📊 *VIDELA — Ciclo ${informe.ciclo.label}*\n`;
    msg += `📅 ${informe.ciclo.fecha_desde} → ${informe.fechaHasta}\n`;
    msg += `📋 ${informe.totalMovimientos} movimientos\n\n`;
    msg += lineas.join("\n");
    msg += `\n\n📤 Total egresos: $${fmt(informe.totalEgresos)} ARS`;
    msg += `\n📥 Total ingresos: $${fmt(informe.totalIngresos)} ARS`;
    msg += `\n💰 Neto: $${fmt(informe.totalIngresos - informe.totalEgresos)} ARS`;

    // Resumen de presupuesto total si hay
    const totalPresup = Object.values(informe.presupuestoMap).reduce((s, v) => s + v, 0);
    if (totalPresup > 0) {
      const pctTotal = ((informe.totalEgresos / totalPresup) * 100).toFixed(0);
      msg += `\n\n📐 Presupuesto total ciclo: $${fmt(totalPresup)} ARS`;
      msg += `\n📊 Ejecutado: ${pctTotal}%`;
    }

    return msg;
  }

  // SET PRESUPUESTO
  if (accion.accion === "set_presupuesto") {
    const cicloStr = accion.ciclo || getCicloActual().ciclo;
    const ciclo = parseCiclo(cicloStr);
    if (!ciclo) return "❌ Ciclo inválido. Usá formato 25/26.";
    if (!accion.concepto || !accion.monto_anual) return "❌ Necesito categoría y monto anual (en kg carne).";

    // El presupuesto se guarda en kg carne (unidad estable, inmune a inflación).
    // Además guardamos el equivalente ARS de referencia (al momento de crearlo)
    const magP = await getPrecioReferencia(new Date().toISOString().slice(0,10));
    const precioP = magP?.precio || 0;
    const montoKg = parseFloat(accion.monto_anual);
    const montoArs = montoKg * precioP;

    db.prepare(`
      INSERT INTO presupuestos (ciclo, concepto, monto_anual, monto_anual_ars)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ciclo, concepto) DO UPDATE SET monto_anual = excluded.monto_anual, monto_anual_ars = excluded.monto_anual_ars
    `).run(ciclo.ciclo, accion.concepto.toUpperCase(), montoKg, montoArs);

    return `✅ Presupuesto definido!\n📁 ${accion.concepto.toUpperCase()}\n📦 ${fmtKg(montoKg)} kg carne/año${precioP ? `\n💰 ~$${fmt(montoArs)} ARS (al precio actual)` : ""}\n📅 Ciclo ${ciclo.label}`;
  }

  // VER PRESUPUESTOS
  if (accion.accion === "ver_presupuestos") {
    const cicloStr = accion.ciclo || getCicloActual().ciclo;
    const ciclo = parseCiclo(cicloStr);
    if (!ciclo) return "❌ Ciclo inválido.";

    const presupuestos = db.prepare(
      "SELECT * FROM presupuestos WHERE ciclo = ? ORDER BY concepto"
    ).all(ciclo.ciclo);

    if (!presupuestos.length) return `📋 No hay presupuestos definidos para ciclo ${ciclo.label}.\nUsá "presupuesto [categoría] [monto en kg carne]" para crear uno.`;

    // Obtener gastos reales del ciclo — comparamos en kg carne
    const hoy = new Date().toISOString().slice(0, 10);
    const fechaHasta = ciclo.fecha_hasta < hoy ? ciclo.fecha_hasta : hoy;

    const lineas = presupuestos.map(p => {
      const real = db.prepare(`
        SELECT COALESCE(SUM(egreso_kg), 0) as total_kg,
               COALESCE(SUM(egreso), 0) as total_ars
        FROM transacciones
        WHERE concepto = ? AND fecha >= ? AND fecha <= ?
      `).get(p.concepto, ciclo.fecha_desde, fechaHasta);

      const gastadoKg = real.total_kg;
      const pct = p.monto_anual > 0 ? ((gastadoKg / p.monto_anual) * 100).toFixed(0) : "0";
      const warn = gastadoKg > p.monto_anual ? " ⚠️ EXCEDIDO" : "";
      const bar = gastadoKg > 0 ? ` [${"█".repeat(Math.min(Math.round(pct / 10), 10))}${"░".repeat(Math.max(10 - Math.round(pct / 10), 0))}]` : "";
      return `📁 ${p.concepto}\n   ${fmtKg(gastadoKg)} / ${fmtKg(p.monto_anual)} kg (${pct}%)${bar}${warn}`;
    });

    const totalPresupKg = presupuestos.reduce((s, p) => s + p.monto_anual, 0);
    return `📐 *Presupuestos — Ciclo ${ciclo.label}*\n\n${lineas.join("\n\n")}\n\n📦 Total presupuestado: ${fmtKg(totalPresupKg)} kg carne`;
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

    let msg = `📊 *VIDELA — ${meses[mes]} ${anio}*\n\n`;
    msg += lineas.join("\n");
    msg += `\n\n📤 Egresos: $${fmt(informe.totalEgresos)} ARS`;
    msg += `\n📥 Ingresos: $${fmt(informe.totalIngresos)} ARS`;
    msg += `\n💰 Neto: $${fmt(informe.totalIngresos - informe.totalEgresos)} ARS`;
    return msg;
  }

  // INFORME PDF (devuelve link)
  if (accion.accion === "informe_pdf") {
    const tipo = (accion.tipo === 'contable') ? 'contable' : 'productivo';
    const cicloStr = accion.ciclo || getCicloActual(tipo).ciclo;
    const ciclo = parseCiclo(cicloStr, tipo);
    if (!ciclo) return "❌ Ciclo inválido. Usá formato 25/26.";
    const url = `${PUBLIC_URL}/api/informe-pdf?ciclo=${encodeURIComponent(cicloStr)}&tipo=${tipo}`;
    const etiqueta = tipo === 'contable' ? 'Contable (jul→jun)' : 'Productivo (mar→feb)';
    return `📄 *Informe PDF — Ciclo ${etiqueta} ${ciclo.label}*\n\n📥 Descargá tu informe acá:\n${url}\n\nIncluye: desglose por categoría, evolución mensual y gastos mes a mes.`;
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
  const mag = await getPrecioReferencia(new Date().toISOString().slice(0,10));
  const precio = mag?.precio || 0;
  const hoy = new Date().toISOString().slice(0,10);

  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const imgResp = await fetch(mediaUrl, { headers: { Authorization: authHeader } });
  if (!imgResp.ok) throw new Error(`No pude descargar la imagen: ${imgResp.status}`);

  const buffer = await imgResp.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mime = (mediaType || 'image/jpeg').split(';')[0];

  const prompt = `Sos el asistente financiero de VIDELA, Cabaña Amakaik (empresa ganadera argentina).
Analiza esta imagen (ticket, factura o comprobante) y extrae los datos.
FECHA HOY: ${hoy}. TC BROU: ${tc ? `$${tc.toFixed(2)} ARS/kg carne` : 'no disponible'}.
MONEDA SISTEMA: ARS + kg carne. Cada monto en ARS se convierte a kg carne con precio MAG.
CATEGORIAS: ALQUILER, ALQUILER ESTRUCTURA, ALIMENTACION RECRIA, ALIMENTACION CRIA, TERMINACION, INSUMOS VETERINARIOS, TRABAJOS VETERINARIOS, COMBUSTIBLE CAMPO, COMBUSTIBLE VIATICOS, SUELDO JORNAL, SUELDO ENCARGADO, SUELDO ADM, VERDEOS Y PASTURAS, ESTRUCTURA GANADERA, MANTENIMIENTO CAMPO, MANTENIMIENTO MAQUINARIA, GASTOS VENTAS GANADERAS, INVERSION MAQUINARIA, COMPRA GANADO, COMPRA HERRAMIENTAS, BPS, GASTOS ADM, PROVISTA, VEHICULOS, TELEFONO, INTERESES, OTROS
Responde SOLO con JSON valido sin texto extra ni markdown:
{"encontrado":true,"fecha":"YYYY-MM-DD","concepto":"CATEGORIA","detalle":"descripcion breve","monto_uyu":0,"egreso_usd":0,"nota":"conversion u otros detalles"}
Si no es comprobante o no podes leer los datos: {"encontrado":false,"nota":"motivo"}
${bodyText ? `El usuario tambien escribio: "${bodyText}"` : ''}`;

  const result = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
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

  // La API de Claude no recibe audio: el bloque "document" sólo acepta PDF, y
  // por eso esta función fallaba en silencio. Para transcribir hace falta un
  // servicio de voz a texto aparte (Whisper o similar), todavía sin conectar.
  throw new Error("Todavía no puedo escuchar audios. Escribime el mensaje o mandame una foto.");
}

// ── PROCESADOR CENTRAL ────────────────────────────────────────────────────────
function campoDefaultTareas(){
  try { const r=db.prepare("SELECT nombre FROM campos ORDER BY orden LIMIT 1").get(); return r?r.nombre:null; } catch(e){ return null; }
}
function detectarConsultaPendientes(body){
  const b=(body||'').trim().toLowerCase(); if(!b) return false;
  if(/^(ver|mostr[a\u00e1]?r?|list[a\u00e1]r?|dame|pas[a\u00e1]me|cu[a\u00e1]les son|mis)\b.*(pendiente|tarea|para hacer|anot|nota|hacer)/.test(b)) return true;
  if(/^(pendiente|tarea)s?\b\s*\??$/.test(b)) return true;
  if(/(pendiente|tarea)s\b\s*\??$/.test(b)) return true;
  if(/qu[e\u00e9]\s+(hay|tengo|ten[e\u00e9]s|falta|me falta).*(hacer|pendiente|anotad)/.test(b)) return true;
  if(/qu[e\u00e9]\s+(anot[e\u00e9]|apunt[e\u00e9]|hay anotado|ten[i\u00ed]a anotado)/.test(b)) return true;
  if(/^(para hacer|to-?do)\s*\??$/.test(b)) return true;
  return false;
}
function detectarTareaHecha(body){
  const b=(body||'').trim(); const low=b.toLowerCase();
  const m=low.match(/^(list[oa]|hecho|terminad[oa]|termin[e\u00e9]|complet[e\u00e9]|completad[oa]|ya est[a\u00e1]|marc[a\u00e1]r?\s+(?:como\s+)?hecho)(?=\s|$|\d)/);
  if(!m) return null;
  const num=b.match(/\b(\d{1,3})\b/);
  let resto=b.slice(m[0].length).replace(/^\s*(el|la|los|las|lo de|de|n[\u00b0\u00ba]?|numero|nro\.?|#|tarea|pendiente)\s*/i,'').trim();
  return { n: num?parseInt(num[1]):null, texto: (!num && resto.length>2)?resto:null };
}
function detectarNotaCampo(body){
  const b=(body||'').trim(); if(!b) return null;
  const low=b.toLowerCase();
  const kw=low.match(/^(nota|not\u00e1|recordar|record\u00e1|recordatorio|acordate|acord\u00e1te|acordarme|anot\u00e1|anotar|anota|apunt\u00e1|apuntar|apunta|pendiente|tarea|hay que|para hacer|todo)\b[:\-\s]*/i);
  if(kw){ let t=b.slice(kw[0].length).trim().replace(/^(de|que)\s+/i,""); return t||null; }
  const tieneMonto=/\d[\d.,]*\s*(usd|uyu|u\$s|pesos|d[o\u00f3]lares)/i.test(low) || /\$\s*\d/.test(b) || /\d\s*\$/.test(b);
  if(!tieneMonto){
    const verbo=low.match(/^(arreglar|arregl\u00e1|revisar|revis\u00e1|reparar|repar\u00e1|cambiar|cambi\u00e1|cortar|limpiar|controlar|comprar|compr\u00e1|llamar|llam\u00e1|buscar|busc\u00e1|traer|tra\u00e9|llevar|llev\u00e1|marcar|apartar|sacar|poner|pon\u00e9|mandar|mand\u00e1|pedir|ped\u00ed|pintar|soldar|desmalezar|alambrar|vacunar|curar|mover|sembrar|fumigar|rociar|colocar|instalar|verificar|chequear|terminar)\b/i);
    if(verbo) return b;
  }
  return null;
}
async function procesarMensaje(body, mediaUrl, mediaType) {
  const usuario = "improlux";
  const historial = getHistorial(usuario);
  const hoy = new Date().toISOString().slice(0,10);
  const mag = await getPrecioReferencia(new Date().toISOString().slice(0,10));
  const precio = mag?.precio || 0;

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
        `💰 Monto: $${parseFloat(datos.egreso_usd).toFixed(2)} ARS` +
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

  // ── INTERCEPT INVERSORES (antes del LLM, para que registre sí o sí) ──
  {
    const b = (body || "").trim();
    const low = b.toLowerCase();
    const mencionaInv = /\binversor(es)?\b/.test(low);
    const esConsulta = /(cu[aá]nto|deuda|lista|listar|ver\b|mostr|estado|activos|total|qui[eé]n)/.test(low);
    const esPago = /(pag[aoóué]|devol|cerr|salda|liquid)/.test(low);

    if (mencionaInv && esPago) {
      const mn = b.match(/(?:pag[a-záéíóúñ]*|devol[a-záéíóúñ]*|cerr[a-záéíóúñ]*|salda[a-záéíóúñ]*|liquid[a-záéíóúñ]*)\s+(?:a\s+|al\s+)?(?:inversor\s+)?([a-záéíóúñ][a-záéíóúñ\s.]+)/i)
             || b.match(/inversor\s+([a-záéíóúñ][a-záéíóúñ\s.]+)/i);
      const nombre = mn ? mn[1].trim().replace(/\s+(hoy|ahora|ya)$/i, '') : null;
      if (nombre) {
        const resp = await ejecutarAccion({ accion: 'pago_inversor', inversor: nombre });
        historial.push({ role: "user", content: body }); historial.push({ role: "assistant", content: resp }); saveHistorial(usuario, historial);
        return resp;
      }
    }

    if (mencionaInv && !esConsulta && !esPago && /\d/.test(b)) {
      // Tasa: "7%" o "al 7"
      let tasa = null;
      const mt = b.match(/(\d+(?:[.,]\d+)?)\s*%/) || b.match(/\bal\s+(\d+(?:[.,]\d+)?)\b/i);
      if (mt) tasa = parseFloat(mt[1].replace(',', '.')) / 100;
      const bSinTasa = mt ? b.replace(mt[0], ' ') : b;
      // Capital: primer número (con miles/decimales)
      const mc = bSinTasa.match(/(\d[\d.]*(?:,\d+)?)/);
      const capital = mc ? parseFloat(mc[1].replace(/\./g, '').replace(',', '.')) : null;
      // Nombre: entre "inversor" y el primer dígito
      const mn = b.match(/inversor(?:es)?\s+([a-záéíóúñ][a-záéíóúñ\s.]+?)\s*\d/i);
      const nombre = mn ? mn[1].trim() : null;
      if (nombre && capital) {
        const resp = await ejecutarAccion({ accion: 'nuevo_inversor', inversor: nombre.toUpperCase(), capital, tasa: tasa || 0.08 });
        historial.push({ role: "user", content: body }); historial.push({ role: "assistant", content: resp }); saveHistorial(usuario, historial);
        return resp;
      }
    }
  }

  // \u2500\u2500 CONSULTA / GESTI\u00d3N DE PENDIENTES (leer y marcar hecho) \u2500\u2500
  {
    const campoP = campoDefaultTareas();
    const cond = campoP ? " AND campo=?" : "";
    const arg = campoP ? [campoP] : [];
    const hecha = detectarTareaHecha(body);
    let manejado = false;
    if (hecha) {
      const pend = db.prepare("SELECT id, texto FROM tareas_campo WHERE estado='PENDIENTE'"+cond+" ORDER BY id").all(...arg);
      let obj = null;
      if (hecha.n && hecha.n>=1 && hecha.n<=pend.length) obj = pend[hecha.n-1];
      else if (hecha.texto) obj = pend.find(t => (t.texto||'').toLowerCase().includes(hecha.texto.toLowerCase()));
      if (obj) {
        db.prepare("UPDATE tareas_campo SET estado='HECHO', done_at=datetime('now') WHERE id=?").run(obj.id);
        const rest = db.prepare("SELECT COUNT(*) n FROM tareas_campo WHERE estado='PENDIENTE'"+cond).get(...arg).n;
        const resp = `\u2705 Marcado como hecho: "${obj.texto}"\n\nQuedan ${rest} pendiente${rest===1?'':'s'}.`;
        historial.push({ role: "user", content: body }); historial.push({ role: "assistant", content: resp }); saveHistorial(usuario, historial);
        return resp;
      }
      manejado = true; // pidi\u00f3 marcar algo pero no lo encontr\u00e9 \u2192 muestro la lista
    }
    if (detectarConsultaPendientes(body) || manejado) {
      const pend = db.prepare("SELECT texto FROM tareas_campo WHERE estado='PENDIENTE'"+cond+" ORDER BY id").all(...arg);
      let resp;
      if (!pend.length) resp = `\ud83d\udccb No hay pendientes${campoP?` en ${campoP}`:''}. \ud83c\udf89`;
      else resp = `\ud83d\udccb *Pendientes${campoP?` \u00b7 ${campoP}`:''}* (${pend.length})\n\n` + pend.map((t,i)=>`${i+1}. ${t.texto}`).join('\n') + `\n\n_Para marcar una: escrib\u00ed "hecho 2" o "listo <lo que sea>"._`;
      historial.push({ role: "user", content: body }); historial.push({ role: "assistant", content: resp }); saveHistorial(usuario, historial);
      return resp;
    }
  }

  // \u2500\u2500 INTERCEPT NOTA / PENDIENTE DE CAMPO \u2500\u2500
  {
    const texto = detectarNotaCampo(body);
    if (texto) {
      const campo = campoDefaultTareas();
      db.prepare("INSERT INTO tareas_campo (campo, texto, estado, origen) VALUES (?,?, 'PENDIENTE', 'bot')").run(campo, texto);
      const resp = `\ud83d\udccc Anotado en pendientes${campo?` de ${campo}`:''}:\n"${texto}"\n\nLo ves y lo gest\u00edonas desde la app \u2192 Campo \u2192 Pendientes.`;
      historial.push({ role: "user", content: body }); historial.push({ role: "assistant", content: resp }); saveHistorial(usuario, historial);
      return resp;
    }
  }

  // \u2500\u2500 TEXTO NORMAL \u2500\u2500
  historial.push({ role: "user", content: body || "" });
  const contexto = await buildContexto();

  // Loop de tool-use: el modelo puede consultar la base (SELECT) las veces que necesite antes de responder.
  const mensajes = historial.map(m => ({ role: m.role, content: m.content }));
  let raw = "";
  let guard = 0;
  while (guard++ < 6) {
    const result = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: contexto,
      tools: [DASHBOARD_TOOL],
      messages: mensajes,
    });

    if (result.stop_reason === "tool_use") {
      mensajes.push({ role: "assistant", content: result.content });
      const toolResults = [];
      for (const bloque of result.content) {
        if (bloque.type === "tool_use") {
          const salida = bloque.name === "consultar_datos" ? consultarDB(bloque.input) : JSON.stringify({ error: "herramienta desconocida" });
          toolResults.push({ type: "tool_result", tool_use_id: bloque.id, content: salida });
        }
      }
      mensajes.push({ role: "user", content: toolResults });
      continue; // volver a llamar al modelo con los resultados
    }

    // Respuesta final (texto)
    raw = (result.content.filter(c => c.type === "text").map(c => c.text).join("\n")).trim();
    break;
  }

  historial.push({ role: "assistant", content: raw });
  saveHistorial(usuario, historial);

  const limpio = raw.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();

  // ── Detectar y ejecutar acción JSON ─────────────────────────────────────────
  // El modelo puede devolver una acción única {...} o un array [{...},{...}]
  // Si algo falla (JSON malformado, error del handler), logueamos y devolvemos
  // el error al usuario en vez de mostrar el JSON crudo.
  console.log("[procesarMensaje] raw response:", raw.substring(0, 300));

  try {
    // Multi-accion: array [{...},{...}]
    const matchArray = limpio.match(/\[[\s\S]*"accion"[\s\S]*\]/);
    if (matchArray) {
      let acciones;
      try {
        acciones = JSON.parse(matchArray[0]);
      } catch (parseErr) {
        console.error("[procesarMensaje] JSON array inválido:", parseErr.message);
        console.error("[procesarMensaje] Contenido:", matchArray[0].substring(0, 500));
        return `❌ El asistente generó una acción con formato inválido. Intentá reformular tu mensaje.\n\n_Detalle técnico: ${parseErr.message}_`;
      }
      if (Array.isArray(acciones) && acciones.length > 0) {
        const resultados = [];
        for (const accion of acciones) {
          if (accion?.accion) {
            try {
              resultados.push(await ejecutarAccion(accion));
            } catch (execErr) {
              console.error(`[procesarMensaje] Error ejecutando ${accion.accion}:`, execErr.message);
              console.error(execErr.stack);
              resultados.push(`❌ Error al ejecutar ${accion.accion}: ${execErr.message}`);
            }
          }
        }
        if (resultados.length > 0) return resultados.join("\n\n");
      }
    }
    // Acción única
    const matchSingle = limpio.match(/\{[\s\S]*"accion"[\s\S]*\}/);
    if (matchSingle) {
      let accion;
      try {
        accion = JSON.parse(matchSingle[0]);
      } catch (parseErr) {
        console.error("[procesarMensaje] JSON inválido:", parseErr.message);
        console.error("[procesarMensaje] Contenido:", matchSingle[0].substring(0, 500));
        return `❌ El asistente generó una acción con formato inválido. Intentá reformular tu mensaje.\n\n_Detalle técnico: ${parseErr.message}_`;
      }
      if (accion?.accion) {
        try {
          return await ejecutarAccion(accion);
        } catch (execErr) {
          console.error(`[procesarMensaje] Error ejecutando ${accion.accion}:`, execErr.message);
          console.error(execErr.stack);
          return `❌ Error al registrar (${accion.accion}): ${execErr.message}\n\n_Revisá los logs de Railway para el detalle técnico._`;
        }
      }
    }
    return limpio;
  } catch(err) {
    console.error("[procesarMensaje] Error inesperado:", err.message);
    console.error(err.stack);
    return `❌ Error procesando tu mensaje: ${err.message}`;
  }
}

// Ejecutar una acción ya parseada (usado por el chat de la app web)
app.post("/api/ejecutar-accion", async (req, res) => {
  try {
    const accion = req.body.accion || req.body;
    if (!accion || !accion.accion) return res.status(400).json({ error: "Falta la acción" });
    const respuesta = await ejecutarAccion(accion);
    res.json({ respuesta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// Envía uno o varios mensajes de WhatsApp (parte los largos, límite ~1500 chars)
async function enviarWhatsApp(from, to, texto) {
  let t = String(texto || "").trim();
  if (!t || !to) return;
  const MAX = 1500;
  const partes = [];
  while (t.length > MAX) {
    let corte = t.lastIndexOf("\n", MAX);
    if (corte < MAX * 0.6) corte = MAX;
    partes.push(t.slice(0, corte).trim());
    t = t.slice(corte).replace(/^\n+/, "");
  }
  if (t) partes.push(t);
  for (const p of partes) {
    await twilioClient.messages.create({ from, to, body: p });
  }
}

// ── WEBHOOK WHATSAPP ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Ack inmediato: Twilio corta a los ~15s, así que respondemos vacío y contestamos por API.
  res.type("text/xml").send("<Response></Response>");

  const to   = req.body.From;              // usuario que escribió
  const from = req.body.To || TWILIO_NUMBER; // número del bot (formato whatsapp:+...)
  try {
    const body      = (req.body.Body || "").trim();
    const numMedia  = parseInt(req.body.NumMedia || "0");
    const mediaUrl  = numMedia > 0 ? req.body.MediaUrl0 : null;
    const mediaType = numMedia > 0 ? (req.body.MediaContentType0 || "") : null;
    const respuesta = await procesarMensaje(body, mediaUrl, mediaType);
    await enviarWhatsApp(from, to, respuesta);
  } catch(err) {
    console.error("Error webhook:", err);
    try { await enviarWhatsApp(from, to, "❌ Ocurrió un error. Intentá de nuevo."); } catch(_) {}
  }
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
  const conSaldo = cuentas.map(c => ({
    ...c,
    saldo: getSaldoProveedor(c.proveedor),
    saldo_kg: getSaldoProveedorKg(c.proveedor)
  }));
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

app.get("/api/resumen", (req, res) => {
  const mesActual = new Date().toISOString().slice(0, 7);
  const eg = db.prepare(`SELECT SUM(egreso) as ars, SUM(egreso_kg) as kg FROM transacciones WHERE fecha LIKE ?`).get(`${mesActual}-%`);
  const ing = db.prepare(`SELECT SUM(ingreso) as ars, SUM(ingreso_kg) as kg FROM transacciones WHERE fecha LIKE ?`).get(`${mesActual}-%`);
  const chequesPend = db.prepare("SELECT COUNT(*) as total, SUM(monto) as monto, SUM(monto_kg) as monto_kg FROM cheques WHERE estado = 'PENDIENTE'").get();
  const inversores = getInversoresActivos();
  const totalDeuda = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);
  const totalMovimientos = db.prepare("SELECT COUNT(*) as total FROM transacciones").get();

  res.json({
    egresos_mes: eg?.ars || 0,
    egresos_mes_kg: eg?.kg || 0,
    ingresos_mes: ing?.ars || 0,
    ingresos_mes_kg: ing?.kg || 0,
    cheques_pendientes: chequesPend?.total || 0,
    monto_cheques: chequesPend?.monto || 0,
    monto_cheques_kg: chequesPend?.monto_kg || 0,
    deuda_inversores: totalDeuda,
    total_movimientos: totalMovimientos?.total || 0
  });
});

// ── API SOCIOS Y RETIROS ──────────────────────────────────────────────────────
// La tabla socios se auto-inicializa con Jonatan Dastolfo y Marcos Gullo.
app.get("/api/socios", (req, res) => {
  const socios = db.prepare("SELECT * FROM socios WHERE activo = 1 ORDER BY nombre").all();
  res.json(socios);
});

app.get("/api/retiros", (req, res) => {
  // Los retiros están en la tabla dividendos (heredada de IMPROLUX)
  const retiros = db.prepare(`
    SELECT id, fecha, socio, monto, monto_kg, notas
    FROM dividendos
    ORDER BY fecha DESC, id DESC
  `).all();
  res.json(retiros);
});

app.post("/api/retiros", express.json(), async (req, res) => {
  const { socio, monto_kg, monto, fecha, notas } = req.body || {};
  if (!socio || !(monto_kg || monto)) {
    return res.status(400).json({ error: "Faltan datos (socio, monto_kg o monto)" });
  }
  const hoy = new Date().toISOString().slice(0, 10);
  const fd = fecha || hoy;
  const mag = await getPrecioReferencia(fd);
  const precio = mag?.precio || null;

  // Aceptamos monto en kg (preferido) o en ARS (fallback)
  const montoKg = parseFloat(monto_kg) || (precio && monto ? parseFloat(monto) / precio : 0);
  const montoArs = parseFloat(monto) || (precio ? montoKg * precio : 0);

  const r = db.prepare(`
    INSERT INTO dividendos (fecha, socio, monto, monto_kg, notas)
    VALUES (?, ?, ?, ?, ?)
  `).run(fd, socio, montoArs, montoKg, notas || "");

  // También lo registramos en transacciones como egreso
  db.prepare(`
    INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, tc, fuente)
    VALUES (?, 'DIVIDENDOS', ?, 0, ?, 0, ?, ?, ?, ?, ?, 'dashboard')
  `).run(fd, `Retiro ${socio}`, montoArs, montoKg, precio, mag?.semana || null, socio, precio || 0);

  res.json({ ok: true, id: r.lastInsertRowid });
});

app.delete("/api/retiros/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const div = db.prepare("SELECT * FROM dividendos WHERE id = ?").get(id);
  if (!div) return res.status(404).json({ error: "No encontrado" });
  db.prepare("DELETE FROM dividendos WHERE id = ?").run(id);
  // También borrar la transacción asociada (por concepto+fecha+socio)
  db.prepare(`
    DELETE FROM transacciones
    WHERE concepto = 'DIVIDENDOS' AND fecha = ? AND proveedor = ? AND egreso = ?
  `).run(div.fecha, div.socio, div.monto);
  res.json({ ok: true });
});

// Composición de flujos: egresos, ingresos, y retiros por socio
app.get("/api/composicion-flujos", (req, res) => {
  const tx = db.prepare(`
    SELECT COALESCE(SUM(ingreso_kg), 0) as ing, COALESCE(SUM(egreso_kg), 0) as eg
    FROM transacciones
  `).get();
  const neto = (tx?.ing || 0) - (tx?.eg || 0);

  const retirosPorSocio = db.prepare(`
    SELECT s.nombre, COALESCE(SUM(d.monto_kg), 0) as total
    FROM socios s
    LEFT JOIN dividendos d ON LOWER(d.socio) LIKE '%' || LOWER(s.nombre) || '%'
      OR LOWER(d.socio) LIKE '%' || LOWER(SUBSTR(s.nombre, 1, INSTR(s.nombre, ' ') - 1)) || '%'
    WHERE s.activo = 1
    GROUP BY s.id, s.nombre
    ORDER BY s.nombre
  `).all();
  const totalRet = retirosPorSocio.reduce((s, x) => s + x.total, 0);
  const saldo = neto - totalRet;

  res.json({
    ingresos_kg: tx?.ing || 0,
    egresos_kg: tx?.eg || 0,
    resultado_kg: neto,
    retiros_por_socio: retirosPorSocio,
    total_retirado_kg: totalRet,
    saldo_no_distribuido_kg: saldo
  });
});

// Ciclos disponibles
app.get("/api/ciclos-disponibles", (req, res) => {
  const anios = db.prepare(`
    SELECT DISTINCT substr(fecha, 1, 4) as anio FROM transacciones
    WHERE fecha IS NOT NULL AND fecha != ''
    ORDER BY anio DESC
  `).all();
  const ciclos = new Set();
  for (const a of anios) {
    const anio = parseInt(a.anio);
    const cicloA = `${String(anio - 1).slice(2)}/${String(anio).slice(2)}`;
    const cicloB = `${String(anio).slice(2)}/${String(anio + 1).slice(2)}`;
    ciclos.add(cicloA);
    ciclos.add(cicloB);
  }
  // Agregar el ciclo actual si no está
  ciclos.add(getCicloActual().ciclo);
  res.json({ ciclos: Array.from(ciclos).sort().reverse() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// APORTES DE SOCIOS (patrimonio, NO afecta flujo operativo)
//
// Estos endpoints manejan la tabla `aportes_socios`. Los aportes son estructura
// (manga, aguadas, molinos, etc.) o ganado. Se cargan por socio, con fecha,
// monto (en kg carne o en ARS convertidos), y un detalle libre.
//
// El interés del 4% anual sobre la diferencia acumulada se calcula en el
// endpoint /api/aportes/intereses recorriendo día por día.
// ═══════════════════════════════════════════════════════════════════════════════

const TASA_APORTES_ANUAL = 0.04; // 4% anual en kg carne sobre la diferencia diaria

// Constante: cuántos días considera un año para prorratear (base 365)
const DIAS_ANIO = 365;

// GET /api/aportes → lista todos los aportes ordenados por fecha desc.
// Opcional: ?socio=jonatan filtra por socio.
app.get("/api/aportes", (req, res) => {
  const socio = req.query.socio;
  const rows = socio
    ? db.prepare("SELECT * FROM aportes_socios WHERE socio = ? ORDER BY fecha DESC, id DESC").all(socio)
    : db.prepare("SELECT * FROM aportes_socios ORDER BY fecha DESC, id DESC").all();
  res.json(rows);
});

// POST /api/aportes → registrar un nuevo aporte.
// Body: { socio, fecha?, monto_kg?, monto_ars?, detalle? }
// Si viene monto_ars y no monto_kg, se convierte con MAG del día.
// Si viene monto_kg y no monto_ars, se calcula el ARS de referencia con MAG del día.
app.post("/api/aportes", express.json(), async (req, res) => {
  const { socio, fecha, monto_kg, monto_ars, detalle } = req.body || {};
  if (!socio) return res.status(400).json({ error: "Falta socio" });
  if (!monto_kg && !monto_ars) return res.status(400).json({ error: "Falta monto (en kg o ARS)" });

  // Validar que el socio exista y esté activo
  const s = db.prepare("SELECT * FROM socios WHERE id = ? AND activo = 1").get(socio);
  if (!s) return res.status(404).json({ error: `Socio "${socio}" no existe o está inactivo` });

  const hoy = new Date().toISOString().slice(0, 10);
  const fd = fecha || hoy;

  // Precio MAG del día del aporte (para conversión)
  const mag = await getPrecioReferencia(fd);
  const precio = mag?.precio || null;

  let kg = parseFloat(monto_kg) || 0;
  let ars = parseFloat(monto_ars) || 0;
  if (kg && !ars && precio) ars = kg * precio;
  if (ars && !kg && precio) kg = ars / precio;
  if (!kg) return res.status(400).json({ error: "No hay precio MAG disponible para convertir ARS → kg. Cargá el monto en kg directamente." });

  const r = db.prepare(`
    INSERT INTO aportes_socios (socio, fecha, monto_kg, monto_ars, precio_mag, detalle)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(socio, fd, kg, ars, precio, detalle || "");

  res.json({ ok: true, id: r.lastInsertRowid, monto_kg: kg, monto_ars: ars, precio_mag: precio });
});

// DELETE /api/aportes/:id → borrar un aporte
app.delete("/api/aportes/:id", (req, res) => {
  const r = db.prepare("DELETE FROM aportes_socios WHERE id = ?").run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: "No encontrado" });
  res.json({ ok: true });
});

// GET /api/aportes/resumen → totales por socio + intereses acumulados.
// Retorna:
//   socios: [{ id, nombre, color_hex, total_kg, total_ars, n_aportes }]
//   diferencia_kg: cuánto más puso el que puso más
//   socio_mas: id del socio que puso más (a quien se le devengan intereses a favor)
//   socio_menos: id del socio que puso menos (el que debe intereses)
//   intereses_devengados_kg: total acumulado día por día hasta hoy (4% anual)
//   dias_transcurridos: días entre el primer aporte y hoy
app.get("/api/aportes/resumen", (req, res) => {
  const socios = db.prepare("SELECT * FROM socios WHERE activo = 1 ORDER BY nombre").all();
  const aportes = db.prepare("SELECT * FROM aportes_socios ORDER BY fecha ASC, id ASC").all();
  const cobros = db.prepare("SELECT * FROM intereses_cobros ORDER BY fecha ASC").all();
  const hoy = new Date().toISOString().slice(0, 10);

  // Totales por socio (planos, sin cálculo de intereses)
  // Aportes + compensaciones cuentan igual al saldo — la compensación puede ser +/-.
  const totalesPorSocio = {};
  socios.forEach(s => { totalesPorSocio[s.id] = { total_kg: 0, total_ars: 0, n_aportes: 0, n_compensaciones: 0 }; });
  aportes.forEach(a => {
    if (!totalesPorSocio[a.socio]) totalesPorSocio[a.socio] = { total_kg: 0, total_ars: 0, n_aportes: 0, n_compensaciones: 0 };
    totalesPorSocio[a.socio].total_kg += a.monto_kg || 0;
    totalesPorSocio[a.socio].total_ars += a.monto_ars || 0;
    if ((a.tipo || 'APORTE') === 'APORTE') totalesPorSocio[a.socio].n_aportes += 1;
    else totalesPorSocio[a.socio].n_compensaciones += 1;
  });

  // ── Cálculo de intereses día por día ────────────────────────────────────────
  // Estrategia:
  //   1. Recorremos día por día desde el primer aporte hasta hoy.
  //   2. Aplicamos aportes/compensaciones al saldo del día que corresponden.
  //   3. Calculamos la diferencia entre socios y devengamos 4% anual sobre ella.
  //   4. Si en un día hay una COMPENSACION con reseteo_intereses=1, RESETEAMOS
  //      los intereses acumulados hasta ese día — quedan en 0.
  //   5. Al final, restamos lo ya cobrado (intereses_cobros) para no cobrar
  //      dos veces.
  let interesesDevengadosKg = 0;
  let deudorId = null;
  let acreedorId = null;
  let diasTranscurridos = 0;

  if (aportes.length && socios.length >= 2) {
    const primeraFecha = aportes[0].fecha;
    const primerDia = new Date(primeraFecha + "T00:00:00");
    const hoyDate = new Date(hoy + "T00:00:00");
    diasTranscurridos = Math.max(0, Math.floor((hoyDate - primerDia) / (24 * 3600 * 1000)));

    const saldos = {};
    socios.forEach(s => { saldos[s.id] = 0; });

    // Aportes agrupados por fecha
    const aportesPorFecha = {};
    aportes.forEach(a => {
      if (!aportesPorFecha[a.fecha]) aportesPorFecha[a.fecha] = [];
      aportesPorFecha[a.fecha].push(a);
    });

    const tasaDiaria = TASA_APORTES_ANUAL / DIAS_ANIO;
    const cursor = new Date(primerDia);
    while (cursor <= hoyDate) {
      const fechaStr = cursor.toISOString().slice(0, 10);
      let reseteoHoy = false;
      if (aportesPorFecha[fechaStr]) {
        aportesPorFecha[fechaStr].forEach(a => {
          if (saldos[a.socio] !== undefined) saldos[a.socio] += a.monto_kg || 0;
          if (a.reseteo_intereses === 1) reseteoHoy = true;
        });
      }

      // Si hubo compensación que reseteó → los intereses acumulados vuelven a 0
      if (reseteoHoy) interesesDevengadosKg = 0;

      // Diferencia entre socios y devengamiento
      const ids = Object.keys(saldos);
      if (ids.length >= 2) {
        let max = -Infinity, min = Infinity, maxId = null, minId = null;
        ids.forEach(id => {
          if (saldos[id] > max) { max = saldos[id]; maxId = id; }
          if (saldos[id] < min) { min = saldos[id]; minId = id; }
        });
        const dif = max - min;
        if (dif > 0) {
          interesesDevengadosKg += dif * tasaDiaria;
          acreedorId = maxId;
          deudorId = minId;
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Restar los cobros ya realizados
  const totalCobradoKg = cobros.reduce((s, c) => s + (c.monto_kg || 0), 0);
  const interesesDisponiblesKg = Math.max(0, interesesDevengadosKg - totalCobradoKg);

  // Quién puso más HOY
  const totals = Object.entries(totalesPorSocio)
    .map(([id, t]) => ({ id, total_kg: t.total_kg }))
    .sort((a, b) => b.total_kg - a.total_kg);
  const socioMas = totals[0]?.id || null;
  const socioMenos = totals[totals.length - 1]?.id || null;
  const diferenciaKg = totals.length >= 2 ? (totals[0].total_kg - totals[totals.length - 1].total_kg) : 0;

  res.json({
    socios: socios.map(s => ({
      id: s.id,
      nombre: s.nombre,
      color_hex: s.color_hex,
      total_kg: totalesPorSocio[s.id]?.total_kg || 0,
      total_ars: totalesPorSocio[s.id]?.total_ars || 0,
      n_aportes: totalesPorSocio[s.id]?.n_aportes || 0,
      n_compensaciones: totalesPorSocio[s.id]?.n_compensaciones || 0
    })),
    total_general_kg: Object.values(totalesPorSocio).reduce((s, t) => s + t.total_kg, 0),
    diferencia_kg: diferenciaKg,
    socio_mas: socioMas,
    socio_menos: socioMenos,
    intereses_devengados_kg: interesesDevengadosKg,       // total histórico (bruto)
    intereses_cobrados_kg: totalCobradoKg,                 // ya cobrados
    intereses_disponibles_kg: interesesDisponiblesKg,      // pendientes de cobrar
    tasa_anual: TASA_APORTES_ANUAL,
    dias_transcurridos: diasTranscurridos,
    deudor: deudorId,
    acreedor: acreedorId
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPENSACIÓN entre socios (ajuste contable, NO afecta flujo)
//
// Un socio compensa a otro en X kg. Se registran DOS filas en aportes_socios
// linkeadas por grupo_id: al socio_origen (receptor) le RESTAMOS X kg, y al
// socio_destino (el que compensa) le SUMAMOS X kg.
//
// Si la compensación cubre TODA la diferencia acumulada actual entre ambos, se
// marca reseteo_intereses=1 en las filas → los intereses acumulados quedan en 0.
// Si la compensación es parcial (no cubre toda la diferencia), los intereses
// siguen corriendo sobre lo que quede.
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/aportes/compensacion
// Body: { socio_destino, socio_origen, monto_kg, fecha?, detalle? }
//   - socio_destino: quien está compensando (SUMA a su patrimonio)
//   - socio_origen: quien recibe la compensación (RESTA de su patrimonio)
//   - monto_kg: monto positivo en kg carne
app.post("/api/aportes/compensacion", express.json(), async (req, res) => {
  const { socio_destino, socio_origen, monto_kg, fecha, detalle } = req.body || {};
  if (!socio_destino || !socio_origen) return res.status(400).json({ error: "Faltan socios (destino y origen)" });
  if (socio_destino === socio_origen) return res.status(400).json({ error: "Los socios deben ser distintos" });
  const monto = parseFloat(monto_kg);
  if (!monto || monto <= 0) return res.status(400).json({ error: "Monto inválido" });

  // Validar que ambos socios existan
  const sDest = db.prepare("SELECT * FROM socios WHERE id = ? AND activo = 1").get(socio_destino);
  const sOrig = db.prepare("SELECT * FROM socios WHERE id = ? AND activo = 1").get(socio_origen);
  if (!sDest || !sOrig) return res.status(404).json({ error: "Alguno de los socios no existe" });

  const hoy = new Date().toISOString().slice(0, 10);
  const fd = fecha || hoy;

  // ¿La compensación cubre toda la diferencia actual? Si sí, resetea intereses.
  // Para saberlo, obtenemos el estado ACTUAL (antes de esta compensación).
  const totalesActuales = {};
  db.prepare("SELECT socio, COALESCE(SUM(monto_kg), 0) as total FROM aportes_socios GROUP BY socio").all().forEach(r => {
    totalesActuales[r.socio] = r.total;
  });
  const totOrig = totalesActuales[socio_origen] || 0;
  const totDest = totalesActuales[socio_destino] || 0;
  const diferenciaAntes = totOrig - totDest; // positivo si origen tenía más
  const cubreTodo = (monto >= diferenciaAntes - 0.01);
  const resetear = cubreTodo ? 1 : 0;

  const mag = await getPrecioReferencia(fd);
  const precio = mag?.precio || null;
  const montoArs = precio ? monto * precio : 0;

  const grupoId = 'compe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const detalleFinal = detalle || `Compensación ${sDest.nombre} → ${sOrig.nombre}`;

  // Fila 1: socio_destino SUMA (positivo)
  db.prepare(`
    INSERT INTO aportes_socios (tipo, socio, fecha, monto_kg, monto_ars, precio_mag, detalle, grupo_id, reseteo_intereses)
    VALUES ('COMPENSACION', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(socio_destino, fd, monto, montoArs, precio, detalleFinal, grupoId, resetear);

  // Fila 2: socio_origen RESTA (negativo)
  db.prepare(`
    INSERT INTO aportes_socios (tipo, socio, fecha, monto_kg, monto_ars, precio_mag, detalle, grupo_id, reseteo_intereses)
    VALUES ('COMPENSACION', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(socio_origen, fd, -monto, -montoArs, precio, detalleFinal, grupoId, resetear);

  res.json({
    ok: true,
    grupo_id: grupoId,
    monto_kg: monto,
    monto_ars: montoArs,
    resetea_intereses: !!resetear,
    diferencia_previa_kg: diferenciaAntes,
    mensaje: cubreTodo
      ? `Compensación completa. Los intereses acumulados hasta ${fd} quedan en 0.`
      : `Compensación parcial de ${monto} kg. Los intereses siguen corriendo sobre la diferencia restante.`
  });
});

// DELETE /api/aportes/compensacion/:grupo_id → borrar la compensación completa
// (borra las dos filas linkeadas)
app.delete("/api/aportes/compensacion/:grupo_id", (req, res) => {
  const r = db.prepare("DELETE FROM aportes_socios WHERE grupo_id = ?").run(req.params.grupo_id);
  if (!r.changes) return res.status(404).json({ error: "No encontré esa compensación" });
  res.json({ ok: true, filas_borradas: r.changes });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COBRO DE INTERESES (SÍ afecta flujo)
//
// El socio acreedor cobra los intereses acumulados. Se puede:
//   - Total  → cobra todos los intereses disponibles al día de hoy
//   - Parcial → cobra un monto específico, el resto sigue devengando
//
// El cobro genera:
//   1. Un dividendo (retiro) → egreso en el flujo de caja
//   2. Un registro en intereses_cobros → descuenta del bruto devengado
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/aportes/cobrar-intereses
// Body: { tipo_cobro: 'TOTAL' | 'PARCIAL', monto_kg?, fecha?, notas? }
app.post("/api/aportes/cobrar-intereses", express.json(), async (req, res) => {
  const { tipo_cobro, monto_kg, fecha, notas } = req.body || {};
  if (!tipo_cobro || (tipo_cobro !== 'TOTAL' && tipo_cobro !== 'PARCIAL')) {
    return res.status(400).json({ error: "tipo_cobro debe ser 'TOTAL' o 'PARCIAL'" });
  }

  // Recalcular intereses disponibles a la fecha
  const resumen = await new Promise((resolve, reject) => {
    // Llamado interno al endpoint /api/aportes/resumen
    const socios = db.prepare("SELECT * FROM socios WHERE activo = 1 ORDER BY nombre").all();
    const aportes = db.prepare("SELECT * FROM aportes_socios ORDER BY fecha ASC, id ASC").all();
    const cobros = db.prepare("SELECT * FROM intereses_cobros ORDER BY fecha ASC").all();
    const hoy = new Date().toISOString().slice(0, 10);

    let interesesBrutoKg = 0;
    let deudorId = null;
    let acreedorId = null;

    if (aportes.length && socios.length >= 2) {
      const primerDia = new Date(aportes[0].fecha + "T00:00:00");
      const hoyDate = new Date(hoy + "T00:00:00");
      const saldos = {};
      socios.forEach(s => { saldos[s.id] = 0; });
      const aportesPorFecha = {};
      aportes.forEach(a => {
        if (!aportesPorFecha[a.fecha]) aportesPorFecha[a.fecha] = [];
        aportesPorFecha[a.fecha].push(a);
      });
      const tasaDiaria = TASA_APORTES_ANUAL / DIAS_ANIO;
      const cursor = new Date(primerDia);
      while (cursor <= hoyDate) {
        const fs = cursor.toISOString().slice(0, 10);
        let reset = false;
        if (aportesPorFecha[fs]) {
          aportesPorFecha[fs].forEach(a => {
            if (saldos[a.socio] !== undefined) saldos[a.socio] += a.monto_kg || 0;
            if (a.reseteo_intereses === 1) reset = true;
          });
        }
        if (reset) interesesBrutoKg = 0;
        const ids = Object.keys(saldos);
        if (ids.length >= 2) {
          let max = -Infinity, min = Infinity, maxId = null, minId = null;
          ids.forEach(id => {
            if (saldos[id] > max) { max = saldos[id]; maxId = id; }
            if (saldos[id] < min) { min = saldos[id]; minId = id; }
          });
          const dif = max - min;
          if (dif > 0) {
            interesesBrutoKg += dif * tasaDiaria;
            acreedorId = maxId;
            deudorId = minId;
          }
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    const totalCobrado = cobros.reduce((s, c) => s + (c.monto_kg || 0), 0);
    resolve({
      disponibles_kg: Math.max(0, interesesBrutoKg - totalCobrado),
      acreedor: acreedorId,
      deudor: deudorId
    });
  });

  if (!resumen.acreedor) return res.status(400).json({ error: "No hay intereses devengados (ambos socios están parejos)" });
  if (resumen.disponibles_kg <= 0.01) return res.status(400).json({ error: "No hay intereses disponibles para cobrar" });

  const fd = fecha || new Date().toISOString().slice(0, 10);
  const disponibles = resumen.disponibles_kg;
  let cobroKg = tipo_cobro === 'TOTAL' ? disponibles : Math.min(parseFloat(monto_kg) || 0, disponibles);
  if (cobroKg <= 0) return res.status(400).json({ error: "Monto a cobrar inválido" });

  const mag = await getPrecioReferencia(fd);
  const precio = mag?.precio || null;
  const cobroArs = precio ? cobroKg * precio : 0;

  // 1. Crear el dividendo (retiro) — sale del flujo de caja
  const socioAcreedor = db.prepare("SELECT * FROM socios WHERE id = ?").get(resumen.acreedor);
  const nombreAcreedor = socioAcreedor?.nombre || resumen.acreedor;
  const divRes = db.prepare(`
    INSERT INTO dividendos (fecha, socio, monto, monto_kg, notas)
    VALUES (?, ?, ?, ?, ?)
  `).run(fd, nombreAcreedor, cobroArs, cobroKg, `Cobro intereses ${tipo_cobro.toLowerCase()} · ${notas || ''}`);
  const dividendoId = divRes.lastInsertRowid;

  // 2. Transacción (egreso del flujo)
  db.prepare(`
    INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, tc, fuente)
    VALUES (?, 'DIVIDENDOS', ?, 0, ?, 0, ?, ?, ?, ?, ?, 'aportes')
  `).run(fd, `Cobro intereses aportes (${nombreAcreedor})`, cobroArs, cobroKg, precio, mag?.semana || null, nombreAcreedor, precio || 0);

  // 3. Registrar en intereses_cobros para descontarlo del bruto en el próximo cálculo
  const cobroRes = db.prepare(`
    INSERT INTO intereses_cobros (fecha, socio_acreedor, socio_deudor, monto_kg, monto_ars, precio_mag, tipo_cobro, dividendo_id, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fd, resumen.acreedor, resumen.deudor, cobroKg, cobroArs, precio, tipo_cobro, dividendoId, notas || '');

  res.json({
    ok: true,
    id: cobroRes.lastInsertRowid,
    tipo_cobro,
    monto_kg: cobroKg,
    monto_ars: cobroArs,
    acreedor: resumen.acreedor,
    dividendo_id: dividendoId,
    intereses_restantes_kg: Math.max(0, disponibles - cobroKg),
    mensaje: `✅ ${nombreAcreedor} cobró ${cobroKg.toFixed(1)} kg carne. Sale del flujo como egreso operativo.`
  });
});

// GET /api/aportes/cobros → lista de cobros de intereses ya realizados
app.get("/api/aportes/cobros", (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, sa.nombre as acreedor_nombre, sd.nombre as deudor_nombre
    FROM intereses_cobros c
    LEFT JOIN socios sa ON sa.id = c.socio_acreedor
    LEFT JOIN socios sd ON sd.id = c.socio_deudor
    ORDER BY c.fecha DESC, c.id DESC
  `).all();
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS DE CARGA DIRECTA (para scripts de importación/backfill)
// Estos endpoints NO pasan por el bot — son REST puros para cargar datos crudos.
// Útil para migrar backups, cargar batch inicial, o recargar tras borrar volumen.
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/transacciones → crear una transacción cruda (sin pasar por bot).
// Body: { fecha, concepto, detalle?, ingreso?, egreso?, ingreso_kg?, egreso_kg?, precio_mag?, semana_mag?, proveedor? }
// Si vienen los _kg y no los ARS (o viceversa), se calcula el faltante con precio_mag.
app.post("/api/transacciones", express.json(), async (req, res) => {
  const b = req.body || {};
  if (!b.fecha || !b.concepto) return res.status(400).json({ error: "Faltan fecha o concepto" });

  const hoy = new Date().toISOString().slice(0, 10);
  const fecha = b.fecha || hoy;

  // Precio MAG: si vino en el body lo usamos, si no lo calculamos con el helper.
  let precio = parseFloat(b.precio_mag) || null;
  let semana = b.semana_mag || null;
  if (!precio || !semana) {
    const mag = await getPrecioReferencia(fecha);
    if (mag?.precio) { precio = mag.precio; semana = mag.semana; }
  }

  // Reconciliar ARS ↔ kg carne
  let ingreso = parseFloat(b.ingreso) || 0;
  let egreso = parseFloat(b.egreso) || 0;
  let ingreso_kg = parseFloat(b.ingreso_kg) || 0;
  let egreso_kg = parseFloat(b.egreso_kg) || 0;

  if (precio > 0) {
    if (ingreso && !ingreso_kg) ingreso_kg = ingreso / precio;
    if (egreso && !egreso_kg) egreso_kg = egreso / precio;
    if (ingreso_kg && !ingreso) ingreso = ingreso_kg * precio;
    if (egreso_kg && !egreso) egreso = egreso_kg * precio;
  }

  const r = db.prepare(`
    INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, es_cc, tc, fuente)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fecha, b.concepto.toUpperCase(), b.detalle || "",
    ingreso, egreso, ingreso_kg, egreso_kg,
    precio, semana,
    b.proveedor || "", b.es_cc ? 1 : 0, precio || 0, b.fuente || "rest-api"
  );

  res.json({
    ok: true, id: r.lastInsertRowid,
    fecha, concepto: b.concepto.toUpperCase(),
    ingreso, egreso, ingreso_kg, egreso_kg,
    precio_mag: precio, semana_mag: semana
  });
});

// POST /api/mag → cargar un precio MAG manual
// Body: { semana, fecha_desde, fecha_hasta, precio_promedio, cabezas?, fuente? }
app.post("/api/mag", express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.semana || !b.fecha_desde || !b.fecha_hasta || !b.precio_promedio) {
    return res.status(400).json({ error: "Faltan datos (semana, fecha_desde, fecha_hasta, precio_promedio)" });
  }
  db.prepare(`
    INSERT OR REPLACE INTO precios_mag (semana, fecha_desde, fecha_hasta, precio_promedio, cabezas, fuente)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    b.semana, b.fecha_desde, b.fecha_hasta,
    parseFloat(b.precio_promedio), parseInt(b.cabezas) || 0,
    b.fuente || "manual-import"
  );
  res.json({ ok: true, semana: b.semana, precio: parseFloat(b.precio_promedio) });
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

  // La comparación de presupuesto vs real se hace en KG CARNE (unidad estable).
  // El presupuesto se define en kg (monto_anual), y el gasto real acumulado
  // se toma de egreso_kg. Así el % ejecutado es correcto aunque haya inflación.
  const resultado = presupuestos.map(p => {
    const real = db.prepare(`
      SELECT COALESCE(SUM(egreso_kg), 0) as total_kg,
             COALESCE(SUM(egreso), 0) as total_ars
      FROM transacciones WHERE concepto = ? AND fecha >= ? AND fecha <= ?
    `).get(p.concepto, ciclo.fecha_desde, fechaHasta);
    return {
      ...p,
      gastado: real.total_kg,
      gastado_ars: real.total_ars,
      porcentaje: p.monto_anual > 0 ? ((real.total_kg / p.monto_anual) * 100) : 0
    };
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

app.delete("/api/presupuestos/:id", (req, res) => {
  db.prepare("DELETE FROM presupuestos WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Promedio histórico de egreso por categoría (sobre ciclos productivos COMPLETOS) → sugerencia de presupuesto
// En VIDELA la sugerencia se calcula en KG CARNE (unidad estable, inmune a inflación).
app.get("/api/presupuesto-sugerido", (req, res) => {
  const hoy = new Date().toISOString().slice(0, 10);
  const rows = db.prepare("SELECT concepto, fecha, egreso_kg FROM transacciones WHERE egreso_kg > 0").all();
  const porCatCiclo = {};
  const ciclosCompletos = new Set();
  for (const r of rows) {
    if (!r.fecha || r.fecha.length < 7) continue;
    const Y = parseInt(r.fecha.slice(0, 4));
    const M = parseInt(r.fecha.slice(5, 7));
    const anioInicio = M >= 3 ? Y : Y - 1;             // ciclo productivo mar→feb
    const finCiclo = `${anioInicio + 1}-02-29`;
    if (!(finCiclo < hoy)) continue;                   // solo ciclos ya cerrados
    ciclosCompletos.add(anioInicio);
    (porCatCiclo[r.concepto] = porCatCiclo[r.concepto] || {});
    porCatCiclo[r.concepto][anioInicio] = (porCatCiclo[r.concepto][anioInicio] || 0) + r.egreso_kg;
  }
  const nCiclos = ciclosCompletos.size;
  const promedios = {};
  Object.keys(porCatCiclo).forEach(cat => {
    const total = Object.values(porCatCiclo[cat]).reduce((s, v) => s + v, 0);
    promedios[cat] = nCiclos > 0 ? Math.round((total / nCiclos) * 100) / 100 : 0;
  });
  res.json({
    ciclos_completos: nCiclos,
    ciclos: [...ciclosCompletos].sort().map(y => `${String(y % 100).padStart(2, '0')}/${String((y + 1) % 100).padStart(2, '0')}`),
    promedio_por_categoria: promedios,
    unidad: 'kg carne (INMAG)'
  });
});

// ── BIENES MUEBLES (activos valuados con amortización lineal) ──────────────────
function calcBien(b) {
  const valor = parseFloat(b.valor_compra) || 0;
  const residual = parseFloat(b.valor_residual) || 0;
  const vida = parseFloat(b.vida_util_anios) || 1;
  const amortAnual = Math.max(0, (valor - residual) / vida);
  const anios = b.fecha_compra ? Math.max(0, (new Date() - new Date(b.fecha_compra)) / (365.25 * 24 * 3600 * 1000)) : 0;
  const base = Math.max(0, valor - residual);
  const amortAcum = Math.min(base, amortAnual * anios);
  const valorActual = Math.max(residual, valor - amortAcum);
  return {
    ...b,
    amort_anual: Math.round(amortAnual * 100) / 100,
    anios_transcurridos: Math.round(anios * 10) / 10,
    amort_acumulada: Math.round(amortAcum * 100) / 100,
    valor_actual: Math.round(valorActual * 100) / 100,
    pct_amortizado: base > 0 ? Math.round(Math.min(100, (amortAcum / base) * 100)) : 100,
    totalmente_amortizado: valorActual <= residual + 0.01
  };
}

app.get("/api/bienes", (req, res) => {
  const campo = req.query.campo;
  const rows = campo
    ? db.prepare("SELECT * FROM bienes_muebles WHERE activo = 1 AND campo = ? ORDER BY valor_compra DESC").all(campo)
    : db.prepare("SELECT * FROM bienes_muebles WHERE activo = 1 ORDER BY valor_compra DESC").all();
  res.json(rows.map(calcBien));
});

app.post("/api/bienes", (req, res) => {
  const { nombre, categoria, valor_compra, fecha_compra, vida_util_anios, valor_residual, notas, campo } = req.body;
  if (!nombre || !valor_compra || !fecha_compra) return res.status(400).json({ error: "Faltan datos (nombre, valor y fecha de compra)" });
  const r = db.prepare(`INSERT INTO bienes_muebles (nombre, categoria, valor_compra, fecha_compra, vida_util_anios, valor_residual, notas, campo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(nombre, categoria || '', parseFloat(valor_compra), fecha_compra, parseFloat(vida_util_anios) || 10, parseFloat(valor_residual) || 0, notas || '', (campo||'AMAKAIK').toUpperCase());
  res.json({ id: r.lastInsertRowid });
});

app.put("/api/bienes/:id", (req, res) => {
  const b = db.prepare("SELECT * FROM bienes_muebles WHERE id = ?").get(req.params.id);
  if (!b) return res.status(404).json({ error: "No encontrado" });
  const { nombre, categoria, valor_compra, fecha_compra, vida_util_anios, valor_residual, notas } = req.body;
  db.prepare(`UPDATE bienes_muebles SET nombre=?, categoria=?, valor_compra=?, fecha_compra=?, vida_util_anios=?, valor_residual=?, notas=? WHERE id=?`)
    .run(nombre ?? b.nombre, categoria ?? b.categoria, valor_compra !== undefined ? parseFloat(valor_compra) : b.valor_compra,
      fecha_compra ?? b.fecha_compra, vida_util_anios !== undefined ? parseFloat(vida_util_anios) : b.vida_util_anios,
      valor_residual !== undefined ? parseFloat(valor_residual) : b.valor_residual, notas ?? b.notas, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/bienes/:id", (req, res) => {
  db.prepare("DELETE FROM bienes_muebles WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Registrar la depreciación del ciclo como gasto (AMORTIZACION MAQUINARIA)
app.post("/api/bienes/amortizar", (req, res) => {
  const cicloObj = parseCiclo(req.body.ciclo || getCicloActual('productivo').ciclo, 'productivo');
  if (!cicloObj) return res.status(400).json({ error: "Ciclo inválido" });
  const hoy = new Date().toISOString().slice(0, 10);
  let fecha = cicloObj.fecha_hasta < hoy ? cicloObj.fecha_hasta : hoy;
  if (fecha.endsWith('-02-29')) fecha = fecha.replace('-02-29', '-02-28');

  const bienes = db.prepare("SELECT * FROM bienes_muebles WHERE activo = 1").all().map(calcBien);
  const yaHechos = new Set(db.prepare("SELECT bien_id FROM amortizaciones WHERE ciclo = ?").all(cicloObj.ciclo).map(r => r.bien_id));

  let saltados = 0;
  const elegibles = [];
  for (const b of bienes) {
    if (yaHechos.has(b.id)) { saltados++; continue; }
    if (b.amort_anual <= 0) continue;
    if (b.fecha_compra && b.fecha_compra > cicloObj.fecha_hasta) continue;   // el bien no existía en ese ciclo
    if (b.totalmente_amortizado) continue;                                    // ya llegó a valor residual
    elegibles.push(b);
  }
  const total = Math.round(elegibles.reduce((s, b) => s + b.amort_anual, 0) * 100) / 100;

  let creados = 0;
  if (elegibles.length > 0) {
    // UN solo item consolidado en Movimientos por todo el ciclo
    const detalle = `Depreciación maquinaria · ciclo ${cicloObj.ciclo} (${elegibles.length} bien${elegibles.length > 1 ? 'es' : ''})`;
    const t = db.prepare(`INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, tc, fuente)
      VALUES (?, 'AMORTIZACION MAQUINARIA', ?, 0, ?, '', 0, 'amortizacion')`).run(fecha, detalle, total);
    const insA = db.prepare("INSERT OR IGNORE INTO amortizaciones (bien_id, ciclo, monto, transaccion_id, fecha) VALUES (?, ?, ?, ?, ?)");
    for (const b of elegibles) insA.run(b.id, cicloObj.ciclo, b.amort_anual, t.lastInsertRowid, fecha);
    creados = elegibles.length;
  }
  res.json({ ok: true, ciclo: cicloObj.ciclo, creados, total, ya_existentes: saltados });
});

app.get("/api/bienes/amortizaciones", (req, res) => {
  const ciclo = req.query.ciclo;
  const rows = ciclo
    ? db.prepare("SELECT a.*, b.nombre FROM amortizaciones a LEFT JOIN bienes_muebles b ON b.id=a.bien_id WHERE a.ciclo=? ORDER BY a.created_at DESC").all(ciclo)
    : db.prepare("SELECT a.*, b.nombre FROM amortizaciones a LEFT JOIN bienes_muebles b ON b.id=a.bien_id ORDER BY a.created_at DESC").all();
  res.json(rows);
});

// Reemplazo: da de baja el viejo (con la pérdida/ganancia real de venta) y da de alta el nuevo
app.post("/api/bienes/reemplazar", (req, res) => {
  const { viejo_id, valor_venta, fecha_reemplazo, nuevo } = req.body;
  const viejo = db.prepare("SELECT * FROM bienes_muebles WHERE id = ?").get(viejo_id);
  if (!viejo) return res.status(404).json({ error: "No encontré el bien a reemplazar" });
  if (!nuevo || !nuevo.nombre || !nuevo.valor_compra || !nuevo.fecha_compra) return res.status(400).json({ error: "Faltan datos del bien nuevo (nombre, valor y fecha)" });

  const fecha = fecha_reemplazo || new Date().toISOString().slice(0, 10);
  const valorLibro = calcBien(viejo).valor_actual;      // valor de libro del viejo hoy
  const venta = parseFloat(valor_venta) || 0;
  const perdida = Math.round((valorLibro - venta) * 100) / 100;  // >0 pérdida · <0 ganancia

  // 1) Alta del bien nuevo
  const rNuevo = db.prepare(`INSERT INTO bienes_muebles (nombre, categoria, valor_compra, fecha_compra, vida_util_anios, valor_residual, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(nuevo.nombre, nuevo.categoria || '', parseFloat(nuevo.valor_compra), nuevo.fecha_compra,
      parseFloat(nuevo.vida_util_anios) || 10, parseFloat(nuevo.valor_residual) || 0, `Reemplaza a: ${viejo.nombre}`);

  // 2) Registrar la pérdida/ganancia real de la venta del viejo
  let transaccion = null;
  if (perdida > 0.01) {
    transaccion = db.prepare(`INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, tc, fuente)
      VALUES (?, 'AMORTIZACION MAQUINARIA', ?, 0, ?, '', 0, 'baja_bien')`)
      .run(fecha, `Pérdida por venta de ${viejo.nombre} (valor libro $${fmt(valorLibro)} − venta $${fmt(venta)})`, perdida).lastInsertRowid;
  } else if (perdida < -0.01) {
    transaccion = db.prepare(`INSERT INTO transacciones (fecha, concepto, detalle, ingreso, egreso, proveedor, tc, fuente)
      VALUES (?, 'AMORTIZACION MAQUINARIA', ?, ?, 0, '', 0, 'baja_bien')`)
      .run(fecha, `Ganancia por venta de ${viejo.nombre} (venta $${fmt(venta)} − valor libro $${fmt(valorLibro)})`, Math.abs(perdida)).lastInsertRowid;
  }

  // 3) Baja del viejo (archivado, no borrado)
  db.prepare("UPDATE bienes_muebles SET activo = 0, fecha_baja = ?, valor_venta = ? WHERE id = ?").run(fecha, venta, viejo_id);

  res.json({
    ok: true, nuevo_id: rNuevo.lastInsertRowid,
    valor_libro: valorLibro, valor_venta: venta, perdida,
    resultado: perdida > 0.01 ? 'perdida' : (perdida < -0.01 ? 'ganancia' : 'neutro'),
    transaccion
  });
});

// ── PROYECCIÓN DE CAJA (12 meses hacia adelante) ──────────────────────────────
app.get("/api/proyeccion", (req, res) => {
  const meses = parseInt(req.query.meses) || 12;
  // Caja inicial: saldo real desde el ciclo 25/26
  const desde = parseCiclo('25/26', 'productivo').fecha_desde;
  const c = db.prepare("SELECT COALESCE(SUM(ingreso_kg),0) ing, COALESCE(SUM(egreso_kg),0) egr FROM transacciones WHERE fecha >= ?").get(desde);
  let saldo = Math.round((c.ing - c.egr) * 100) / 100;

  // Perfil de gasto POR MES del ciclo 25/26 (no un promedio plano): cada mes calendario
  // usa lo que realmente se gastó ese mes (alquiler, siembra, etc. quedan reflejados).
  const cicloDesde = parseCiclo('25/26', 'productivo').fecha_desde;   // 2025-03-01
  const cicloHasta = parseCiclo('25/26', 'productivo').fecha_hasta;   // 2026-02-28
  const perfilRows = db.prepare(`SELECT substr(fecha,1,7) mes, COALESCE(SUM(egreso_kg),0) t FROM transacciones
    WHERE fecha >= ? AND fecha <= ? AND egreso > 0 AND fuente NOT IN ('amortizacion','inversor') GROUP BY mes`).all(cicloDesde, cicloHasta);
  const perfilMesCal = {};   // { '03': monto, '04': monto, ... }
  perfilRows.forEach(r => { const mm = r.mes.slice(5, 7); perfilMesCal[mm] = (perfilMesCal[mm] || 0) + r.t; });
  const valoresPerfil = Object.values(perfilMesCal);
  const promedioEgreso = valoresPerfil.length ? Math.round((valoresPerfil.reduce((a, b) => a + b, 0) / valoresPerfil.length) * 100) / 100 : 0;

  const ajustes = {};
  db.prepare("SELECT * FROM proyeccion_ajustes").all().forEach(a => ajustes[a.mes] = a);

  const hoy = new Date();
  const proyeccion = [];
  for (let i = 0; i < meses; i++) {
    const dfut = new Date(hoy.getFullYear(), hoy.getMonth() + i + 1, 1);
    const mes = dfut.toISOString().slice(0, 7);
    const mmCal = mes.slice(5, 7);
    const like = `${mes}-%`;
    // Cheques emitidos (a pagar) y recibidos (a cobrar) que vencen ese mes
    const chE = db.prepare("SELECT COALESCE(SUM(monto_kg),0) m FROM cheques WHERE estado='PENDIENTE' AND tipo='EMITIDO' AND fecha_cobro LIKE ?").get(like).m;
    const chR = db.prepare("SELECT COALESCE(SUM(monto_kg),0) m FROM cheques WHERE estado='PENDIENTE' AND tipo='RECIBIDO' AND fecha_cobro LIKE ?").get(like).m;
    const invs = db.prepare("SELECT * FROM inversores WHERE estado='ACTIVO' AND fecha_vencimiento LIKE ?").all(like);
    const invVenc = Math.round(invs.reduce((s, inv) => s + calcularDeudaInversor(inv), 0) * 100) / 100;

    const aj = ajustes[mes] || {};
    // Gasto estimado = ajuste manual, si no el gasto de ESE mes calendario en 25/26, si no el promedio
    const baseMes = (perfilMesCal[mmCal] != null) ? Math.round(perfilMesCal[mmCal] * 100) / 100 : promedioEgreso;
    const egresoEst = (aj.egreso_estimado != null) ? aj.egreso_estimado : baseMes;
    const ingresoEst = (aj.ingreso_estimado != null) ? aj.ingreso_estimado : 0;

    const saldoInicial = saldo;
    const totalIn = ingresoEst + chR;
    const totalOut = egresoEst + chE + invVenc;
    saldo = Math.round((saldoInicial + totalIn - totalOut) * 100) / 100;

    proyeccion.push({
      mes, saldo_inicial: saldoInicial,
      ingreso_estimado: ingresoEst, cheques_recibir: chR,
      egreso_estimado: egresoEst, cheques_pagar: chE, inversores: invVenc,
      saldo_final: saldo, editado: !!ajustes[mes], base_mes: baseMes
    });
  }
  res.json({ caja_inicial: Math.round((c.ing - c.egr) * 100) / 100, promedio_egreso: promedioEgreso, perfil_mensual: perfilMesCal, proyeccion });
});

app.post("/api/proyeccion/ajuste", (req, res) => {
  const { mes, egreso_estimado, ingreso_estimado, notas } = req.body;
  if (!mes) return res.status(400).json({ error: "Falta el mes" });
  db.prepare(`INSERT INTO proyeccion_ajustes (mes, egreso_estimado, ingreso_estimado, notas, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mes) DO UPDATE SET egreso_estimado=excluded.egreso_estimado, ingreso_estimado=excluded.ingreso_estimado, notas=excluded.notas, updated_at=datetime('now')`)
    .run(mes, egreso_estimado != null ? parseFloat(egreso_estimado) : null, ingreso_estimado != null ? parseFloat(ingreso_estimado) : null, notas || '');
  res.json({ ok: true });
});

app.delete("/api/proyeccion/ajuste/:mes", (req, res) => {
  db.prepare("DELETE FROM proyeccion_ajustes WHERE mes = ?").run(req.params.mes);
  res.json({ ok: true });
});

// ── NDVI SATELITAL (Sentinel-2 vía Copernicus Data Space) ─────────────────────
const COPERNICUS_ID = process.env.COPERNICUS_CLIENT_ID || "";
const COPERNICUS_SECRET = process.env.COPERNICUS_CLIENT_SECRET || "";
let _copToken = { valor: null, exp: 0 };

async function getCopernicusToken() {
  if (_copToken.valor && Date.now() < _copToken.exp) return _copToken.valor;
  if (!COPERNICUS_ID || !COPERNICUS_SECRET) throw new Error("Faltan credenciales de Copernicus (COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET)");
  const resp = await fetch("https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(COPERNICUS_ID)}&client_secret=${encodeURIComponent(COPERNICUS_SECRET)}`
  });
  const d = await resp.json();
  if (!d.access_token) throw new Error("No pude autenticar con Copernicus");
  _copToken = { valor: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return d.access_token;
}

// NDVI promedio del polígono de un lote (últimos N días, por pasada del satélite)
app.get("/api/lotes/:id/ndvi", async (req, res) => {
  try {
    const lote = db.prepare("SELECT * FROM lotes WHERE id = ?").get(req.params.id);
    if (!lote) return res.status(404).json({ error: "Lote no encontrado" });
    if (!lote.poligono) return res.status(400).json({ error: "El lote no tiene contorno dibujado" });

    const coords = JSON.parse(lote.poligono);              // [[lat,lng],...]
    // GeoJSON usa [lng,lat] y el anillo debe cerrar
    const ring = coords.map(c => [c[1], c[0]]);
    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);

    const dias = parseInt(req.query.dias) || 60;
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 86400000);
    const iso = d => d.toISOString().slice(0, 10);

    const token = await getCopernicusToken();
    const evalscript = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","dataMask"]}],output:[{id:"ndvi",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){let ndvi=(s.B08-s.B04)/(s.B08+s.B04);return{ndvi:[ndvi],dataMask:[s.dataMask]}}`;

    const body = {
      input: {
        bounds: { geometry: { type: "Polygon", coordinates: [ring] }, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
        data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: iso(desde) + "T00:00:00Z", to: iso(hasta) + "T23:59:59Z" }, maxCloudCoverage: 40 } }]
      },
      aggregation: {
        timeRange: { from: iso(desde) + "T00:00:00Z", to: iso(hasta) + "T23:59:59Z" },
        aggregationInterval: { of: "P5D" },
        evalscript,
        resx: 10, resy: 10
      },
      calculations: { ndvi: { statistics: { default: { percentiles: { k: [50] } } } } }
    };

    const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/statistics", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: "Error de Copernicus", detalle: d });

    // Parsear la serie: para cada intervalo con datos, el NDVI medio
    const serie = (d.data || []).map(item => {
      const st = item.outputs?.ndvi?.bands?.B0?.stats;
      return st && st.sampleCount > 0 && st.mean != null
        ? { fecha: (item.interval?.from || "").slice(0, 10), ndvi: Math.round(st.mean * 1000) / 1000 }
        : null;
    }).filter(Boolean);

    const ultimo = serie.length ? serie[serie.length - 1] : null;
    res.json({ lote: lote.nombre, ndvi_actual: ultimo ? ultimo.ndvi : null, fecha: ultimo ? ultimo.fecha : null, serie });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// NDVI de TODOS los lotes con contorno (para el ranking / comparación)
app.get("/api/ndvi-ranking", async (req, res) => {
  try {
    const campo = req.query.campo;
    const dias = parseInt(req.query.dias) || 30;
    const lotes = (campo
      ? db.prepare("SELECT * FROM lotes WHERE campo = ? AND poligono IS NOT NULL AND poligono != ''").all(campo)
      : db.prepare("SELECT * FROM lotes WHERE poligono IS NOT NULL AND poligono != ''").all());
    if (!lotes.length) return res.json({ ranking: [], sin_contorno: 0 });

    let token;
    try { token = await getCopernicusToken(); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 86400000);
    const iso = d => d.toISOString().slice(0, 10);
    const evalscript = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","dataMask"]}],output:[{id:"ndvi",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){let ndvi=(s.B08-s.B04)/(s.B08+s.B04);return{ndvi:[ndvi],dataMask:[s.dataMask]}}`;

    async function ndviDe(lote) {
      try {
        const coords = JSON.parse(lote.poligono);
        const ring = coords.map(c => [c[1], c[0]]);
        if (ring.length && (ring[0][0] !== ring[ring.length-1][0] || ring[0][1] !== ring[ring.length-1][1])) ring.push(ring[0]);
        const body = {
          input: { bounds: { geometry: { type: "Polygon", coordinates: [ring] }, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
            data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: iso(desde)+"T00:00:00Z", to: iso(hasta)+"T23:59:59Z" }, maxCloudCoverage: 40 } }] },
          aggregation: { timeRange: { from: iso(desde)+"T00:00:00Z", to: iso(hasta)+"T23:59:59Z" }, aggregationInterval: { of: "P30D" }, evalscript, resx: 10, resy: 10 },
          calculations: { ndvi: { statistics: { default: { percentiles: { k: [50] } } } } }
        };
        const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/statistics", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify(body) });
        const d = await r.json();
        const items = (d.data || []).filter(it => it.outputs?.ndvi?.bands?.B0?.stats?.sampleCount > 0);
        const last = items.length ? items[items.length-1] : null;
        const ndvi = last ? Math.round(last.outputs.ndvi.bands.B0.stats.mean * 1000) / 1000 : null;
        return { id: lote.id, nombre: lote.nombre, hectareas: lote.hectareas || 0, ndvi, fecha: last ? (last.interval?.from||"").slice(0,10) : null };
      } catch (e) { return { id: lote.id, nombre: lote.nombre, hectareas: lote.hectareas || 0, ndvi: null, error: true }; }
    }

    // Procesar de a tandas de 4 para no saturar
    const resultados = [];
    for (let i = 0; i < lotes.length; i += 4) {
      const tanda = await Promise.all(lotes.slice(i, i+4).map(ndviDe));
      resultados.push(...tanda);
    }
    resultados.sort((a, b) => (b.ndvi ?? -1) - (a.ndvi ?? -1));
    res.json({ ranking: resultados, dias });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CAMPOS (multi-campo) ──────────────────────────────────────────────────────
app.get("/api/campos", (req, res) => {
  const rows = db.prepare("SELECT * FROM campos WHERE activo = 1 ORDER BY orden, nombre").all();
  res.json(rows);
});

app.post("/api/campos", (req, res) => {
  const nombre = (req.body.nombre || '').trim().toUpperCase();
  if (!nombre) return res.status(400).json({ error: "Falta el nombre del campo" });
  try {
    const r = db.prepare("INSERT INTO campos (nombre, orden) VALUES (?, (SELECT COALESCE(MAX(orden),0)+1 FROM campos))").run(nombre);
    res.json({ id: r.lastInsertRowid, nombre });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Ya existe un campo con ese nombre' });
    res.status(400).json({ error: e.message });
  }
});

// ── DIARIO DE CAMPO (lluvias + acontecimientos) ───────────────────────────────
app.get("/api/diario", (req, res) => {
  const { campo, anio } = req.query;
  let q = "SELECT * FROM diario_campo WHERE 1=1";
  const p = [];
  if (campo) { q += " AND campo = ?"; p.push(campo); }
  if (anio) { q += " AND fecha LIKE ?"; p.push(`${anio}-%`); }
  q += " ORDER BY fecha DESC, id DESC";
  const registros = db.prepare(q).all(...p);

  // Resumen de lluvias por mes (del año/campo pedido, o de todo)
  let ql = "SELECT substr(fecha,1,7) mes, COALESCE(SUM(mm),0) mm, COUNT(*) dias FROM diario_campo WHERE tipo='LLUVIA'";
  const pl = [];
  if (campo) { ql += " AND campo = ?"; pl.push(campo); }
  if (anio) { ql += " AND fecha LIKE ?"; pl.push(`${anio}-%`); }
  ql += " GROUP BY mes ORDER BY mes";
  const lluviasPorMes = db.prepare(ql).all(...pl);
  const totalMm = lluviasPorMes.reduce((s, m) => s + (m.mm || 0), 0);

  res.json({ registros, lluvias_por_mes: lluviasPorMes, total_mm: Math.round(totalMm * 10) / 10 });
});

app.post("/api/diario", (req, res) => {
  const { campo, fecha, tipo, mm, titulo, detalle } = req.body;
  if (!fecha) return res.status(400).json({ error: "Falta la fecha" });
  const t = (tipo || (mm != null ? 'LLUVIA' : 'ACONTECIMIENTO')).toUpperCase();
  const r = db.prepare("INSERT INTO diario_campo (campo, fecha, tipo, mm, titulo, detalle) VALUES (?, ?, ?, ?, ?, ?)")
    .run((campo || 'AMAKAIK').toUpperCase(), fecha, t, (mm != null && mm !== '') ? parseFloat(mm) : null, titulo || '', detalle || '');
  res.json({ id: r.lastInsertRowid, ok: true });
});

app.delete("/api/diario/:id", (req, res) => {
  db.prepare("DELETE FROM diario_campo WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// \u2500\u2500 TAREAS / PENDIENTES DE CAMPO \u2500\u2500
app.get("/api/tareas", (req, res) => {
  let q="SELECT * FROM tareas_campo WHERE 1=1"; const p=[];
  if(req.query.campo){ q+=" AND campo=?"; p.push(req.query.campo); }
  if(req.query.estado){ q+=" AND estado=?"; p.push(req.query.estado); }
  q+=" ORDER BY (estado='HECHO'), COALESCE(done_at, created_at) DESC";
  try { res.json(db.prepare(q).all(...p)); } catch(e){ res.json([]); }
});
app.post("/api/tareas", (req, res) => {
  const { texto, campo, origen } = req.body || {};
  if(!texto || !String(texto).trim()) return res.status(400).json({ error: "Falta el texto" });
  const c = campo || campoDefaultTareas();
  const r = db.prepare("INSERT INTO tareas_campo (campo, texto, estado, origen) VALUES (?,?, 'PENDIENTE', ?)").run(c, String(texto).trim(), origen||'web');
  res.json({ ok:true, id:r.lastInsertRowid });
});
app.put("/api/tareas/:id", (req, res) => {
  const { estado, texto, campo } = req.body || {};
  db.prepare(`UPDATE tareas_campo SET estado=COALESCE(?,estado), texto=COALESCE(?,texto), campo=COALESCE(?,campo), done_at=CASE WHEN ?='HECHO' THEN datetime('now') WHEN ?='PENDIENTE' THEN NULL ELSE done_at END WHERE id=?`)
    .run(estado||null, texto||null, campo||null, estado||'', estado||'', req.params.id);
  res.json({ ok:true });
});
app.delete("/api/tareas/:id", (req, res) => {
  db.prepare("DELETE FROM tareas_campo WHERE id=?").run(req.params.id);
  res.json({ ok:true });
});

// ── STOCK GANADERO (hacienda valuada en kg de carne × precio IGU) ─────────────
function getIGU() {
  const row = db.prepare("SELECT valor, updated_at FROM config WHERE clave = 'precio_igu'").get();
  return { precio: row ? parseFloat(row.valor) || 0 : 0, actualizado: row ? row.updated_at : null };
}

// ── PATRIMONIO: caja + fondo reposición + ganado + bienes + stock ─────────────
function getPatrimonioActual() {
  // TODO EL PATRIMONIO EN KG DE CARNE. Los activos que ya están en kg (caja,
  // ganado) se usan tal cual; los que están en pesos (bienes, stock, deudas) se
  // dividen por el MAG de hoy. Mezclar unidades da un total sin sentido.
  let mag = 0;
  try { mag = (getPrecioReferenciaSync(new Date().toISOString().slice(0, 10)) || {}).precio || 0; } catch (e) {}
  const num = v => Number.isFinite(+v) ? +v : 0;
  const aKg = ars => mag > 0 ? Math.round((num(ars) / mag) * 100) / 100 : 0;

  // Caja: saldo acumulado desde el ciclo 25/26, ya en kg movimiento a movimiento.
  const desde = parseCiclo('25/26', 'productivo').fecha_desde;
  // Los movimientos viejos pueden no tener su valor en kg calculado: en ese
  // caso se convierte su importe en pesos al MAG de su propia fecha, que es lo
  // correcto — no al de hoy, porque eso borraría el efecto de la inflación.
  const c = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN ingreso_kg > 0 THEN ingreso_kg
                        WHEN ingreso > 0 AND precio_mag > 0 THEN ingreso / precio_mag
                        ELSE 0 END), 0) ing,
      COALESCE(SUM(CASE WHEN egreso_kg > 0 THEN egreso_kg
                        WHEN egreso > 0 AND precio_mag > 0 THEN egreso / precio_mag
                        ELSE 0 END), 0) egr,
      COALESCE(SUM(CASE WHEN ingreso > 0 AND ingreso_kg = 0 AND COALESCE(precio_mag,0) = 0 THEN 1
                        WHEN egreso  > 0 AND egreso_kg  = 0 AND COALESCE(precio_mag,0) = 0 THEN 1
                        ELSE 0 END), 0) sin_kg
    FROM transacciones WHERE fecha >= ?`).get(desde);
  const caja = Math.round((c.ing - c.egr) * 100) / 100;
  const movimientos_sin_kg = c.sin_kg || 0;

  // Fondo de reposición: amortizaciones resguardadas.
  const f = db.prepare("SELECT COALESCE(SUM(monto),0) fk FROM amortizaciones").get();
  const fondo = Math.round(num(f.fk) * 100) / 100;

  // Ganado: los kilos son directos, no hace falta convertir nada.
  const igu = getIGU().precio;
  const ganadoKg = db.prepare("SELECT * FROM stock_ganadero").all().reduce((s, r) => {
    const kg = r.kg_estimado || 0;
    const cabezas = (r.cantidad || 0) + (r.cantidad_venta || 0);
    // Con kg por cabeza son kilos de verdad; si sólo hay $/cabeza, se convierte.
    return s + (kg > 0 ? cabezas * kg : aKg(cabezas * (r.valor_cabeza || 0)));
  }, 0);
  const ganado = Math.round(ganadoKg * 100) / 100;

  // Bienes y stock están en pesos: se pasan a kg al precio de hoy.
  const bienesArs = db.prepare("SELECT * FROM bienes_muebles WHERE activo = 1").all()
    .map(calcBien).reduce((s, b) => s + (b.valor_actual || 0), 0);
  const bienes = aKg(bienesArs);
  const stockArs = getStockValorizado().reduce((s, p) => s + (p.valor || 0), 0);
  const stock = aKg(stockArs);

  // ── PASIVOS ──
  const chP = db.prepare("SELECT COALESCE(SUM(monto_kg),0) mk, COALESCE(SUM(monto),0) ma FROM cheques WHERE estado='PENDIENTE' AND tipo='EMITIDO'").get();
  const deuda_cheques = Math.round(((chP.mk || 0) || aKg(chP.ma || 0)) * 100) / 100;
  const deudaCcArs = getResumenCuentasCorrientes().reduce((s, c) => s + Math.max(parseFloat(c.saldo) || 0, 0), 0);
  const deuda_cc = aKg(deudaCcArs);
  const deudaInvArs = getInversoresActivos().reduce((s, i) => s + calcularDeudaInversor(i), 0);
  const deuda_inversores = aKg(deudaInvArs);

  const activos = Math.round(num(caja + fondo + ganado + bienes + stock) * 100) / 100;
  const pasivos = Math.round(num(deuda_cheques + deuda_cc + deuda_inversores) * 100) / 100;
  const total = Math.round(num(activos - pasivos) * 100) / 100;

  return {
    caja: num(caja), fondo: num(fondo), ganado: num(ganado),
    bienes: num(bienes), stock: num(stock),
    deuda_cheques: num(deuda_cheques), deuda_cc: num(deuda_cc),
    deuda_inversores: num(deuda_inversores),
    activos, pasivos, total,
    unidad: "kg", precio_mag: mag,
    // Si hay movimientos sin precio MAG no se pueden convertir: se avisa en vez
    // de mostrar un total que da por hecho que están todos.
    movimientos_sin_kg,
    // Referencia en pesos de hoy, para cuando haga falta el número del banco.
    ars: {
      total: Math.round(total * mag * 100) / 100,
      stock: Math.round(stockArs * 100) / 100,
      bienes: Math.round(bienesArs * 100) / 100,
      deuda_cc: Math.round(deudaCcArs * 100) / 100
    }
  };
}

app.get("/api/patrimonio", (req, res) => {
  const actual = getPatrimonioActual();
  const historial = db.prepare("SELECT * FROM patrimonio_snapshots ORDER BY fecha, ciclo").all();
  res.json({ actual, historial });
});

// Capturar una foto del patrimonio actual para un ciclo (reemplaza si ya existe ese ciclo)
app.post("/api/patrimonio/snapshot", (req, res) => {
  const p = getPatrimonioActual();
  const ciclo = req.body.ciclo || getCicloActual('productivo').ciclo;
  const cicloObj = parseCiclo(ciclo, 'productivo');
  const hoy = new Date().toISOString().slice(0, 10);
  let fecha = (cicloObj && cicloObj.fecha_hasta < hoy) ? cicloObj.fecha_hasta : hoy;
  if (fecha.endsWith('-02-29')) fecha = fecha.replace('-02-29', '-02-28');
  db.prepare(`INSERT INTO patrimonio_snapshots (ciclo, fecha, caja, ganado, bienes, stock, total, fondo, deuda_cheques, deuda_cc, deuda_inversores, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ciclo) DO UPDATE SET fecha=excluded.fecha, caja=excluded.caja, ganado=excluded.ganado,
      bienes=excluded.bienes, stock=excluded.stock, total=excluded.total, fondo=excluded.fondo,
      deuda_cheques=excluded.deuda_cheques, deuda_cc=excluded.deuda_cc, deuda_inversores=excluded.deuda_inversores, created_at=datetime('now')`)
    .run(ciclo, fecha, p.caja, p.ganado, p.bienes, p.stock, p.total, p.fondo, p.deuda_cheques, p.deuda_cc, p.deuda_inversores, req.body.notas || '');
  res.json({ ok: true, ciclo, fecha, ...p });
});

app.delete("/api/patrimonio/snapshot/:id", (req, res) => {
  db.prepare("DELETE FROM patrimonio_snapshots WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/ganado", (req, res) => {
  const campo = req.query.campo;
  const igu = getIGU();
  const rows = campo
    ? db.prepare("SELECT * FROM stock_ganadero WHERE campo = ? ORDER BY registro, categoria, id").all(campo)
    : db.prepare("SELECT * FROM stock_ganadero ORDER BY registro, categoria, id").all();
  const conValor = rows.map(r => {
    const kg = r.kg_estimado || 0;
    const usaIgu = kg > 0 && igu.precio > 0;
    const valPl = usaIgu ? Math.round((r.cantidad || 0) * kg * igu.precio * 100) / 100 : Math.round((r.cantidad || 0) * (r.valor_cabeza || 0) * 100) / 100;
    const valVt = usaIgu ? Math.round((r.cantidad_venta || 0) * kg * igu.precio * 100) / 100 : Math.round((r.cantidad_venta || 0) * (r.valor_cabeza || 0) * 100) / 100;
    return {
      ...r,
      cantidad_venta: r.cantidad_venta || 0,
      valor_plantel: valPl,
      valor_venta: valVt,
      valor: valPl + valVt,
      valuado_por: usaIgu ? 'igu' : 'cabeza'
    };
  });
  res.json({ igu: igu.precio, igu_actualizado: igu.actualizado, items: conValor });
});

app.post("/api/ganado/igu", (req, res) => {
  const precio = parseFloat(req.body.precio);
  if (!precio || precio <= 0) return res.status(400).json({ error: "Precio IGU inválido" });
  db.prepare(`INSERT INTO config (clave, valor, updated_at) VALUES ('precio_igu', ?, datetime('now'))
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now')`).run(String(precio));
  res.json({ ok: true, precio });
});

app.post("/api/ganado", (req, res) => {
  const { campo, categoria, registro, cantidad, cantidad_venta, kg_estimado, valor_cabeza, orden, notas } = req.body;
  if (!categoria) return res.status(400).json({ error: "Falta la categoría" });
  const r = db.prepare(`INSERT INTO stock_ganadero (campo, categoria, registro, cantidad, cantidad_venta, kg_estimado, valor_cabeza, orden, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(campo || 'AMAKAIK', categoria, (registro || 'GENERAL').toUpperCase(),
      parseFloat(cantidad) || 0, parseFloat(cantidad_venta) || 0, parseFloat(kg_estimado) || 0, parseFloat(valor_cabeza) || 0, parseInt(orden) || 0, notas || '');
  res.json({ id: r.lastInsertRowid });
});

app.put("/api/ganado/:id", (req, res) => {
  const g = db.prepare("SELECT * FROM stock_ganadero WHERE id = ?").get(req.params.id);
  if (!g) return res.status(404).json({ error: "No encontrado" });
  const { categoria, registro, cantidad, cantidad_venta, kg_estimado, valor_cabeza, orden, notas } = req.body;
  db.prepare(`UPDATE stock_ganadero SET categoria=?, registro=?, cantidad=?, cantidad_venta=?, kg_estimado=?, valor_cabeza=?, orden=?, notas=?, updated_at=datetime('now') WHERE id=?`)
    .run(categoria ?? g.categoria, (registro ?? g.registro ?? 'GENERAL').toUpperCase(),
      cantidad !== undefined ? parseFloat(cantidad) : g.cantidad,
      cantidad_venta !== undefined ? parseFloat(cantidad_venta) : g.cantidad_venta,
      kg_estimado !== undefined ? parseFloat(kg_estimado) : g.kg_estimado,
      valor_cabeza !== undefined ? parseFloat(valor_cabeza) : g.valor_cabeza,
      orden !== undefined ? parseInt(orden) : g.orden, notas ?? g.notas, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/ganado/:id", (req, res) => {
  db.prepare("DELETE FROM stock_ganadero WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Sincronizar cantidades del rodeo desde Angus del Este (server → server)
app.post("/api/ganado/sync-ade", async (req, res) => {
  // Cada campo del financiero tiene su par en el sistema ganadero.
  const PAR_GANADERO = {
    'CAMPO VIDELA': 'angus_la_posta',
    'EL TRIUNFO':   'el_triunfo',
    'LA GUAGUA':    'la_guagua'
  };
  const campoFin = String(req.body.campo || req.query.campo || '').toUpperCase().trim();
  const campoAde = req.body.campo_ade
    || PAR_GANADERO[campoFin]
    || process.env.ADE_CAMPO
    || 'angus_la_posta';
  try {
    const resp = await fetch(`${ADE_URL}/api/rodeo-resumen?campo=${encodeURIComponent(campoAde)}`);
    if (!resp.ok) return res.status(502).json({ error: `ADE respondió ${resp.status}. Verificá que el endpoint /api/rodeo-resumen exista y sea público.` });
    const data = await resp.json();
    // Tolerante al formato: array directo o envuelto en rodeo/categorias/data
    const lista = Array.isArray(data) ? data : (data.rodeo || data.categorias || data.data || []);
    if (!Array.isArray(lista) || !lista.length) {
      return res.json({ ok: true, actualizados: 0, creados: 0, mensaje: 'ADE no devolvió categorías', crudo: data });
    }
    const getByCatReg = db.prepare("SELECT * FROM stock_ganadero WHERE LOWER(categoria) = LOWER(?) AND LOWER(COALESCE(registro,'GENERAL')) = LOWER(?)");
    const upd = db.prepare("UPDATE stock_ganadero SET cantidad = ?, cantidad_venta = ?, origen = 'ade', updated_at = datetime('now') WHERE id = ?");
    const ins = db.prepare("INSERT INTO stock_ganadero (campo, categoria, registro, cantidad, cantidad_venta, kg_estimado, valor_cabeza, origen) VALUES ('AMAKAIK', ?, ?, ?, ?, 0, 0, 'ade')");
    let actualizados = 0, creados = 0, totalCab = 0;
    for (const it of lista) {
      const cat = it.categoria || it.category || it.nombre || it.cat;
      const reg = (it.registro || it.pedigree || 'GENERAL').toUpperCase();
      const plantel = parseFloat(it.plantel ?? it.cantidad ?? it.count ?? 0) || 0;
      const venta = parseFloat(it.venta ?? 0) || 0;
      if (!cat) continue;
      totalCab += plantel + venta;
      const ex = getByCatReg.get(cat, reg);
      if (ex) { upd.run(plantel, venta, ex.id); actualizados++; }
      else { ins.run(cat, reg, plantel, venta); creados++; }
    }
    res.json({ ok: true, actualizados, creados, total_cabezas: totalCab, categorias: lista.length });
  } catch (e) {
    res.status(502).json({ error: 'No pude conectar con ADE: ' + String(e.message).slice(0, 150) });
  }
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
    const tipo = (req.query.tipo === 'contable') ? 'contable' : 'productivo';
    const cicloStr = req.query.ciclo || getCicloActual(tipo).ciclo;
    const informe = getInformeCiclo(cicloStr, tipo);
    if (!informe) return res.status(400).json({ error: "Ciclo inválido" });

    // ¿Es el ciclo en curso? (define si mostramos cuentas/cheques/inversores — son estado ACTUAL)
    const esActual = informe.ciclo.label === getCicloActual(tipo).label;

    const mag = await getPrecioReferencia(new Date().toISOString().slice(0,10));
  const precio = mag?.precio || 0;
    const cuentas = esActual ? getResumenCuentasCorrientes() : [];
    const cheques = esActual ? getChequesPendientes() : [];
    const inversores = esActual ? getInversoresActivos() : [];
    const totalDeudaInv = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);

    // Desglose mensual del ciclo (arranca en el mes de inicio del ciclo: mar productivo / jul contable)
    const mesesNombres = ["","Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
    const desgloseMensual = [];
    const cicloData = informe.ciclo;
    const anioInicio = parseInt(cicloData.fecha_desde.slice(0, 4));
    const mesInicio = cicloData.mesInicio || 3;
    for (let m = mesInicio; m <= mesInicio + 11; m++) {
      const mesReal = ((m - 1) % 12) + 1;
      const anioReal = anioInicio + Math.floor((m - 1) / 12);
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
    res.setHeader('Content-Disposition', `inline; filename="VIDELA_Ciclo_${cicloStr.replace('/', '-')}.pdf"`);
    doc.pipe(res);

    // Paleta del sistema (azul / dorado / paper)
    const colorVerde = '#0B3D7C';        // "brand" — ahora AZUL (se usa en headers y barras)
    const colorAzulProfundo = '#0F2847'; // banner (como el sidebar)
    const colorGold = '#C9A24B';         // acento dorado
    const colorGris = '#5C6B7E';
    const colorNegro = '#10243F';
    const colorFondo = '#F4F1EA';        // paper (filas alternas)
    const colorLinea = '#D8D0C0';

    // ── ENCABEZADO ──
    doc.rect(0, 0, doc.page.width, 100).fill(colorAzulProfundo);
    doc.rect(0, 100, doc.page.width, 3).fill(colorGold);   // línea dorada (como el subrayado activo)
    doc.fontSize(28).fill('#ffffff').font('Helvetica-Bold')
       .text('VIDELA', 50, 30);
    doc.fontSize(13).fill('#e8dcc0').font('Times-Italic')
       .text(`Informe de Ciclo ${informe.ciclo.tipo === 'contable' ? 'Contable' : 'Productivo'} ${informe.ciclo.label}`, 50, 62);
    doc.fontSize(9).fill('#a9bdd6').font('Helvetica')
       .text(`Generado: ${new Date().toLocaleDateString('es-UY')} | ${informe.ciclo.tipo === 'contable' ? 'Contable (jul→jun)' : 'Productivo (mar→feb)'} | Período: ${informe.ciclo.fecha_desde} → ${informe.fechaHasta}`, 50, 82);

    let y = 120;

    // ── RESUMEN EJECUTIVO ──
    doc.fontSize(15).fill(colorVerde).font('Times-Italic')
       .text('Resumen Ejecutivo', 50, y);
    y += 25;

    // Cajas de KPI
    const kpis = [
      { label: 'Total Egresos', valor: `$${fmt(informe.totalEgresos)} ARS`, color: '#B83232' },
      { label: 'Total Ingresos', valor: `$${fmt(informe.totalIngresos)} ARS`, color: '#1a7a4a' },
      { label: 'Resultado Neto', valor: `$${fmt(informe.totalIngresos - informe.totalEgresos)} ARS`, color: (informe.totalIngresos - informe.totalEgresos) >= 0 ? '#1a7a4a' : '#B83232' },
      { label: 'Movimientos', valor: `${informe.totalMovimientos}`, color: colorVerde }
    ];

    const kpiWidth = 120;
    const kpiGap = 10;
    kpis.forEach((kpi, i) => {
      const x = 50 + i * (kpiWidth + kpiGap);
      doc.rect(x, y, kpiWidth, 55).fill(colorFondo).stroke(colorLinea);
      doc.fontSize(8).fill(colorGris).font('Helvetica').text(kpi.label, x + 8, y + 8, { width: kpiWidth - 16 });
      doc.fontSize(14).fill(kpi.color).font('Times-Italic').text(kpi.valor, x + 8, y + 24, { width: kpiWidth - 16 });
    });
    y += 75;

    if (tc) {
      doc.fontSize(8).fill(colorGris).font('Helvetica')
         .text(`TC BROU: $${tc.toFixed(2)} ARS/kg carne`, 50, y);
      y += 18;
    }

    // ── DESGLOSE POR CATEGORÍA ──
    doc.fontSize(15).fill(colorVerde).font('Times-Italic')
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
      doc.fill(r.total_egreso > 0 ? '#B83232' : colorGris)
         .text(r.total_egreso > 0 ? `$${fmt(r.total_egreso)}` : '-', 240, y + 4, { width: 80, align: 'right' });
      doc.fill(r.total_ingreso > 0 ? '#1a7a4a' : colorGris)
         .text(r.total_ingreso > 0 ? `$${fmt(r.total_ingreso)}` : '-', 325, y + 4, { width: 80, align: 'right' });
      doc.fill(colorGris)
         .text(presup ? `$${fmt(presup)}` : '-', 410, y + 4, { width: 65, align: 'right' });
      doc.fill(excedido ? '#B83232' : colorNegro).font(excedido ? 'Helvetica-Bold' : 'Helvetica')
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
    doc.fontSize(15).fill(colorVerde).font('Times-Italic')
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
      doc.fill('#B83232').text(`$${fmt(m.egresos)}`, 160, y + 4, { width: 100, align: 'right' });
      doc.fill('#1a7a4a').text(`$${fmt(m.ingresos)}`, 265, y + 4, { width: 100, align: 'right' });
      doc.fill(neto >= 0 ? '#1a7a4a' : '#B83232').font('Helvetica-Bold')
         .text(`$${fmt(neto)}`, 370, y + 4, { width: 100, align: 'right' });
      doc.fill(colorGris).font('Helvetica').text(`${m.cant}`, 475, y + 4, { width: 65, align: 'right' });
      y += 16;
    });
    y += 20;

    // ── Nota: en ciclos pasados omitimos cuentas/cheques/inversores (son estado actual, no del cierre) ──
    if (!esActual) {
      if (y > 700) { doc.addPage(); y = 50; }
      doc.fontSize(8).fill(colorGris).font('Helvetica-Oblique')
         .text('Nota: cuentas corrientes, cheques pendientes e inversores se muestran solo en el informe del ciclo en curso, ya que reflejan el estado de hoy y no el del cierre de este ciclo.', 50, y, { width: 495 });
      y += 22;
    }

    // ── CUENTAS CORRIENTES ──
    if (cuentas.length > 0) {
      if (y > 620) { doc.addPage(); y = 50; }
      doc.fontSize(15).fill(colorVerde).font('Times-Italic')
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
        doc.fill(c.saldo > 0 ? '#B83232' : '#1a7a4a').font('Helvetica-Bold')
           .text(`$${fmt(Math.abs(c.saldo))} ${c.saldo > 0 ? '(debemos)' : '(a favor)'}`, 220, y + 4, { width: 120, align: 'right' });
        y += 16;
      });
      const totalCC = cuentas.reduce((s, c) => s + c.saldo, 0);
      doc.fontSize(9).fill(colorNegro).font('Helvetica-Bold')
         .text(`Total adeudado: $${fmt(totalCC)} ARS`, 50, y + 5);
      y += 25;
    }

    // ── CHEQUES PENDIENTES ──
    if (cheques.length > 0) {
      if (y > 650) { doc.addPage(); y = 50; }
      doc.fontSize(15).fill(colorVerde).font('Times-Italic')
         .text('Cheques Pendientes', 50, y);
      y += 22;

      cheques.forEach((c, i) => {
        if (y > 720) { doc.addPage(); y = 50; }
        doc.fontSize(8).fill(colorNegro).font('Helvetica');
        const emoji = c.tipo === "EMITIDO" ? "→" : "←";
        doc.text(`${emoji} ${c.tipo} | ${c.proveedor || 'Sin prov.'} | $${fmt(c.monto)} ARS | vence: ${c.fecha_cobro || 'sin fecha'}`, 55, y);
        y += 14;
      });
      const totalCheq = cheques.reduce((s, c) => s + c.monto, 0);
      doc.fontSize(9).fill(colorNegro).font('Helvetica-Bold')
         .text(`Total cheques pendientes: $${fmt(totalCheq)} ARS`, 50, y + 3);
      y += 25;
    }

    // ── INVERSORES ──
    if (inversores.length > 0) {
      if (y > 620) { doc.addPage(); y = 50; }
      doc.fontSize(15).fill(colorVerde).font('Times-Italic')
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
        doc.fill('#B83232').font('Helvetica-Bold')
           .text(`$${fmt(deuda)}`, 415, y + 4, { width: 80, align: 'right' });
        y += 16;
      });
      doc.fontSize(9).fill(colorNegro).font('Helvetica-Bold')
         .text(`Deuda total inversores: $${fmt(totalDeudaInv)} ARS`, 50, y + 5);
    }

    // ── GASTOS POR CATEGORÍA (MES A MES) — página apaisada ──
    {
      const mesesAbr = ["","Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
      const anioIni = parseInt(informe.ciclo.fecha_desde.slice(0, 4));
      const mIni = informe.ciclo.mesInicio || 3;
      const hoyMes = new Date().toISOString().slice(0, 7);
      const mesesCols = [];
      for (let m = mIni; m <= mIni + 11; m++) {
        const mesReal = ((m - 1) % 12) + 1;
        const anioReal = anioIni + Math.floor((m - 1) / 12);
        const periodo = `${anioReal}-${String(mesReal).padStart(2, '0')}`;
        if (periodo > hoyMes) break;
        mesesCols.push({ periodo, label: `${mesesAbr[mesReal]}${String(anioReal).slice(2)}` });
      }
      const matrizRows = db.prepare(`
        SELECT concepto, substr(fecha,1,7) as periodo, SUM(egreso) as egreso
        FROM transacciones
        WHERE fecha >= ? AND fecha <= ? AND egreso > 0
        GROUP BY concepto, periodo
      `).all(informe.ciclo.fecha_desde, informe.fechaHasta);
      const matriz = {};
      matrizRows.forEach(r => { (matriz[r.concepto] = matriz[r.concepto] || {})[r.periodo] = r.egreso; });
      const cats = informe.rows.filter(r => r.total_egreso > 0).map(r => r.concepto);
      const fmtInt = n => n ? Math.round(n).toLocaleString('es-UY') : '';

      if (cats.length && mesesCols.length) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 });
        const L = 40, catW = 128, totW = 58;
        const monthsX = L + catW;
        const totX = doc.page.width - L - totW;
        const colW = (totX - monthsX) / mesesCols.length;

        let ly = 45;
        doc.fontSize(15).fill(colorVerde).font('Times-Italic')
           .text('Gastos por Categoría — mes a mes (ARS)', L, ly);
        ly += 22;

        const drawHeader = () => {
          doc.rect(L, ly, doc.page.width - 2 * L, 16).fill(colorVerde);
          doc.fontSize(6.5).fill('#ffffff').font('Helvetica-Bold');
          doc.text('Categoría', L + 4, ly + 5, { width: catW - 6, lineBreak: false });
          mesesCols.forEach((mc, i) => doc.text(mc.label, monthsX + i * colW, ly + 5, { width: colW - 2, align: 'right', lineBreak: false }));
          doc.text('Total', totX, ly + 5, { width: totW - 4, align: 'right', lineBreak: false });
          ly += 16;
        };
        drawHeader();

        cats.forEach((cat, idx) => {
          if (ly > 545) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 }); ly = 45; drawHeader(); }
          const bg = idx % 2 === 0 ? '#ffffff' : colorFondo;
          doc.rect(L, ly, doc.page.width - 2 * L, 13).fill(bg);
          doc.fontSize(6.5).fill(colorNegro).font('Helvetica').text(cat, L + 4, ly + 3.5, { width: catW - 6, lineBreak: false });
          let rowTot = 0;
          doc.fontSize(6);
          mesesCols.forEach((mc, i) => {
            const v = (matriz[cat] && matriz[cat][mc.periodo]) || 0;
            rowTot += v;
            if (v > 0) doc.fill('#B83232').text(fmtInt(v), monthsX + i * colW, ly + 4, { width: colW - 2, align: 'right', lineBreak: false });
          });
          doc.fill(colorNegro).font('Helvetica-Bold').text(fmtInt(rowTot), totX, ly + 4, { width: totW - 4, align: 'right', lineBreak: false });
          doc.font('Helvetica');
          ly += 13;
        });

        // Ingresos por mes (para las filas resumen)
        const ingMes = {};
        db.prepare(`SELECT substr(fecha,1,7) as periodo, SUM(ingreso) as ing FROM transacciones WHERE fecha >= ? AND fecha <= ? AND ingreso > 0 GROUP BY periodo`)
          .all(informe.ciclo.fecha_desde, informe.fechaHasta)
          .forEach(r => { ingMes[r.periodo] = r.ing; });

        // Filas resumen: Egresos, Ingresos, Neto (por mes)
        const drawResumen = (label, valorFn, granTotFn, opts) => {
          if (ly > 545) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 40 }); ly = 45; drawHeader(); }
          doc.rect(L, ly, doc.page.width - 2 * L, 15).fill(opts.bg || colorVerde);
          doc.fontSize(6.5).fill(opts.fg || '#ffffff').font('Helvetica-Bold').text(label, L + 4, ly + 4.5, { width: catW - 6, lineBreak: false });
          doc.fontSize(6);
          let gt = 0;
          mesesCols.forEach((mc, i) => {
            const v = valorFn(mc.periodo);
            gt += v;
            const col = opts.signColor ? (v >= 0 ? '#1a7a4a' : '#B83232') : (opts.fg || '#ffffff');
            doc.fill(col).text(fmtInt(v), monthsX + i * colW, ly + 4.5, { width: colW - 2, align: 'right', lineBreak: false });
          });
          const gtVal = granTotFn ? granTotFn() : gt;
          doc.fill(opts.signColor ? (gtVal >= 0 ? '#1a7a4a' : '#B83232') : (opts.fg || '#ffffff'))
             .text(fmtInt(gtVal), totX, ly + 4.5, { width: totW - 4, align: 'right', lineBreak: false });
          ly += 15;
        };

        const egMesFn = p => cats.reduce((s, cat) => s + ((matriz[cat] && matriz[cat][p]) || 0), 0);
        drawResumen('TOTAL EGRESOS', egMesFn, () => informe.totalEgresos, { bg: colorVerde, fg: '#ffffff' });
        drawResumen('INGRESOS', p => ingMes[p] || 0, () => informe.totalIngresos, { bg: '#e8f3e8', fg: '#1a7a4a' });
        drawResumen('NETO', p => (ingMes[p] || 0) - egMesFn(p), () => informe.totalIngresos - informe.totalEgresos, { bg: '#f5f7f5', fg: colorNegro, signColor: true });
      }
    }

    // ── PIE DE PÁGINA ──
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fill(colorGris).font('Helvetica')
         .text(`VIDELA — Informe Ciclo ${informe.ciclo.label} — Página ${i + 1} de ${pages.count}`,
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
    const mag = await getPrecioReferencia(new Date().toISOString().slice(0,10));
  const precio = mag?.precio || 0;

    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="VIDELA_${mesesNombres[mes]}_${anio}.pdf"`);
    doc.pipe(res);

    const colorVerde = '#0B3D7C';
    const colorGris = '#5C6B7E';
    const colorNegro = '#10243F';
    const colorFondo = '#F4F1EA';
    const colorLinea = '#c8d6c8';

    // ── ENCABEZADO ──
    doc.rect(0, 0, doc.page.width, 100).fill(colorVerde);
    doc.fontSize(28).fill('#ffffff').font('Helvetica-Bold')
       .text('VIDELA', 50, 30);
    doc.fontSize(12).fill('#c8e6c8').font('Helvetica')
       .text(`Informe Mensual — ${mesesNombres[mes]} ${anio}`, 50, 62);
    doc.fontSize(9).fill('#a0c8a0')
       .text(`Generado: ${new Date().toLocaleDateString('es-UY')}${tc ? ` | TC BROU: $${tc.toFixed(2)} ARS/kg carne` : ''}`, 50, 80);

    let y = 120;

    // ── RESUMEN ──
    doc.fontSize(15).fill(colorVerde).font('Times-Italic')
       .text('Resumen del Mes', 50, y);
    y += 25;

    const neto = informe.totalIngresos - informe.totalEgresos;
    const kpis = [
      { label: 'Total Egresos', valor: `$${fmt(informe.totalEgresos)} ARS`, color: '#B83232' },
      { label: 'Total Ingresos', valor: `$${fmt(informe.totalIngresos)} ARS`, color: '#1a7a4a' },
      { label: 'Resultado Neto', valor: `$${fmt(neto)} ARS`, color: neto >= 0 ? '#1a7a4a' : '#B83232' },
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
    doc.fontSize(15).fill(colorVerde).font('Times-Italic')
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
      doc.fill(r.total_egreso > 0 ? '#B83232' : colorGris)
         .text(r.total_egreso > 0 ? `$${fmt(r.total_egreso)}` : '-', 240, y + 4, { width: 80, align: 'right' });
      doc.fill(r.total_ingreso > 0 ? '#1a7a4a' : colorGris)
         .text(r.total_ingreso > 0 ? `$${fmt(r.total_ingreso)}` : '-', 325, y + 4, { width: 80, align: 'right' });
      doc.fill(colorGris)
         .text(presupMes ? `$${fmt(presupMes)}` : '-', 410, y + 4, { width: 65, align: 'right' });
      doc.fill(excedido ? '#B83232' : colorNegro).font(excedido ? 'Helvetica-Bold' : 'Helvetica')
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
      doc.fontSize(15).fill(colorVerde).font('Times-Italic')
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
        doc.fill('#B83232').font('Helvetica-Bold')
           .text(`$${fmt(t.egreso)}`, 405, y + 4, { width: 80, align: 'right' });
        y += 16;
      });
    }

    // ── PIE DE PÁGINA ──
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fill(colorGris).font('Helvetica')
         .text(`VIDELA — ${mesesNombres[mes]} ${anio} — Página ${i + 1} de ${pages.count}`,
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
    res.setHeader("Content-Disposition", `attachment; filename="VIDELA_backup_${hoy}.csv"`);
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
    res.setHeader("Content-Disposition", `attachment; filename="VIDELA_backup_completo_${hoy}.csv"`);
    res.send(contenido);
  } catch (err) {
    console.error("Error generando backup completo:", err);
    res.status(500).json({ error: "Error generando backup" });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get("/api/dividendos", (req, res) => {
  // Adaptado a los socios de Cabaña Amakaik (Jonatan Dastolfo + Marcos Gullo)
  // y con kg carne como unidad principal.
  const jonatan = db.prepare(`SELECT COALESCE(SUM(monto_kg),0) as total FROM dividendos WHERE LOWER(socio) LIKE '%jonatan%' OR LOWER(socio) LIKE '%dastolfo%'`).get().total;
  const marcos  = db.prepare(`SELECT COALESCE(SUM(monto_kg),0) as total FROM dividendos WHERE LOWER(socio) LIKE '%marcos%' OR LOWER(socio) LIKE '%gullo%'`).get().total;
  const historial = db.prepare(`SELECT * FROM dividendos ORDER BY fecha DESC`).all();
  const porMes = {};
  historial.forEach(d => {
    const mes = d.fecha.slice(0,7);
    if (!porMes[mes]) porMes[mes] = { jonatan: 0, marcos: 0 };
    const socioLow = (d.socio || '').toLowerCase();
    const monto = d.monto_kg || 0;
    if (socioLow.includes('jonatan') || socioLow.includes('dastolfo')) porMes[mes].jonatan += monto;
    else if (socioLow.includes('marcos') || socioLow.includes('gullo')) porMes[mes].marcos += monto;
  });
  res.json({ jonatan, marcos, total: jonatan + marcos, historial, por_mes: porMes });
});

// ── API TIPO DE CAMBIO (compat) ───────────────────────────────────────────────
// El HTML de IMPROLUX llamaba a /api/tc para mostrar el TC del día.
// En VIDELA no hay TC (Argentina es una sola moneda), pero mantengo el endpoint
// para no romper llamadas legacy. Devuelve el precio MAG actual (ARS/kg carne).
app.get("/api/tc", async (req, res) => {
  try {
    const mag = await getPrecioReferencia(new Date().toISOString().slice(0, 10));
    if (mag?.precio) {
      res.json({ tc: mag.precio, semana: mag.semana, unidad: 'ARS/kg carne (MAG)' });
    } else {
      res.json({ tc: null, error: 'Sin precio MAG disponible' });
    }
  } catch (e) {
    res.json({ tc: null, error: e.message });
  }
});

// ── API LOTES Y LABOREOS ──────────────────────────────────────────────────────
app.post("/api/lotes/:id/poligono", (req, res) => {
  const { poligono, hectareas } = req.body;
  const lote = db.prepare("SELECT * FROM lotes WHERE id = ?").get(req.params.id);
  if (!lote) return res.status(404).json({ error: "Lote no encontrado" });
  if (hectareas != null && !isNaN(parseFloat(hectareas))) {
    db.prepare("UPDATE lotes SET poligono = ?, hectareas = ? WHERE id = ?").run(poligono || null, parseFloat(hectareas), req.params.id);
  } else {
    db.prepare("UPDATE lotes SET poligono = ? WHERE id = ?").run(poligono || null, req.params.id);
  }
  res.json({ ok: true });
});

app.get("/api/lotes", (req, res) => {
  const campo = req.query.campo;
  const lotes = campo
    ? db.prepare("SELECT * FROM lotes WHERE campo = ? ORDER BY nombre").all(campo)
    : db.prepare("SELECT * FROM lotes ORDER BY nombre").all();
  res.json(lotes);
});

app.post("/api/lotes", (req, res) => {
  const { nombre, hectareas, ha_sembrables, notas, campo } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
  try {
    const r = db.prepare("INSERT INTO lotes (nombre,hectareas,ha_sembrables,notas,campo) VALUES (?,?,?,?,?)").run(nombre.toUpperCase(), hectareas||0, ha_sembrables||0, notas||'', (campo||'AMAKAIK').toUpperCase());
    res.json({ id: r.lastInsertRowid, nombre: nombre.toUpperCase() });
  } catch(e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Ya existe un lote con ese nombre' });
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/lotes/:id", (req, res) => {
  const { nombre, hectareas, ha_sembrables, notas } = req.body;
  const l = db.prepare("SELECT * FROM lotes WHERE id=?").get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Lote no encontrado' });
  db.prepare("UPDATE lotes SET nombre=?, hectareas=?, ha_sembrables=?, notas=? WHERE id=?")
    .run((nombre||l.nombre).toUpperCase(), hectareas!==undefined?(parseFloat(hectareas)||0):l.hectareas,
      ha_sembrables!==undefined?(parseFloat(ha_sembrables)||0):l.ha_sembrables, notas!==undefined?notas:l.notas, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/lotes/:id", (req, res) => {
  db.prepare("DELETE FROM lotes WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// Historial de un lote: todas las órdenes que lo tocan (incluye multi-lote "A + B + C")
app.get("/api/lotes/:nombre/historial", (req, res) => {
  const nombre = req.params.nombre.toUpperCase();
  const todas = db.prepare("SELECT * FROM ordenes_trabajo ORDER BY anio DESC, numero DESC").all();
  const delLote = todas.filter(o => (o.lote||'').toUpperCase().split(' + ').map(s=>s.trim()).includes(nombre))
    .map(o => ({ ...o, numero_display: `${o.numero}/${o.anio}` }));
  res.json(delLote);
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

// ══════════════════════════════════════════════════════════════════════════════
// ── API STOCK DE PRODUCTOS (v4.3) ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/stock", (req, res) => {
  res.json(getStockValorizado(req.query.campo));
});

app.post("/api/stock", (req, res) => {
  const { nombre, rubro, categoria, unidad, cantidad, precio_unitario, notas, campo } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
  try {
    const r = db.prepare("INSERT INTO stock_productos (nombre,rubro,categoria,unidad,cantidad,precio_unitario,notas,campo) VALUES (?,?,?,?,?,?,?,?)")
      .run(nombre.toUpperCase(), (rubro||'AGRICOLA').toUpperCase(), (categoria||'OTRO').toUpperCase(), unidad||'kg', parseFloat(cantidad)||0, parseFloat(precio_unitario)||0, notas||'', (campo||'AMAKAIK').toUpperCase());
    // Registrar la carga inicial como movimiento ENTRADA (si hay cantidad)
    if ((parseFloat(cantidad)||0) > 0) {
      const hoy = new Date().toISOString().slice(0,10);
      db.prepare("INSERT INTO stock_movimientos (producto_id,fecha,tipo,cantidad,precio_unitario,notas) VALUES (?,?,'ENTRADA',?,?,?)")
        .run(r.lastInsertRowid, hoy, parseFloat(cantidad)||0, parseFloat(precio_unitario)||0, 'Carga inicial');
    }
    res.json({ id: r.lastInsertRowid, nombre: nombre.toUpperCase() });
  } catch(e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Ya existe un producto con ese nombre' });
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/stock/:id", (req, res) => {
  const { nombre, rubro, categoria, unidad, notas } = req.body;
  const p = db.prepare("SELECT * FROM stock_productos WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  db.prepare("UPDATE stock_productos SET nombre=?,rubro=?,categoria=?,unidad=?,notas=? WHERE id=?")
    .run((nombre||p.nombre).toUpperCase(), (rubro||p.rubro||'AGRICOLA').toUpperCase(), (categoria||p.categoria).toUpperCase(), unidad||p.unidad, notas!==undefined?notas:p.notas, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/stock/:id", (req, res) => {
  db.prepare("DELETE FROM stock_movimientos WHERE producto_id=?").run(req.params.id);
  db.prepare("UPDATE orden_items SET producto_id=NULL WHERE producto_id=?").run(req.params.id);
  db.prepare("DELETE FROM stock_productos WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ENTRADA de stock (compra / reposición) — recalcula costo promedio ponderado
// COMPRA de insumo: genera egreso en el flujo + entrada al stock (un solo paso)
app.post("/api/stock/compra", (req, res) => {
  const r = comprarInsumo(req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// LISTA de productos de stock (para que ADE elija al aplicar sanidad)
app.get("/api/stock/lista", (req, res) => {
  const campo = req.query.campo;
  const rubro = req.query.rubro;
  let q = "SELECT id, nombre, rubro, categoria, unidad, cantidad, campo FROM stock_productos WHERE 1=1";
  const p = [];
  if (campo) { q += " AND campo = ?"; p.push(campo); }
  if (rubro) { q += " AND rubro = ?"; p.push(rubro.toUpperCase()); }
  q += " ORDER BY rubro, nombre";
  res.json(db.prepare(q).all(...p));
});

// APLICACIÓN: descuenta stock por uso (llamado desde ADE al registrar sanidad).
// Match de nombre: exacto → descuenta; 1 parecido → descuenta y avisa; varios → pregunta; 0 → no encontrado.
// Permite dejar el stock en negativo, pero lo avisa.
app.post("/api/stock/aplicar", (req, res) => {
  const { producto_id, producto, cantidad, fecha, rp, detalle, campo } = req.body;
  const cant = parseFloat(cantidad) || 0;
  if (cant <= 0) return res.status(400).json({ error: "La cantidad aplicada debe ser mayor a 0" });

  const filtroCampo = (rows) => campo ? rows.filter(r => (r.campo || '').toUpperCase() === campo.toUpperCase()) : rows;

  // Ubicar el producto
  let prod = null;
  if (producto_id) prod = db.prepare("SELECT * FROM stock_productos WHERE id = ?").get(producto_id);

  if (!prod && producto) {
    const q = String(producto).trim().toLowerCase();
    // 1) Match exacto
    prod = filtroCampo(db.prepare("SELECT * FROM stock_productos WHERE LOWER(nombre) = ?").all(q))[0] || null;
    // 2) Parecidos: contiene la búsqueda, o la búsqueda contiene el nombre
    if (!prod) {
      const todos = filtroCampo(db.prepare("SELECT * FROM stock_productos").all());
      const parecidos = todos.filter(r => {
        const n = (r.nombre || '').toLowerCase();
        return n.includes(q) || q.includes(n) || n.split(/\s+/)[0] === q.split(/\s+/)[0];
      });
      if (parecidos.length === 1) {
        prod = parecidos[0];
        // se resuelve abajo con aviso de interpretación
        var interpretado = true;
      } else if (parecidos.length > 1) {
        return res.json({
          ok: false, ambiguo: true, buscado: producto,
          opciones: parecidos.map(p => ({ id: p.id, nombre: p.nombre, cantidad: p.cantidad, unidad: p.unidad })),
          mensaje: `Hay varios productos parecidos a "${producto}". ¿Cuál aplicaste?`
        });
      }
    }
  }

  if (!prod) return res.status(404).json({ error: `No encontré "${producto}" ni nada parecido en el stock`, no_encontrado: true, buscado: producto });

  const nuevaCantidad = (prod.cantidad || 0) - cant;
  db.prepare("UPDATE stock_productos SET cantidad = ? WHERE id = ?").run(nuevaCantidad, prod.id);
  const notas = `Aplicación${rp ? ' RP ' + rp : ''}${detalle ? ' · ' + detalle : ''}`;
  db.prepare("INSERT INTO stock_movimientos (producto_id,fecha,tipo,cantidad,precio_unitario,notas) VALUES (?,?,'SALIDA',?,?,?)")
    .run(prod.id, fecha || new Date().toISOString().slice(0, 10), cant, prod.precio_unitario || 0, notas);

  const negativo = nuevaCantidad < 0;
  const interpretadoDe = (typeof interpretado !== 'undefined' && producto && prod.nombre.toLowerCase() !== String(producto).trim().toLowerCase()) ? producto : null;
  const costoUnit = prod.precio_unitario || 0;
  res.json({
    ok: true, producto: prod.nombre, unidad: prod.unidad,
    aplicado: cant, restante: Math.round(nuevaCantidad * 100) / 100,
    // Costo del consumo: ADE lo imputa al animal o al lote sin volver a preguntar.
    costo_unitario: costoUnit,
    costo_total: Math.round(cant * costoUnit * 100) / 100,
    rubro: prod.rubro || 'AGRICOLA', categoria: prod.categoria || null,
    negativo, interpretado_de: interpretadoDe,
    aviso: [
      interpretadoDe ? `📝 Interpreté "${interpretadoDe}" → ${prod.nombre}.` : null,
      negativo ? `⚠️ Stock de ${prod.nombre} quedó en negativo (${Math.round(nuevaCantidad*100)/100} ${prod.unidad}). Registrá una compra para reponer.` : null
    ].filter(Boolean).join(' ') || null
  });
});

// CONSUMO: ADE avisa la ración diaria de un lote. Mismo efecto que aplicar,
// pero pensado para lotes (sin RP) y devolviendo siempre el costo.
app.post("/api/stock/consumo", (req, res) => {
  const { producto, producto_id, cantidad, fecha, lote, detalle, campo } = req.body;
  const cant = parseFloat(cantidad) || 0;
  if (cant <= 0) return res.status(400).json({ error: "La cantidad consumida debe ser mayor a 0" });

  let prod = producto_id ? db.prepare("SELECT * FROM stock_productos WHERE id = ?").get(producto_id) : null;
  if (!prod && producto) {
    const q = String(producto).trim().toLowerCase();
    let rows = db.prepare("SELECT * FROM stock_productos WHERE LOWER(nombre) = ?").all(q);
    if (campo) rows = rows.filter(r => (r.campo || '').toUpperCase() === campo.toUpperCase());
    prod = rows[0] || null;
  }
  if (!prod) return res.status(404).json({ error: `No encontré "${producto}" en el stock`, no_encontrado: true });

  const nueva = (prod.cantidad || 0) - cant;
  const costoUnit = prod.precio_unitario || 0;
  db.prepare("UPDATE stock_productos SET cantidad = ? WHERE id = ?").run(nueva, prod.id);
  db.prepare("INSERT INTO stock_movimientos (producto_id,fecha,tipo,cantidad,precio_unitario,notas) VALUES (?,?,'SALIDA',?,?,?)")
    .run(prod.id, fecha || new Date().toISOString().slice(0, 10), cant, costoUnit,
         `Consumo${lote ? ' lote ' + lote : ''}${detalle ? ' · ' + detalle : ''}`);

  res.json({
    ok: true, producto: prod.nombre, unidad: prod.unidad,
    consumido: cant, restante: Math.round(nueva * 100) / 100,
    costo_unitario: costoUnit, costo_total: Math.round(cant * costoUnit * 100) / 100,
    negativo: nueva < 0,
    aviso: nueva < 0 ? `⚠️ ${prod.nombre} quedó en negativo (${Math.round(nueva*100)/100} ${prod.unidad}). Cargá una compra.` : null
  });
});

app.post("/api/stock/:id/entrada", (req, res) => {
  const { cantidad, precio_unitario, fecha, notas } = req.body;
  if (!cantidad) return res.status(400).json({ error: 'Falta cantidad' });
  const hoy = new Date().toISOString().slice(0,10);
  const r = entradaStock(req.params.id, cantidad, precio_unitario, fecha||hoy, notas);
  if (!r) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ ok: true, ...r });
});

// AJUSTE de stock — fija la cantidad a un valor absoluto (recuento físico)
app.post("/api/stock/:id/ajuste", (req, res) => {
  const { cantidad_nueva, notas } = req.body;
  const p = db.prepare("SELECT * FROM stock_productos WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const nueva = parseFloat(cantidad_nueva) || 0;
  const diff = nueva - (p.cantidad || 0);
  const hoy = new Date().toISOString().slice(0,10);
  db.prepare("UPDATE stock_productos SET cantidad=? WHERE id=?").run(nueva, req.params.id);
  db.prepare("INSERT INTO stock_movimientos (producto_id,fecha,tipo,cantidad,precio_unitario,notas) VALUES (?,?,'AJUSTE',?,?,?)")
    .run(req.params.id, hoy, diff, p.precio_unitario||0, notas||'Ajuste por recuento');
  res.json({ ok: true, cantidad: nueva });
});

app.get("/api/stock/:id/movimientos", (req, res) => {
  const movs = db.prepare("SELECT * FROM stock_movimientos WHERE producto_id=? ORDER BY id DESC").all(req.params.id);
  res.json(movs);
});

// ══════════════════════════════════════════════════════════════════════════════
// ── API ÓRDENES DE TRABAJO (v4.3) ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/ordenes", (req, res) => {
  const { anio, lote, estado, campo } = req.query;
  let q = "SELECT o.*, lt.hectareas as lote_hectareas, lt.ha_sembrables as lote_ha_sembrables FROM ordenes_trabajo o LEFT JOIN lotes lt ON lt.nombre = o.lote WHERE 1=1";
  const p = [];
  if (campo) { q += " AND o.campo = ?"; p.push(campo); }
  if (anio) { q += " AND o.anio = ?"; p.push(parseInt(anio)); }
  if (lote) { q += " AND LOWER(o.lote) LIKE ?"; p.push('%'+lote.toLowerCase()+'%'); }
  if (estado) { q += " AND o.estado = ?"; p.push(estado); }
  q += " ORDER BY o.anio DESC, o.numero DESC";
  const ordenes = db.prepare(q).all(...p);
  const withItems = ordenes.map(o => ({
    ...o,
    numero_display: `${o.numero}/${o.anio}`,
    items: db.prepare(`
      SELECT oi.*, sp.nombre as producto_nombre, sp.cantidad as stock_actual
      FROM orden_items oi LEFT JOIN stock_productos sp ON sp.id = oi.producto_id
      WHERE oi.orden_id = ? ORDER BY oi.tipo, oi.id
    `).all(o.id)
  }));
  res.json(withItems);
});

app.get("/api/ordenes/:id", (req, res) => {
  const det = getOrdenDetalle(req.params.id);
  if (!det) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json(det);
});

app.post("/api/ordenes", (req, res) => {
  const { lote, lotes, titulo, anio, ciclo, numero, notas, hectareas } = req.body;
  const anioFinal = parseInt(anio) || new Date().getFullYear();
  const numFinal = numero ? parseInt(numero) : getNextNumeroOrden(anioFinal);
  let loteStr = '';
  let ha = parseFloat(hectareas);
  if (Array.isArray(lotes) && lotes.length) {
    // Varios lotes: uno el nombre con " + " y sumo las ha aprovechables de cada uno
    const names = lotes.map(n => String(n).toUpperCase().trim()).filter(Boolean);
    loteStr = names.join(' + ');
    if (isNaN(ha) || ha === 0) {
      ha = names.reduce((s, n) => {
        const lt = db.prepare("SELECT ha_sembrables FROM lotes WHERE nombre = ?").get(n);
        return s + (parseFloat(lt?.ha_sembrables) || 0);
      }, 0);
    }
  } else {
    loteStr = lote ? lote.toUpperCase() : '';
    if ((isNaN(ha) || ha === 0) && loteStr) {
      const lt = db.prepare("SELECT ha_sembrables FROM lotes WHERE nombre = ?").get(loteStr);
      ha = parseFloat(lt?.ha_sembrables) || 0;
    }
  }
  ha = ha || 0;
  const r = db.prepare("INSERT INTO ordenes_trabajo (numero,anio,lote,titulo,ciclo,hectareas,estado,notas,campo,tipo_implantacion) VALUES (?,?,?,?,?,?,'PLANIFICADA',?,?,?)")
    .run(numFinal, anioFinal, loteStr, titulo||'', ciclo||'', ha, notas||'', (req.body.campo||'AMAKAIK').toUpperCase(),
         (req.body.tipo_implantacion||'').toUpperCase()||null);
  res.json({ id: r.lastInsertRowid, numero: numFinal, anio: anioFinal, hectareas: ha, numero_display: `${numFinal}/${anioFinal}` });
});

app.put("/api/ordenes/:id", (req, res) => {
  const { lote, titulo, ciclo, estado, notas, hectareas, anio, numero, tipo_implantacion } = req.body;
  // Vacío = no implanta nada. Se guarda como NULL para que ADE lo saltee.
  if (tipo_implantacion !== undefined) {
    db.prepare("UPDATE ordenes_trabajo SET tipo_implantacion = ? WHERE id = ?")
      .run((tipo_implantacion || '').toUpperCase() || null, req.params.id);
  }
  const o = db.prepare("SELECT * FROM ordenes_trabajo WHERE id=?").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  const fields = {};
  if (lote !== undefined) fields.lote = lote ? lote.toUpperCase() : '';
  if (titulo !== undefined) fields.titulo = titulo;
  if (ciclo !== undefined) fields.ciclo = ciclo;
  if (estado !== undefined) fields.estado = estado;
  if (notas !== undefined) fields.notas = notas;
  if (hectareas !== undefined) fields.hectareas = parseFloat(hectareas) || 0;
  if (anio !== undefined) fields.anio = parseInt(anio) || o.anio;
  if (numero !== undefined) fields.numero = parseInt(numero) || o.numero;
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nada que actualizar' });
  const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE ordenes_trabajo SET ${sets} WHERE id=?`).run(...Object.values(fields), req.params.id);
  // Si cambiaron las ha, recalculo los items cargados por dosis
  if (hectareas !== undefined) { recomputarDosisOrden(req.params.id); recalcularOrden(req.params.id); }
  res.json({ ok: true });
});

app.delete("/api/ordenes/:id", (req, res) => {
  db.prepare("DELETE FROM orden_items WHERE orden_id=?").run(req.params.id);
  db.prepare("DELETE FROM orden_cambios WHERE orden_id=?").run(req.params.id);
  db.prepare("DELETE FROM ordenes_trabajo WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// Registrar un cambio manual en la bitácora de la orden
app.post("/api/ordenes/:id/cambios", (req, res) => {
  const { texto } = req.body;
  if (!texto) return res.status(400).json({ error: 'Falta texto' });
  logCambioOrden(req.params.id, texto);
  res.json({ ok: true });
});

// ── ITEMS DE LA ORDEN ──
app.post("/api/ordenes/:id/items", (req, res) => {
  const { tipo, etapa, producto_id, descripcion, cantidad, unidad, precio_unitario, dosis } = req.body;
  const o = db.prepare("SELECT * FROM ordenes_trabajo WHERE id=?").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  const tipoFinal = (tipo || 'INSUMO').toUpperCase();

  // Si es INSUMO con producto vinculado, tomo unidad y precio del stock por defecto
  let desc = descripcion, uni = unidad, precio = parseFloat(precio_unitario) || 0, prodId = producto_id || null;
  if (tipoFinal === 'INSUMO' && prodId) {
    const prod = db.prepare("SELECT * FROM stock_productos WHERE id=?").get(prodId);
    if (prod) {
      if (!desc) desc = prod.nombre;
      if (!uni) uni = prod.unidad;
      if (!precio) precio = prod.precio_unitario || 0;
    }
  }
  if (!desc) return res.status(400).json({ error: 'Falta descripcion o producto' });
  // Cantidad: si viene dosis>0 y la orden tiene ha, cantidad = dosis × ha; si no, la cantidad directa
  const dos = parseFloat(dosis) || 0;
  const ha = parseFloat(o.hectareas) || 0;
  let cant = parseFloat(cantidad) || 0;
  if (dos > 0 && ha > 0) cant = dos * ha;
  const total = cant * precio;
  const etapaFinal = (etapa || 'GENERAL').toUpperCase().trim() || 'GENERAL';
  const r = db.prepare("INSERT INTO orden_items (orden_id,tipo,etapa,producto_id,descripcion,dosis,cantidad,unidad,precio_unitario,total) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(req.params.id, tipoFinal, etapaFinal, tipoFinal==='INSUMO'?prodId:null, desc, dos, cant, uni||'kg', precio, total);
  const result = recalcularOrden(req.params.id);
  res.json({ id: r.lastInsertRowid, total, cantidad: cant, ...result });
});

// Editar item — registra el cambio en la bitácora
app.put("/api/ordenes/:id/items/:itemId", (req, res) => {
  const item = db.prepare("SELECT * FROM orden_items WHERE id=? AND orden_id=?").get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item no encontrado' });
  const { tipo, etapa, producto_id, descripcion, cantidad, unidad, precio_unitario, dosis } = req.body;

  const nuevaDesc = descripcion !== undefined ? descripcion : item.descripcion;
  const nuevoPrecio = precio_unitario !== undefined ? (parseFloat(precio_unitario)||0) : item.precio_unitario;
  const nuevaUni = unidad !== undefined ? unidad : item.unidad;
  const nuevoTipo = tipo !== undefined ? tipo.toUpperCase() : item.tipo;
  const nuevoProd = producto_id !== undefined ? (producto_id||null) : item.producto_id;
  const nuevaEtapa = etapa !== undefined ? ((etapa||'GENERAL').toUpperCase().trim() || 'GENERAL') : (item.etapa || 'GENERAL');
  const nuevaDosis = dosis !== undefined ? (parseFloat(dosis)||0) : (item.dosis||0);

  // Cantidad: si hay dosis>0 y la orden tiene ha, recalculo; si no, uso la cantidad provista/actual
  const ord = db.prepare("SELECT hectareas FROM ordenes_trabajo WHERE id=?").get(req.params.id);
  const ha = parseFloat(ord?.hectareas) || 0;
  let nuevaCant = cantidad !== undefined ? (parseFloat(cantidad)||0) : item.cantidad;
  if (nuevaDosis > 0 && ha > 0) nuevaCant = nuevaDosis * ha;
  const total = nuevaCant * nuevoPrecio;

  // Bitácora: registrar el cambio de descripción/producto si cambió
  if (descripcion !== undefined && descripcion !== item.descripcion) {
    logCambioOrden(req.params.id, `Se cambió "${item.descripcion}" por "${descripcion}"`);
  }

  db.prepare("UPDATE orden_items SET tipo=?,etapa=?,producto_id=?,descripcion=?,dosis=?,cantidad=?,unidad=?,precio_unitario=?,total=? WHERE id=?")
    .run(nuevoTipo, nuevaEtapa, nuevoTipo==='INSUMO'?nuevoProd:null, nuevaDesc, nuevaDosis, nuevaCant, nuevaUni, nuevoPrecio, total, req.params.itemId);
  const result = recalcularOrden(req.params.id);
  res.json({ ok: true, total, ...result });
});

app.delete("/api/ordenes/:id/items/:itemId", (req, res) => {
  const item = db.prepare("SELECT * FROM orden_items WHERE id=? AND orden_id=?").get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item no encontrado' });
  // Si estaba ejecutado y descontó stock, revertir la salida
  if (item.ejecutado && item.producto_id && item.cantidad_ejecutada > 0) {
    const hoy = new Date().toISOString().slice(0,10);
    entradaStock(item.producto_id, item.cantidad_ejecutada, 0, hoy, `Reversión por borrado item orden #${req.params.id}`);
  }
  db.prepare("DELETE FROM orden_items WHERE id=? AND orden_id=?").run(req.params.itemId, req.params.id);
  const result = recalcularOrden(req.params.id);
  res.json({ ok: true, ...result });
});

// EJECUTAR item — descuenta stock (si es INSUMO con producto) y marca ejecutado
app.post("/api/ordenes/:id/items/:itemId/ejecutar", (req, res) => {
  const item = db.prepare("SELECT * FROM orden_items WHERE id=? AND orden_id=?").get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item no encontrado' });
  if (item.ejecutado) return res.status(400).json({ error: 'El item ya está ejecutado' });
  const hoy = new Date().toISOString().slice(0,10);
  const { cantidad_ejecutada, fecha, notas } = req.body;
  // Cantidad real usada — por defecto la planificada
  const cantEjec = cantidad_ejecutada !== undefined && cantidad_ejecutada !== null && cantidad_ejecutada !== ''
    ? (parseFloat(cantidad_ejecutada)||0) : item.cantidad;
  const totalEjec = cantEjec * item.precio_unitario;

  db.prepare("UPDATE orden_items SET ejecutado=1, cantidad_ejecutada=?, total_ejecutado=?, fecha_ejecucion=?, notas=? WHERE id=?")
    .run(cantEjec, totalEjec, fecha||hoy, notas!==undefined?notas:item.notas, req.params.itemId);

  // Descontar del stock si es INSUMO vinculado a un producto
  let stockInfo = null;
  if (item.tipo === 'INSUMO' && item.producto_id && cantEjec > 0) {
    stockInfo = salidaStock(item.producto_id, cantEjec, fecha||hoy, `Consumo orden #${req.params.id} — ${item.descripcion}`, req.params.id);
  }
  // Bitácora si la cantidad ejecutada difiere de la planificada
  if (cantEjec !== item.cantidad) {
    logCambioOrden(req.params.id, `Ejecutado "${item.descripcion}": ${cantEjec} ${item.unidad} (planificado ${item.cantidad})`);
  }
  const result = recalcularOrden(req.params.id);
  res.json({ ok: true, stock: stockInfo, ...result });
});

// DESEJECUTAR item — repone el stock descontado
app.post("/api/ordenes/:id/items/:itemId/desejecutar", (req, res) => {
  const item = db.prepare("SELECT * FROM orden_items WHERE id=? AND orden_id=?").get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item no encontrado' });
  if (!item.ejecutado) return res.status(400).json({ error: 'El item no está ejecutado' });
  const hoy = new Date().toISOString().slice(0,10);
  // Reponer stock si había descontado
  if (item.tipo === 'INSUMO' && item.producto_id && item.cantidad_ejecutada > 0) {
    entradaStock(item.producto_id, item.cantidad_ejecutada, 0, hoy, `Reversión ejecución orden #${req.params.id} — ${item.descripcion}`, req.params.id);
  }
  db.prepare("UPDATE orden_items SET ejecutado=0, cantidad_ejecutada=0, total_ejecutado=0, fecha_ejecucion=NULL WHERE id=?").run(req.params.itemId);
  const result = recalcularOrden(req.params.id);
  res.json({ ok: true, ...result });
});

// ═══ ENDPOINTS MAG (portados de VIDELA v1) ═══════════════════════════════
app.get("/api/mag", async (req, res) => {
  const ult = db.prepare("SELECT * FROM precios_mag ORDER BY semana DESC LIMIT 12").all();
  const actual = await getPrecioReferencia(new Date().toISOString().slice(0, 10));
  res.json({ actual, historial: ult });
});

app.post("/api/mag/refrescar", async (req, res) => {
  // Forzar scraping de la semana anterior
  const hoy = new Date();
  const semAnt = getSemanaAnterior(hoy);
  db.prepare("DELETE FROM precios_mag WHERE semana = ?").run(semAnt.semana);
  const r = await getPrecioReferencia(hoy.toISOString().slice(0, 10));
  res.json({ ok: !!r, ...r });
});

// ── DIAGNÓSTICO MAG (GET para abrir desde el navegador) ───────────────────────
app.get("/api/mag/diagnostico", async (req, res) => {
  // Permite probar el scraping abriéndolo en el navegador
  const fechaDesde = req.query.desde || (() => {
    const d = new Date();
    const sem = getSemanaAnterior(d);
    return sem.desde;
  })();
  const fechaHasta = req.query.hasta || (() => {
    const d = new Date();
    const sem = getSemanaAnterior(d);
    return sem.hasta;
  })();

  console.log(`🔬 Diagnóstico MAG: ${fechaDesde} → ${fechaHasta}`);

  try {
    const datos = await scrapearPrecioMAG(fechaDesde, fechaHasta);
    res.json({
      fechaDesde,
      fechaHasta,
      resultado: datos,
      mensaje: datos ? "OK — datos obtenidos" : "FALLÓ — revisar logs de Railway"
    });
  } catch (e) {
    res.json({ error: e.message, stack: e.stack });
  }
});

// Forzar scraping diario (para testing) - prueba las 3 fuentes y guarda el resultado
app.get("/api/mag/diario", async (req, res) => {
  console.log(`🔬 Forzando scraping diario...`);
  try {
    const r = await scrapearINMAGDelDia();
    if (r && r.indice > 0) {
      db.prepare(`
        INSERT OR REPLACE INTO precios_mag_diario
        (fecha, indice_novillo, cabezas, importe_total, kg_total, fuente)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(r.fecha, r.indice, r.cabezas || 0, r.importeTotal || 0, r.kgTotal || 0, r.fuente);
      res.json({ ok: true, datos: r, mensaje: `Guardado: ${r.fecha} = $${r.indice.toFixed(3)} desde ${r.fuente}` });
    } else {
      res.json({ ok: false, mensaje: "Ninguna fuente devolvió datos válidos" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ver todos los precios diarios guardados
app.get("/api/mag/diarios", (req, res) => {
  const desde = req.query.desde || "2026-01-01";
  const hasta = req.query.hasta || "2099-12-31";
  const filas = db.prepare(
    "SELECT * FROM precios_mag_diario WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC"
  ).all(desde, hasta);
  res.json({ total: filas.length, datos: filas });
});

// Limpiar diarios corruptos (rangos parseables como inválidos)
// GET /api/mag/limpiar-diarios?desde=2026-05-12&hasta=2026-05-15
app.get("/api/mag/limpiar-diarios", (req, res) => {
  const desde = req.query.desde;
  const hasta = req.query.hasta;
  if (!desde || !hasta) {
    return res.status(400).json({ error: "Pasar ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD" });
  }

  // Mostrar primero qué se va a borrar
  const aBorrar = db.prepare(
    "SELECT * FROM precios_mag_diario WHERE fecha BETWEEN ? AND ?"
  ).all(desde, hasta);

  if (!req.query.confirmar) {
    return res.json({
      vistaPrevia: true,
      mensaje: `Encontrados ${aBorrar.length} registros. Para borrar, agregar &confirmar=si a la URL.`,
      registros: aBorrar
    });
  }

  if (req.query.confirmar !== "si") {
    return res.status(400).json({ error: "Para confirmar debe ser exactamente 'si'" });
  }

  const result = db.prepare(
    "DELETE FROM precios_mag_diario WHERE fecha BETWEEN ? AND ?"
  ).run(desde, hasta);

  res.json({ ok: true, eliminados: result.changes, registros: aBorrar });
});

// Recalcular promedio semanal desde diarios (después de scrapear los días bien)
// GET /api/mag/recalcular-semana?semana=2026-W21
app.get("/api/mag/recalcular-semana", (req, res) => {
  const semanaQ = req.query.semana;
  if (!semanaQ || !semanaQ.match(/^\d{4}-W\d{1,2}$/)) {
    return res.status(400).json({ error: "Pasar ?semana=2026-W21" });
  }

  // Calcular el rango de fechas de esa semana ISO
  const [anio, semNum] = semanaQ.split("-W").map(Number);
  // Lunes de esa semana ISO
  const enero4 = new Date(Date.UTC(anio, 0, 4));
  const enero4DOW = enero4.getUTCDay() || 7;
  const lunesSemana1 = new Date(enero4);
  lunesSemana1.setUTCDate(enero4.getUTCDate() - enero4DOW + 1);
  const lunesObjetivo = new Date(lunesSemana1);
  lunesObjetivo.setUTCDate(lunesSemana1.getUTCDate() + (semNum - 1) * 7);
  const viernesObjetivo = new Date(lunesObjetivo);
  viernesObjetivo.setUTCDate(lunesObjetivo.getUTCDate() + 4);

  const desde = lunesObjetivo.toISOString().slice(0, 10);
  const hasta = viernesObjetivo.toISOString().slice(0, 10);

  const sem = { desde, hasta, semana: semanaQ };
  const r = calcularPromedioSemanalDesdeDiarios(sem);
  if (!r) {
    return res.json({ ok: false, mensaje: `No hay datos diarios en ${desde} → ${hasta}` });
  }

  db.prepare(`
    INSERT OR REPLACE INTO precios_mag (semana, fecha_desde, fecha_hasta, precio_promedio, cabezas, fuente)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(semanaQ, desde, hasta, r.promedio, r.cabezas, r.fuente);

  res.json({ ok: true, mensaje: `Recalculado ${semanaQ} = $${r.promedio.toFixed(3)}`, datos: r });
});

// Borrar una semana específica del histórico (con vista previa + confirmación)
// GET /api/mag/borrar-semana?semana=2026-W22&confirmar=si
app.get("/api/mag/borrar-semana", (req, res) => {
  const semanaQ = req.query.semana;
  if (!semanaQ || !semanaQ.match(/^\d{4}-W\d{1,2}$/)) {
    return res.status(400).json({ error: "Pasar ?semana=2026-W22" });
  }

  const registro = db.prepare("SELECT * FROM precios_mag WHERE semana = ?").get(semanaQ);
  if (!registro) {
    return res.json({ ok: false, mensaje: `No existe el registro de la semana ${semanaQ}` });
  }

  if (!req.query.confirmar) {
    return res.json({
      vistaPrevia: true,
      mensaje: `Se va a borrar este registro. Para confirmar, agregar &confirmar=si a la URL.`,
      registro
    });
  }

  if (req.query.confirmar !== "si") {
    return res.status(400).json({ error: "Para confirmar debe ser exactamente 'si'" });
  }

  const result = db.prepare("DELETE FROM precios_mag WHERE semana = ?").run(semanaQ);
  res.json({ ok: true, eliminados: result.changes, registroBorrado: registro });
});



// Healthcheck para Railway/monitoreo (el root sirve index.html)
app.get("/status", (req, res) => res.json({ status: "VIDELA Bot activo 🟢", version: "3.0-videla-cabana-amakaik", base: "kg carne (INMAG)" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🐂 VIDELA (Cabaña Amakaik) corriendo en puerto ${PORT}`);
  scheduleScrapingMAG();
  scheduleInformeMensual();
  // Pre-cargar precio MAG actual al arrancar
  getPrecioReferencia(new Date().toISOString().slice(0, 10))
    .then(r => r && console.log(`💰 Precio MAG cargado: ${r.semana} = $${r.precio.toFixed(2)} ARS/kg`))
    .catch(e => console.error("Error pre-carga MAG:", e.message));
});

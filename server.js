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

// Servir archivos estáticos (index.html, landing.html) desde la raíz del proyecto
app.use(express.static(__dirname));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────────
// NUMERO_ADMIN acepta uno o varios números separados por coma:
//   whatsapp:+5491100000000
//   whatsapp:+5491111111111,whatsapp:+5491122222222
const NUMEROS_ADMIN = (process.env.NUMERO_ADMIN || "")
  .split(",")
  .map(n => n.trim())
  .filter(n => n.length > 0);

// Categorías adaptadas a Argentina (sin BPS, terminología local)
const CATEGORIAS = [
  "ALQUILER","ALQUILER ESTRUCTURA","ALIMENTACION RECRIA","ALIMENTACION CRIA",
  "TERMINACION","INSUMOS VETERINARIOS","TRABAJOS VETERINARIOS",
  "COMBUSTIBLE CAMPO","COMBUSTIBLE VIATICOS","SUELDO PEON","SUELDO ENCARGADO",
  "VERDEOS Y PASTURAS","ESTRUCTURA GANADERA","MANTENIMIENTO CAMPO",
  "MANTENIMIENTO MAQUINARIA","GASTOS VENTAS GANADERAS","INVERSION MAQUINARIA",
  "COMPRA GANADO","COMPRA HERRAMIENTAS","IMPUESTOS","GASTOS ADM","PROVISTA",
  "VEHICULOS","TELEFONO","INTERESES","GASTO BANCARIO","FLETES","OTROS"
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
    ingreso_ars REAL DEFAULT 0,
    egreso_ars REAL DEFAULT 0,
    ingreso_kg REAL DEFAULT 0,
    egreso_kg REAL DEFAULT 0,
    precio_mag REAL,
    semana_mag TEXT,
    proveedor TEXT,
    es_cc INTEGER DEFAULT 0,
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
    monto_ars REAL NOT NULL,
    monto_kg REAL,
    precio_mag REAL,
    estado TEXT DEFAULT 'PENDIENTE',
    banco TEXT DEFAULT 'NACION',
    concepto TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inversores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inversor TEXT NOT NULL,
    fecha_ingreso TEXT NOT NULL,
    capital_ars REAL NOT NULL,
    capital_kg REAL,
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
    monto_kg_anual REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ciclo, concepto)
  );

  CREATE TABLE IF NOT EXISTS precios_mag (
    semana TEXT PRIMARY KEY,
    fecha_desde TEXT NOT NULL,
    fecha_hasta TEXT NOT NULL,
    precio_promedio REAL NOT NULL,
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
`);

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic();
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

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

  // ═══ Estrategia 1: CALCULAR DESDE DIARIOS CACHEADOS ═══════════════════════
  // Si el cron diario fue guardando precios todos los días hábiles de la semana,
  // calculamos el promedio ponderado nosotros mismos. Ésta es la opción más
  // robusta porque no depende de que ninguna fuente publique "promedio semanal".
  try {
    const sem = { desde: fechaDesde, hasta: fechaHasta, semana: getISOWeek(new Date(fechaDesde + "T12:00:00Z")) };
    const resultado = calcularPromedioSemanalDesdeDiarios(sem);
    if (resultado && resultado.promedio > 0 && resultado.dias >= 2) {
      console.log(`✅ Calculado desde diarios: $${resultado.promedio.toFixed(2)} (${resultado.dias} días)`);
      return resultado;
    }
  } catch (e) {
    console.error(`⚠️ Cálculo desde diarios falló: ${e.message}`);
  }

  // ═══ Estrategia 2: LA NACIÓN (promedio semanal pre-calculado) ═════════════
  // Si La Nación tiene la nota del cierre, ya viene con "promedio semanal" listo.
  try {
    const resultado = await scrapearLaNacion(fechaDesde, fechaHasta);
    if (resultado) {
      console.log(`✅ La Nación: $${resultado.promedio.toFixed(2)} (${resultado.cabezas} cab)`);
      return resultado;
    }
  } catch (e) {
    console.error(`⚠️ La Nación falló: ${e.message}`);
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
  // Soporta formato con o sin punto de miles, y comas/puntos decimales
  const matchPromedio = html.match(/promedio\s+semanal\s+de\s+\$?\s*([\d.]+,\d+)/i);
  if (!matchPromedio) {
    console.log(`   ⚠️ No matchea patrón "promedio semanal de $X"`);
    return null;
  }

  // Argentina: punto = miles, coma = decimales → "4.368,619" → 4368.619
  const promedio = parseFloat(matchPromedio[1].replace(/\./g, "").replace(",", "."));
  if (!isFinite(promedio) || promedio <= 0) {
    console.log(`   ⚠️ Promedio inválido: ${matchPromedio[1]}`);
    return null;
  }

  // Bonus: extraer cabezas semanales si está disponible
  let cabezas = null;
  const matchCab = html.match(/acumulado\s+semanal\s+de\s+([\d.]+)\s+animales/i);
  if (matchCab) {
    cabezas = parseInt(matchCab[1].replace(/\./g, ""));
  }

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

  // Guardar
  db.prepare(`
    INSERT OR REPLACE INTO precios_mag (semana, fecha_desde, fecha_hasta, precio_promedio, cabezas, fuente)
    VALUES (?, ?, ?, ?, ?, 'scraping')
  `).run(semAnt.semana, semAnt.desde, semAnt.hasta, datos.promedio, datos.cabezas);

  console.log(`✅ Precio MAG ${semAnt.semana}: $${datos.promedio.toFixed(2)} ARS/kg (${datos.cabezas} cab, ${datos.dias} días)`);
  return { precio: datos.promedio, semana: semAnt.semana, cabezas: datos.cabezas };
}

// Cron: cada lunes a las 9am, scrapea la semana que terminó el viernes pasado
function scheduleScrapingMAG() {
  let ultimoIntentoExitoso = null;

  // ═══ CICLO DIARIO ═════════════════════════════════════════════════════════
  // Intenta scrapear el INMAG del DÍA actual desde las 3 fuentes nuevas.
  // Se ejecuta cada hora. Si ya tenemos datos del día, no hace nada (no spamea).
  // Si no tenemos, intenta. La idea es que durante el día hábil, alguna llamada
  // entre las 17 y 22 hs caiga después del cierre del MAG (que cierra ~17 hs).
  async function intentarScrapeDiario() {
    const ahora = new Date();
    const hoy = ahora.toISOString().slice(0, 10);
    const diaSemana = ahora.getDay(); // 0=dom 1=lun ... 6=sab

    // Solo días hábiles (lun-vie). Sábado y domingo no opera el MAG.
    if (diaSemana === 0 || diaSemana === 6) return;

    // Solo intentar después de las 20 hs (cuando el MAG cerró totalmente y publicó datos finales)
    // Si scrapeamos antes, agarramos datos parciales del día (solo lo vendido hasta ese momento).
    if (ahora.getHours() < 20) return;

    // ¿Ya tenemos el dato del día con datos COMPLETOS?
    // Si tenemos menos de 3.000 cabezas, asumimos que es un scrape incompleto y reintentamos.
    const yaTenemos = db.prepare("SELECT fecha, cabezas FROM precios_mag_diario WHERE fecha = ?").get(hoy);
    if (yaTenemos && yaTenemos.cabezas >= 3000) return;  // dato completo, no tocar

    if (yaTenemos) {
      console.log(`🐂 [Cron diario] Re-intentando ${hoy} (dato anterior incompleto: ${yaTenemos.cabezas} cab)`);
    } else {
      console.log(`🐂 [Cron diario] Intentando obtener INMAG del ${hoy}...`);
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
  // Una vez al día (10am), si pasaron muchos días sin precio, avisa por WhatsApp.
  async function chequearDatosViejos() {
    const ahora = new Date();
    if (ahora.getHours() !== 10) return;

    const ultimo = db.prepare("SELECT semana, fecha_hasta, fuente FROM precios_mag ORDER BY semana DESC LIMIT 1").get();
    if (!ultimo) return;

    const fechaUltima = new Date(ultimo.fecha_hasta);
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

function fmtArs(n) {
  return parseFloat(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtKg(n) {
  return parseFloat(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function getSaldoProveedor(proveedor) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(egreso_ars), 0) as compras_ars,
      COALESCE(SUM(ingreso_ars), 0) as pagos_ars,
      COALESCE(SUM(egreso_kg), 0) as compras_kg,
      COALESCE(SUM(ingreso_kg), 0) as pagos_kg
    FROM transacciones
    WHERE LOWER(proveedor) = LOWER(?)
  `).get(proveedor);
  return {
    saldo_ars: row.compras_ars - row.pagos_ars,
    saldo_kg: row.compras_kg - row.pagos_kg
  };
}

function getResumenCuentasCorrientes() {
  const proveedores = db.prepare("SELECT * FROM cuentas_corrientes ORDER BY proveedor").all();
  return proveedores.map(p => {
    const s = getSaldoProveedor(p.proveedor);
    return { ...p, ...s };
  }).filter(p => p.saldo_ars !== 0 || p.saldo_kg !== 0);
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

function calcularDeudaInversor(inv) {
  // La deuda se mantiene en kg carne (estable contra inflación) + intereses
  const dias = Math.floor((new Date() - new Date(inv.fecha_ingreso)) / (1000 * 60 * 60 * 24));
  const intereses = (inv.capital_kg || 0) * inv.tasa * (dias / 365);
  return (inv.capital_kg || 0) + intereses;
}

// ── CICLO GANADERO (marzo a marzo) ────────────────────────────────────────────
function parseCiclo(cicloStr) {
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
  const mes = hoy.getMonth() + 1;
  const anio = hoy.getFullYear();
  if (mes >= 3) return parseCiclo(`${anio}/${anio + 1}`);
  return parseCiclo(`${anio - 1}/${anio}`);
}

function getInformeCiclo(cicloStr) {
  const ciclo = parseCiclo(cicloStr);
  if (!ciclo) return null;

  const hoy = new Date().toISOString().slice(0, 10);
  const fechaHasta = ciclo.fecha_hasta < hoy ? ciclo.fecha_hasta : hoy;

  const rows = db.prepare(`
    SELECT concepto,
           SUM(egreso_ars) as total_egreso_ars,
           SUM(ingreso_ars) as total_ingreso_ars,
           SUM(egreso_kg) as total_egreso_kg,
           SUM(ingreso_kg) as total_ingreso_kg,
           COUNT(*) as cant_movimientos
    FROM transacciones
    WHERE fecha >= ? AND fecha <= ?
    GROUP BY concepto ORDER BY total_egreso_kg DESC
  `).all(ciclo.fecha_desde, fechaHasta);

  const totalEgresosArs = rows.reduce((s, r) => s + (r.total_egreso_ars || 0), 0);
  const totalIngresosArs = rows.reduce((s, r) => s + (r.total_ingreso_ars || 0), 0);
  const totalEgresosKg = rows.reduce((s, r) => s + (r.total_egreso_kg || 0), 0);
  const totalIngresosKg = rows.reduce((s, r) => s + (r.total_ingreso_kg || 0), 0);
  const totalMovimientos = rows.reduce((s, r) => s + r.cant_movimientos, 0);

  const presupuestos = db.prepare("SELECT * FROM presupuestos WHERE ciclo = ?").all(ciclo.ciclo);
  const presupuestoMap = {};
  presupuestos.forEach(p => { presupuestoMap[p.concepto] = p.monto_kg_anual; });

  return {
    ciclo, rows,
    totalEgresosArs, totalIngresosArs,
    totalEgresosKg, totalIngresosKg,
    totalMovimientos, presupuestoMap, fechaHasta
  };
}

function getInformeMensual(anio, mes) {
  const periodo = `${anio}-${String(mes).padStart(2, '0')}`;
  const rows = db.prepare(`
    SELECT concepto,
           SUM(egreso_ars) as total_egreso_ars,
           SUM(ingreso_ars) as total_ingreso_ars,
           SUM(egreso_kg) as total_egreso_kg,
           SUM(ingreso_kg) as total_ingreso_kg,
           COUNT(*) as cant
    FROM transacciones WHERE fecha LIKE ?
    GROUP BY concepto ORDER BY total_egreso_kg DESC
  `).all(`${periodo}-%`);

  const totalEgresosArs = rows.reduce((s, r) => s + (r.total_egreso_ars || 0), 0);
  const totalIngresosArs = rows.reduce((s, r) => s + (r.total_ingreso_ars || 0), 0);
  const totalEgresosKg = rows.reduce((s, r) => s + (r.total_egreso_kg || 0), 0);
  const totalIngresosKg = rows.reduce((s, r) => s + (r.total_ingreso_kg || 0), 0);

  const ciclo = mes >= 3
    ? parseCiclo(`${anio}/${anio + 1}`)
    : parseCiclo(`${anio - 1}/${anio}`);

  const presupuestos = ciclo ? db.prepare(
    "SELECT * FROM presupuestos WHERE ciclo = ?"
  ).all(ciclo.ciclo) : [];
  const presupuestoMap = {};
  presupuestos.forEach(p => { presupuestoMap[p.concepto] = p.monto_kg_anual / 12; });

  return {
    periodo, rows,
    totalEgresosArs, totalIngresosArs,
    totalEgresosKg, totalIngresosKg,
    presupuestoMap, ciclo
  };
}

// ── CRON INFORME MENSUAL WHATSAPP ─────────────────────────────────────────────
// El 1ro de cada mes a las 8am, manda el informe del mes anterior a TODOS
// los admins listados en NUMEROS_ADMIN.
function scheduleInformeMensual() {
  let yaEnviadoEsteMes = null; // recordar último envío para no duplicar

  function check() {
    const ahora = new Date();
    const claveMes = `${ahora.getFullYear()}-${ahora.getMonth() + 1}`;

    if (ahora.getDate() === 1 && ahora.getHours() === 8 && yaEnviadoEsteMes !== claveMes) {
      yaEnviadoEsteMes = claveMes;
      // Mes anterior: si hoy es 1ro de mayo, mandamos informe de abril
      const mesAnterior = ahora.getMonth(); // 0-11; ahora.getMonth() ya es el mes actual -1
      const anio = mesAnterior === 0 ? ahora.getFullYear() - 1 : ahora.getFullYear();
      const mes = mesAnterior === 0 ? 12 : mesAnterior;
      enviarInformeMensualWhatsApp(anio, mes);
    }
  }
  setInterval(check, 60 * 60 * 1000); // cada hora
  console.log(`📅 Cron de informe mensual programado (1ro de cada mes, 8am) → ${NUMEROS_ADMIN.length} admin(s)`);
}

async function enviarInformeMensualWhatsApp(anio, mes) {
  if (!NUMEROS_ADMIN.length || !TWILIO_NUMBER) {
    console.log("⚠️ No se puede enviar informe: sin NUMEROS_ADMIN o TWILIO_NUMBER");
    return;
  }

  const meses = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const informe = getInformeMensual(anio, mes);

  let msg = `📊 *VIDELA — Informe ${meses[mes]} ${anio}*\n\n`;

  if (!informe.rows.length) {
    msg += "Sin movimientos en este período.\n";
  } else {
    const lineas = informe.rows.filter(r => r.total_egreso_kg > 0).map(r => {
      const presup = informe.presupuestoMap[r.concepto];
      const pct = presup ? ` (${((r.total_egreso_kg / presup) * 100).toFixed(0)}% presup.)` : "";
      const warn = presup && r.total_egreso_kg > presup ? " ⚠️" : "";
      return `  • ${r.concepto}: ${fmtKg(r.total_egreso_kg)} kg${pct}${warn}`;
    });
    msg += lineas.join("\n");
    msg += `\n\n📤 Egresos: ${fmtKg(informe.totalEgresosKg)} kg ($${fmtArs(informe.totalEgresosArs)})`;
    msg += `\n📥 Ingresos: ${fmtKg(informe.totalIngresosKg)} kg ($${fmtArs(informe.totalIngresosArs)})`;
    msg += `\n💰 Neto: ${fmtKg(informe.totalIngresosKg - informe.totalEgresosKg)} kg`;
    if (PUBLIC_URL) {
      msg += `\n\n📄 PDF: ${PUBLIC_URL}/api/informe-mensual-pdf?anio=${anio}&mes=${mes}`;
    }
  }

  // Enviar a cada admin
  for (const numAdmin of NUMEROS_ADMIN) {
    try {
      await twilioClient.messages.create({
        body: msg,
        from: TWILIO_NUMBER,
        to: numAdmin
      });
      console.log(`✅ Informe enviado a ${numAdmin}`);
    } catch (e) {
      console.error(`❌ Error enviando informe a ${numAdmin}:`, e.message);
    }
  }
}

// ── CONTEXTO IA ───────────────────────────────────────────────────────────────
async function buildContexto() {
  const precioMag = await getPrecioReferencia(new Date().toISOString().slice(0, 10));
  const ultimas = getUltimasTransacciones(10);
  const cuentas = getResumenCuentasCorrientes();
  const chequesPend = getChequesPendientes();
  const inversores = getInversoresActivos();
  const totalDeudaKg = inversores.reduce((s, i) => s + calcularDeudaInversor(i), 0);

  const mesActual = new Date().toISOString().slice(0, 7);
  const egresosMes = db.prepare(`
    SELECT concepto, SUM(egreso_ars) as total_ars, SUM(egreso_kg) as total_kg
    FROM transacciones
    WHERE fecha LIKE ? AND egreso_ars > 0
    GROUP BY concepto ORDER BY total_kg DESC LIMIT 10
  `).all(`${mesActual}-%`);

  return `Sos el asistente financiero de VIDELA, empresa ganadera argentina. Respondés en español rioplatense, conciso (máximo 5 líneas por respuesta de texto).

FECHA DE HOY: ${new Date().toISOString().slice(0,10)} — SIEMPRE usar esta fecha en los registros, nunca inventar fechas.

MONEDA DEL SISTEMA: PESOS ARGENTINOS (ARS).
UNIDAD DE VALOR REAL: KG CARNE (Índice Novillo MAG Cañuelas).
PRECIO MAG SEMANA ANTERIOR: ${precioMag ? `$${precioMag.precio.toFixed(2)} ARS/kg (semana ${precioMag.semana})` : "No disponible"}
${precioMag?.fallback ? "⚠️ Usando último precio disponible (no se pudo scrapear la semana actual)" : ""}

CADA MOVIMIENTO QUE REGISTRES:
- Se guarda en pesos (ARS) tal como lo dice el usuario.
- Se convierte automáticamente a kg carne usando el promedio MAG de la semana ANTERIOR a la fecha del movimiento.
- Esto NO lo hacés vos en el JSON: el sistema lo calcula. Vos solo pasás "egreso_ars" o "ingreso_ars".

CATEGORÍAS DE GASTO: ${CATEGORIAS.join(", ")}

HERRAMIENTAS — cuando sea una acción respondé SOLO con JSON exacto sin texto extra, sin markdown, sin bloques de código. NUNCA muestres el JSON al usuario:
{"accion":"registrar_transaccion","fecha":"YYYY-MM-DD","concepto":"CATEGORIA","detalle":"descripción","ingreso_ars":0,"egreso_ars":0,"proveedor":"nombre o vacío"}
{"accion":"nuevo_proveedor","proveedor":"nombre","notas":""}
{"accion":"pago_proveedor","proveedor":"nombre","monto_ars":0,"fecha":"YYYY-MM-DD"}
{"accion":"nuevo_cheque","fecha_emision":"YYYY-MM-DD","fecha_cobro":"YYYY-MM-DD","tipo":"EMITIDO o RECIBIDO","proveedor":"nombre","monto_ars":0,"banco":"NACION","concepto":""}
{"accion":"marcar_cheque_cobrado","id":0}
{"accion":"nuevo_inversor","inversor":"nombre","capital_ars":0,"tasa":0.08,"notas":""}
{"accion":"borrar_transaccion","id":0}
{"accion":"editar_transaccion","id":0,"concepto":"","detalle":"","egreso_ars":0,"ingreso_ars":0,"proveedor":"","fecha":"YYYY-MM-DD"}
{"accion":"ver_ultimos"}
{"accion":"ver_cuentas"}
{"accion":"ver_cheques"}
{"accion":"ver_inversores"}
{"accion":"ver_mag"}
{"accion":"cargar_mag","precio":4368.62,"semana":"actual o anterior","semana_explicita":"opcional: W21 o 2026-W21 si el usuario especifica","cabezas":0}
{"accion":"resumen_mes"}
{"accion":"resumen_periodo","fecha_desde":"YYYY-MM-DD","fecha_hasta":"YYYY-MM-DD"}
{"accion":"ver_por_fecha","fecha":"YYYY-MM-DD"}
{"accion":"informe_ciclo","ciclo":"25/26"}
{"accion":"set_presupuesto","ciclo":"25/26","concepto":"CATEGORIA","monto_kg_anual":0}
{"accion":"ver_presupuestos","ciclo":"25/26"}
{"accion":"informe_mensual","anio":2026,"mes":3}
{"accion":"informe_pdf","ciclo":"25/26"}
{"accion":"informe_mensual_pdf","anio":2026,"mes":3}
{"accion":"backup","tipo":"transacciones"}
{"accion":"backup","tipo":"completo"}
{"accion":"texto","mensaje":"respuesta en texto"}

CICLOS GANADEROS:
- Marzo a febrero del año siguiente. "ciclo 25/26" = marzo 2025 → febrero 2026.
- Si piden "informe anual" sin especificar → usar ciclo actual.
- Los presupuestos se definen en KG CARNE anuales (no pesos), porque se ajustan solos a la inflación.
- "presupuesto combustible 2000 kg" → set_presupuesto con monto_kg_anual: 2000.

VOCABULARIO ARGENTINO:
NAFTA / GASOIL CAMPO → COMBUSTIBLE CAMPO
GASOIL CAMIONETA / VIATICOS / PEAJES → COMBUSTIBLE VIATICOS
PROVISTA / SUPERMERCADO / VERDULERIA / GARRAFA → PROVISTA
PEON / SUELDO PEON / JORNAL → SUELDO PEON
SUELDO ENCARGADO / CAPATAZ → SUELDO ENCARGADO
ALAMBRE / TRANQUERA / POSTES / TORNILLOS / AISLADORES → MANTENIMIENTO CAMPO
ACEITE TRACTOR / SERVICIO TRACTOR / REPUESTOS MOTO → MANTENIMIENTO MAQUINARIA
SEMILLA / FERTILIZANTE / GASOIL SIEMBRA → VERDEOS Y PASTURAS
VACUNAS / CARAVANAS / DESPARASITARIO → INSUMOS VETERINARIOS
VETERINARIO / TACTO / ECOGRAFIA → TRABAJOS VETERINARIOS
FLETES / GUIAS / DTE → GASTOS VENTAS GANADERAS
ARBA / AFIP / IMPUESTOS → IMPUESTOS
TELEFONO / CELULAR → TELEFONO
CONTADOR / MONOTRIBUTO → GASTOS ADM

REGLAS CRÍTICAS:
- Vocabulario propio del usuario arriba → respetar siempre ese mapeo.
- Si el nombre coincide con un proveedor conocido → usar pago_proveedor.
- "borrar", "eliminar", "anular" + ID → borrar_transaccion.
- "corregir", "editar", "cambiar" + ID → editar_transaccion.
- Si no entendés bien → usar accion texto y preguntar.

DATOS ACTUALES:
Últimas 10: ${JSON.stringify(ultimas.map(t => ({ id: t.id, fecha: t.fecha, concepto: t.concepto, detalle: t.detalle, ingreso_ars: t.ingreso_ars, egreso_ars: t.egreso_ars, kg: t.egreso_kg || t.ingreso_kg, prov: t.proveedor })))}
Cuentas corrientes: ${JSON.stringify(cuentas.map(c => ({ proveedor: c.proveedor, saldo_ars: c.saldo_ars.toFixed(2), saldo_kg: c.saldo_kg.toFixed(1) })))}
Cheques pendientes: ${JSON.stringify(chequesPend.map(c => ({ id: c.id, tipo: c.tipo, prov: c.proveedor, ars: c.monto_ars, kg: c.monto_kg, vence: c.fecha_cobro })))}
Inversores: ${JSON.stringify(inversores.map(i => ({ inversor: i.inversor, capital_kg: i.capital_kg, tasa: i.tasa, deuda_kg: calcularDeudaInversor(i).toFixed(1) })))}
Total deuda inversores: ${fmtKg(totalDeudaKg)} kg carne
Egresos del mes por categoría: ${JSON.stringify(egresosMes)}`;
}

// ── EJECUTAR ACCIÓN ───────────────────────────────────────────────────────────
async function ejecutarAccion(accion) {
  const hoy = new Date().toISOString().split("T")[0];

  // REGISTRAR TRANSACCIÓN
  if (accion.accion === "registrar_transaccion") {
    const { concepto, detalle, proveedor } = accion;
    let { ingreso_ars, egreso_ars } = accion;
    if (!concepto) return "❌ Faltan datos para registrar.";

    let fecha = accion.fecha || hoy;
    const fechaDate = new Date(fecha);
    const diff = Math.abs(new Date() - fechaDate) / (1000 * 60 * 60 * 24);
    if (isNaN(fechaDate) || diff > 365) fecha = hoy;

    // Conversión a kg carne usando promedio MAG de semana anterior
    const mag = await getPrecioReferencia(fecha);
    const precio = mag?.precio || null;
    const ingresoKg = precio && ingreso_ars ? parseFloat(ingreso_ars) / precio : 0;
    const egresoKg = precio && egreso_ars ? parseFloat(egreso_ars) / precio : 0;

    db.prepare(`
      INSERT INTO transacciones (fecha, concepto, detalle, ingreso_ars, egreso_ars, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, fuente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp')
    `).run(
      fecha, concepto, detalle || "",
      parseFloat(ingreso_ars) || 0, parseFloat(egreso_ars) || 0,
      ingresoKg, egresoKg,
      precio, mag?.semana || null,
      proveedor || ""
    );

    const tipo = ingreso_ars > 0
      ? `📥 Ingreso: $${fmtArs(ingreso_ars)} ARS · ${fmtKg(ingresoKg)} kg`
      : `📤 Egreso: $${fmtArs(egreso_ars)} ARS · ${fmtKg(egresoKg)} kg`;
    const magInfo = precio
      ? `\n🐂 MAG ${mag.semana}: $${fmtArs(precio)}/kg`
      : `\n⚠️ Sin precio MAG disponible`;
    return `✅ Registrado!\n📝 ${detalle || concepto}\n${tipo}\n📁 ${concepto}${proveedor ? `\n🏪 ${proveedor}` : ""}${magInfo}`;
  }

  // NUEVO PROVEEDOR
  if (accion.accion === "nuevo_proveedor") {
    const { proveedor, notas } = accion;
    if (!proveedor) return "❌ Falta el nombre del proveedor.";
    try {
      db.prepare("INSERT INTO cuentas_corrientes (proveedor, notas) VALUES (?, ?)").run(proveedor, notas || "");
      return `✅ Proveedor creado!\n🏪 ${proveedor}\nSaldo inicial: $0 ARS / 0 kg`;
    } catch (e) {
      if (e.message.includes("UNIQUE")) return `⚠️ El proveedor "${proveedor}" ya existe.`;
      return "❌ Error al crear proveedor.";
    }
  }

  // PAGO A PROVEEDOR
  if (accion.accion === "pago_proveedor") {
    const { proveedor, monto_ars, fecha } = accion;
    if (!proveedor || !monto_ars) return "❌ Faltan datos para registrar el pago.";

    const fechaPago = fecha || hoy;
    const mag = await getPrecioReferencia(fechaPago);
    const precio = mag?.precio || null;
    const montoKg = precio ? parseFloat(monto_ars) / precio : 0;

    db.prepare(`
      INSERT INTO transacciones (fecha, concepto, detalle, ingreso_ars, ingreso_kg, egreso_ars, egreso_kg, precio_mag, semana_mag, proveedor, fuente)
      VALUES (?, 'PAGO CUENTA CORRIENTE', ?, ?, ?, 0, 0, ?, ?, ?, 'whatsapp')
    `).run(fechaPago, `Pago a ${proveedor}`, parseFloat(monto_ars), montoKg, precio, mag?.semana || null, proveedor);

    const s = getSaldoProveedor(proveedor);
    return `✅ Pago registrado!\n🏪 ${proveedor}\n💰 $${fmtArs(monto_ars)} ARS · ${fmtKg(montoKg)} kg\n📊 Saldo pendiente: $${fmtArs(s.saldo_ars)} ARS · ${fmtKg(s.saldo_kg)} kg`;
  }

  // NUEVO CHEQUE
  if (accion.accion === "nuevo_cheque") {
    const { fecha_emision, fecha_cobro, tipo, proveedor, monto_ars, banco, concepto } = accion;
    if (!monto_ars || !tipo) return "❌ Faltan datos para el cheque.";

    const fechaEm = fecha_emision || hoy;
    const mag = await getPrecioReferencia(fechaEm);
    const precio = mag?.precio || null;
    const montoKg = precio ? parseFloat(monto_ars) / precio : 0;

    const result = db.prepare(`
      INSERT INTO cheques (fecha_emision, fecha_cobro, tipo, proveedor, monto_ars, monto_kg, precio_mag, estado, banco, concepto)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?, ?)
    `).run(fechaEm, fecha_cobro || "", tipo, proveedor || "", parseFloat(monto_ars), montoKg, precio, banco || "NACION", concepto || "");

    const emoji = tipo === "RECIBIDO" ? "📥" : "📤";
    return `✅ Cheque registrado! (ID: ${result.lastInsertRowid})\n${emoji} ${tipo}\n🏪 ${proveedor || "Sin proveedor"}\n💰 $${fmtArs(monto_ars)} ARS · ${fmtKg(montoKg)} kg\n📅 Vence: ${fecha_cobro || "Sin fecha"}`;
  }

  // MARCAR CHEQUE COBRADO
  if (accion.accion === "marcar_cheque_cobrado") {
    const cheque = db.prepare("SELECT * FROM cheques WHERE id = ?").get(accion.id);
    if (!cheque) return "❌ No encontré ese cheque.";
    db.prepare("UPDATE cheques SET estado = 'COBRADO' WHERE id = ?").run(accion.id);
    return `✅ Cheque #${accion.id} marcado como cobrado.\n🏪 ${cheque.proveedor}\n💰 $${fmtArs(cheque.monto_ars)} ARS`;
  }

  // NUEVO INVERSOR
  if (accion.accion === "nuevo_inversor") {
    const { inversor, capital_ars, tasa, notas } = accion;
    if (!inversor || !capital_ars) return "❌ Faltan datos del inversor.";

    const mag = await getPrecioReferencia(hoy);
    const precio = mag?.precio || null;
    const capitalKg = precio ? parseFloat(capital_ars) / precio : 0;

    db.prepare(`
      INSERT INTO inversores (inversor, fecha_ingreso, capital_ars, capital_kg, tasa, deuda_actual, estado, notas)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO', ?)
    `).run(inversor, hoy, parseFloat(capital_ars), capitalKg, parseFloat(tasa) || 0.08, capitalKg, notas || "");

    return `✅ Inversor registrado!\n👤 ${inversor}\n💰 Capital: $${fmtArs(capital_ars)} ARS · ${fmtKg(capitalKg)} kg\n📈 Tasa: ${(parseFloat(tasa) * 100).toFixed(1)}% anual sobre kg\n📅 Ingreso: ${hoy}`;
  }

  // BORRAR
  if (accion.accion === "borrar_transaccion" || accion.accion === "anular_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id = ?").get(accion.id);
    if (!t) return "❌ No encontré esa transacción.";
    db.prepare("DELETE FROM transacciones WHERE id = ?").run(accion.id);
    return `🗑️ Eliminado!\n📝 ${t.detalle || t.concepto}\n💰 ${t.egreso_ars > 0 ? `-$${fmtArs(t.egreso_ars)}` : `+$${fmtArs(t.ingreso_ars)}`} ARS\n📅 ${t.fecha}`;
  }

  // EDITAR
  if (accion.accion === "editar_transaccion") {
    const t = db.prepare("SELECT * FROM transacciones WHERE id = ?").get(accion.id);
    if (!t) return "❌ No encontré esa transacción.";
    const campos = {};
    if (accion.concepto) campos.concepto = accion.concepto;
    if (accion.detalle) campos.detalle = accion.detalle;
    if (accion.proveedor !== undefined) campos.proveedor = accion.proveedor;

    let fechaCambio = null;
    if (accion.fecha) {
      campos.fecha = accion.fecha;
      fechaCambio = accion.fecha;
    }

    // Si cambian montos, recalcular kg
    if (accion.egreso_ars !== undefined || accion.ingreso_ars !== undefined) {
      const fechaUsar = fechaCambio || t.fecha;
      const mag = await getPrecioReferencia(fechaUsar);
      const precio = mag?.precio || t.precio_mag;

      if (accion.egreso_ars !== undefined) {
        campos.egreso_ars = parseFloat(accion.egreso_ars);
        campos.egreso_kg = precio ? parseFloat(accion.egreso_ars) / precio : 0;
      }
      if (accion.ingreso_ars !== undefined) {
        campos.ingreso_ars = parseFloat(accion.ingreso_ars);
        campos.ingreso_kg = precio ? parseFloat(accion.ingreso_ars) / precio : 0;
      }
      campos.precio_mag = precio;
      campos.semana_mag = mag?.semana || t.semana_mag;
    }

    if (!Object.keys(campos).length) return "❌ No hay campos para editar.";
    const sets = Object.keys(campos).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE transacciones SET ${sets} WHERE id = ?`).run(...Object.values(campos), accion.id);
    return `✅ Transacción #${accion.id} actualizada!`;
  }

  // VER ÚLTIMOS
  if (accion.accion === "ver_ultimos") {
    const u = getUltimasTransacciones(8);
    if (!u.length) return "📋 No hay transacciones registradas.";
    const lineas = u.map((t, i) => {
      const monto = t.egreso_ars > 0
        ? `-$${fmtArs(t.egreso_ars)} (${fmtKg(t.egreso_kg)}kg)`
        : `+$${fmtArs(t.ingreso_ars)} (${fmtKg(t.ingreso_kg)}kg)`;
      return `${i + 1}. [#${t.id}] ${t.concepto} · ${monto} · ${t.fecha}${t.proveedor ? ` · ${t.proveedor}` : ""}`;
    }).join("\n");
    return `📋 *Últimas transacciones:*\n\n${lineas}\n\nPara borrar decí "borrar #ID"`;
  }

  // VER CUENTAS
  if (accion.accion === "ver_cuentas") {
    const c = getResumenCuentasCorrientes();
    if (!c.length) return "📋 No hay cuentas con saldo pendiente.";
    const lineas = c.map(x =>
      `${x.saldo_ars > 0 ? "🔴" : "🟢"} ${x.proveedor}: $${fmtArs(Math.abs(x.saldo_ars))} ARS · ${fmtKg(Math.abs(x.saldo_kg))} kg ${x.saldo_ars > 0 ? "(debemos)" : "(a favor)"}`
    ).join("\n");
    const totalKg = c.reduce((s, x) => s + x.saldo_kg, 0);
    return `🔄 *Cuentas Corrientes:*\n\n${lineas}\n\n💳 Total adeudado: ${fmtKg(totalKg)} kg carne`;
  }

  // VER CHEQUES
  if (accion.accion === "ver_cheques") {
    const ch = getChequesPendientes();
    if (!ch.length) return "✅ No hay cheques pendientes.";
    const lineas = ch.map(c =>
      `${c.tipo === "EMITIDO" ? "📤" : "📥"} [#${c.id}] ${c.proveedor || "S/prov"} · $${fmtArs(c.monto_ars)} (${fmtKg(c.monto_kg)}kg) · vence ${c.fecha_cobro || "s/fecha"}`
    ).join("\n");
    const total = ch.reduce((s, c) => s + (c.monto_ars || 0), 0);
    return `🏦 *Cheques pendientes:*\n\n${lineas}\n\n💳 Total: $${fmtArs(total)} ARS`;
  }

  // VER INVERSORES
  if (accion.accion === "ver_inversores") {
    const inv = getInversoresActivos();
    if (!inv.length) return "📋 No hay inversores activos.";
    const lineas = inv.map(i => {
      const deuda = calcularDeudaInversor(i);
      return `👤 ${i.inversor}\n   Capital: ${fmtKg(i.capital_kg)} kg · Tasa: ${(i.tasa * 100).toFixed(1)}%\n   Deuda actual: ${fmtKg(deuda)} kg carne`;
    }).join("\n\n");
    const total = inv.reduce((s, i) => s + calcularDeudaInversor(i), 0);
    return `👥 *Inversores activos:*\n\n${lineas}\n\n💳 Deuda total: ${fmtKg(total)} kg carne`;
  }

  // VER MAG
  if (accion.accion === "ver_mag") {
    const ult = db.prepare("SELECT * FROM precios_mag ORDER BY semana DESC LIMIT 6").all();
    if (!ult.length) return "📊 No hay precios MAG cargados todavía.";
    const lineas = ult.map(p =>
      `📅 ${p.semana} (${p.fecha_desde} → ${p.fecha_hasta}): $${fmtArs(p.precio_promedio)}/kg${p.cabezas ? ` (${p.cabezas.toLocaleString("es-AR")} cab)` : ""}`
    ).join("\n");
    return `🐂 *Precios Índice Novillo MAG:*\n\n${lineas}`;
  }

  // CARGAR MAG MANUAL (fallback si el scraping falla)
  // Acepta:
  //   "cargar mag 4368.62"              → semana anterior (cerrada)
  //   "cargar mag 4368.62 cabezas 12000" → semana anterior con cabezas
  //   "cargar mag W21 4368.62"          → semana específica
  //   "cargar mag 2026-W21 4368.62"     → semana específica (formato largo)
  if (accion.accion === "cargar_mag") {
    const precio = parseFloat(accion.precio);
    if (!precio || precio <= 0) return "❌ Precio inválido. Ej: 'cargar mag 4368.62' o 'cargar mag W21 4368.62'";

    // Si vino una semana explícita en formato "2026-W21" o "W21", la usamos
    let semInfo;
    const semanaInput = accion.semana_explicita || "";
    const matchSemanaCompleta = semanaInput.match(/^(\d{4})-W(\d{1,2})$/i);
    const matchSemanaCorta = semanaInput.match(/^W(\d{1,2})$/i);

    if (matchSemanaCompleta || matchSemanaCorta) {
      const anio = matchSemanaCompleta ? parseInt(matchSemanaCompleta[1]) : new Date().getFullYear();
      const numSem = parseInt(matchSemanaCompleta ? matchSemanaCompleta[2] : matchSemanaCorta[1]);

      // Calcular el lunes de esa semana ISO
      const enero4 = new Date(Date.UTC(anio, 0, 4));
      const enero4DOW = enero4.getUTCDay() || 7;
      const lunesSemana1 = new Date(enero4);
      lunesSemana1.setUTCDate(enero4.getUTCDate() - enero4DOW + 1);
      const lunesObjetivo = new Date(lunesSemana1);
      lunesObjetivo.setUTCDate(lunesSemana1.getUTCDate() + (numSem - 1) * 7);
      const viernesObjetivo = new Date(lunesObjetivo);
      viernesObjetivo.setUTCDate(lunesObjetivo.getUTCDate() + 4);

      semInfo = {
        semana: `${anio}-W${String(numSem).padStart(2, "0")}`,
        desde: lunesObjetivo.toISOString().slice(0, 10),
        hasta: viernesObjetivo.toISOString().slice(0, 10),
      };
    } else {
      // Sin semana explícita: por defecto, la semana cerrada anterior
      const hoy = new Date();
      const cualSemana = (accion.semana || "anterior").toLowerCase();
      semInfo = cualSemana === "actual" ? getRangoSemana(hoy) : getSemanaAnterior(hoy);
    }

    db.prepare(`
      INSERT OR REPLACE INTO precios_mag (semana, fecha_desde, fecha_hasta, precio_promedio, cabezas, fuente)
      VALUES (?, ?, ?, ?, ?, 'manual')
    `).run(semInfo.semana, semInfo.desde, semInfo.hasta, precio, parseInt(accion.cabezas) || 0);

    return `✅ Precio MAG cargado manualmente!\n📅 Semana ${semInfo.semana} (${semInfo.desde} → ${semInfo.hasta})\n💰 $${fmtArs(precio)}/kg\n${accion.cabezas ? `🐂 ${accion.cabezas} cabezas` : ""}`;
  }

  // RESUMEN MES
  if (accion.accion === "resumen_mes") {
    const periodo = accion.periodo || new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT concepto,
             SUM(egreso_ars) as eg_ars, SUM(ingreso_ars) as in_ars,
             SUM(egreso_kg) as eg_kg, SUM(ingreso_kg) as in_kg
      FROM transacciones WHERE fecha LIKE ?
      GROUP BY concepto ORDER BY eg_kg DESC
    `).all(`${periodo}-%`);

    if (!rows.length) return `📊 No hay movimientos en ${periodo}.`;

    const totalEgArs = rows.reduce((s, r) => s + (r.eg_ars || 0), 0);
    const totalEgKg = rows.reduce((s, r) => s + (r.eg_kg || 0), 0);
    const totalInArs = rows.reduce((s, r) => s + (r.in_ars || 0), 0);
    const totalInKg = rows.reduce((s, r) => s + (r.in_kg || 0), 0);
    const lineas = rows.filter(r => r.eg_ars > 0)
      .map(r => `  • ${r.concepto}: $${fmtArs(r.eg_ars)} ARS · ${fmtKg(r.eg_kg)} kg`).join("\n");

    return `📊 *Resumen ${periodo}*\n\n${lineas || "Sin egresos"}\n\n📤 Egresos: $${fmtArs(totalEgArs)} ARS · ${fmtKg(totalEgKg)} kg\n📥 Ingresos: $${fmtArs(totalInArs)} ARS · ${fmtKg(totalInKg)} kg\n💰 Neto: ${fmtKg(totalInKg - totalEgKg)} kg carne`;
  }

  // RESUMEN PERÍODO
  if (accion.accion === "resumen_periodo") {
    const { fecha_desde, fecha_hasta } = accion;
    if (!fecha_desde || !fecha_hasta) return "❌ Necesito fecha_desde y fecha_hasta.";

    const rows = db.prepare(`
      SELECT concepto,
             SUM(egreso_ars) as eg_ars, SUM(ingreso_ars) as in_ars,
             SUM(egreso_kg) as eg_kg, SUM(ingreso_kg) as in_kg
      FROM transacciones WHERE fecha BETWEEN ? AND ?
      GROUP BY concepto ORDER BY eg_kg DESC
    `).all(fecha_desde, fecha_hasta);

    if (!rows.length) return `📊 No hay movimientos entre ${fecha_desde} y ${fecha_hasta}.`;

    const totalEgKg = rows.reduce((s, r) => s + (r.eg_kg || 0), 0);
    const totalInKg = rows.reduce((s, r) => s + (r.in_kg || 0), 0);
    const lineas = rows.filter(r => r.eg_kg > 0)
      .map(r => `  • ${r.concepto}: ${fmtKg(r.eg_kg)} kg ($${fmtArs(r.eg_ars)})`).join("\n");

    return `📊 *${fecha_desde} → ${fecha_hasta}*\n\n${lineas || "Sin egresos"}\n\n📤 Egresos: ${fmtKg(totalEgKg)} kg\n📥 Ingresos: ${fmtKg(totalInKg)} kg`;
  }

  // VER POR FECHA
  if (accion.accion === "ver_por_fecha") {
    const { fecha } = accion;
    if (!fecha) return "❌ Necesito una fecha.";
    const rows = db.prepare("SELECT * FROM transacciones WHERE fecha = ? ORDER BY created_at ASC").all(fecha);
    if (!rows.length) return `📋 No hay movimientos el ${fecha}.`;
    const lineas = rows.map((t, i) =>
      `${i+1}. [#${t.id}] ${t.concepto} · ${t.detalle} · ${t.egreso_ars > 0 ? `-$${fmtArs(t.egreso_ars)} (${fmtKg(t.egreso_kg)}kg)` : `+$${fmtArs(t.ingreso_ars)} (${fmtKg(t.ingreso_kg)}kg)`}`
    ).join("\n");
    return `📋 *Movimientos del ${fecha}:*\n\n${lineas}`;
  }

  if (accion.accion === "texto") return accion.mensaje;

  // INFORME CICLO
  if (accion.accion === "informe_ciclo") {
    const cicloStr = accion.ciclo || `${getCicloActual().ciclo}`;
    const informe = getInformeCiclo(cicloStr);
    if (!informe) return "❌ Ciclo inválido. Usá formato 25/26.";
    if (!informe.rows.length) return `📊 No hay movimientos en ciclo ${informe.ciclo.label}.`;

    const lineas = informe.rows.filter(r => r.total_egreso_kg > 0).map(r => {
      const presup = informe.presupuestoMap[r.concepto];
      let extra = "";
      if (presup) {
        const pct = ((r.total_egreso_kg / presup) * 100).toFixed(0);
        extra = ` (${pct}% de ${fmtKg(presup)}kg)`;
        if (r.total_egreso_kg > presup) extra += " ⚠️";
      }
      return `  • ${r.concepto}: ${fmtKg(r.total_egreso_kg)} kg${extra}`;
    });

    let msg = `📊 *VIDELA — Ciclo ${informe.ciclo.label}*\n`;
    msg += `📅 ${informe.ciclo.fecha_desde} → ${informe.fechaHasta}\n`;
    msg += `📋 ${informe.totalMovimientos} movimientos\n\n`;
    msg += lineas.join("\n");
    msg += `\n\n📤 Egresos: ${fmtKg(informe.totalEgresosKg)} kg ($${fmtArs(informe.totalEgresosArs)})`;
    msg += `\n📥 Ingresos: ${fmtKg(informe.totalIngresosKg)} kg ($${fmtArs(informe.totalIngresosArs)})`;
    msg += `\n💰 Neto: ${fmtKg(informe.totalIngresosKg - informe.totalEgresosKg)} kg carne`;

    const totalPresup = Object.values(informe.presupuestoMap).reduce((s, v) => s + v, 0);
    if (totalPresup > 0) {
      const pctTotal = ((informe.totalEgresosKg / totalPresup) * 100).toFixed(0);
      msg += `\n\n📐 Presupuesto ciclo: ${fmtKg(totalPresup)} kg`;
      msg += `\n📊 Ejecutado: ${pctTotal}%`;
    }
    return msg;
  }

  // SET PRESUPUESTO
  if (accion.accion === "set_presupuesto") {
    const cicloStr = accion.ciclo || getCicloActual().ciclo;
    const ciclo = parseCiclo(cicloStr);
    if (!ciclo) return "❌ Ciclo inválido. Usá formato 25/26.";
    if (!accion.concepto || !accion.monto_kg_anual) return "❌ Necesito categoría y monto en kg.";

    db.prepare(`
      INSERT INTO presupuestos (ciclo, concepto, monto_kg_anual)
      VALUES (?, ?, ?)
      ON CONFLICT(ciclo, concepto) DO UPDATE SET monto_kg_anual = excluded.monto_kg_anual
    `).run(ciclo.ciclo, accion.concepto.toUpperCase(), parseFloat(accion.monto_kg_anual));

    return `✅ Presupuesto definido!\n📁 ${accion.concepto.toUpperCase()}\n📦 ${fmtKg(accion.monto_kg_anual)} kg/año\n📅 Ciclo ${ciclo.label}`;
  }

  // VER PRESUPUESTOS
  if (accion.accion === "ver_presupuestos") {
    const cicloStr = accion.ciclo || getCicloActual().ciclo;
    const ciclo = parseCiclo(cicloStr);
    if (!ciclo) return "❌ Ciclo inválido.";

    const presupuestos = db.prepare(
      "SELECT * FROM presupuestos WHERE ciclo = ? ORDER BY concepto"
    ).all(ciclo.ciclo);

    if (!presupuestos.length) return `📋 No hay presupuestos para ciclo ${ciclo.label}.`;

    const hoy = new Date().toISOString().slice(0, 10);
    const fechaHasta = ciclo.fecha_hasta < hoy ? ciclo.fecha_hasta : hoy;

    const lineas = presupuestos.map(p => {
      const real = db.prepare(`
        SELECT COALESCE(SUM(egreso_kg), 0) as total
        FROM transacciones
        WHERE concepto = ? AND fecha >= ? AND fecha <= ?
      `).get(p.concepto, ciclo.fecha_desde, fechaHasta);

      const gastado = real.total;
      const pct = ((gastado / p.monto_kg_anual) * 100).toFixed(0);
      const warn = gastado > p.monto_kg_anual ? " ⚠️ EXCEDIDO" : "";
      const bar = gastado > 0 ? ` [${"█".repeat(Math.min(Math.round(pct / 10), 10))}${"░".repeat(Math.max(10 - Math.round(pct / 10), 0))}]` : "";
      return `📁 ${p.concepto}\n   ${fmtKg(gastado)} / ${fmtKg(p.monto_kg_anual)} kg (${pct}%)${bar}${warn}`;
    });

    const totalPresup = presupuestos.reduce((s, p) => s + p.monto_kg_anual, 0);
    return `📐 *Presupuestos — Ciclo ${ciclo.label}*\n\n${lineas.join("\n\n")}\n\n📦 Total: ${fmtKg(totalPresup)} kg`;
  }

  // INFORME MENSUAL
  if (accion.accion === "informe_mensual") {
    const meses = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
    const anio = accion.anio || new Date().getFullYear();
    const mes = accion.mes || new Date().getMonth() + 1;
    const inf = getInformeMensual(anio, mes);

    if (!inf.rows.length) return `📊 No hay movimientos en ${meses[mes]} ${anio}.`;

    const lineas = inf.rows.filter(r => r.total_egreso_kg > 0).map(r => {
      const presup = inf.presupuestoMap[r.concepto];
      const pct = presup ? ` (${((r.total_egreso_kg / presup) * 100).toFixed(0)}%)` : "";
      const warn = presup && r.total_egreso_kg > presup ? " ⚠️" : "";
      return `  • ${r.concepto}: ${fmtKg(r.total_egreso_kg)} kg${pct}${warn}`;
    });

    let msg = `📊 *VIDELA — ${meses[mes]} ${anio}*\n\n`;
    msg += lineas.join("\n");
    msg += `\n\n📤 Egresos: ${fmtKg(inf.totalEgresosKg)} kg ($${fmtArs(inf.totalEgresosArs)})`;
    msg += `\n📥 Ingresos: ${fmtKg(inf.totalIngresosKg)} kg ($${fmtArs(inf.totalIngresosArs)})`;
    msg += `\n💰 Neto: ${fmtKg(inf.totalIngresosKg - inf.totalEgresosKg)} kg`;
    return msg;
  }

  // INFORMES PDF
  if (accion.accion === "informe_pdf") {
    const cicloStr = accion.ciclo || getCicloActual().ciclo;
    const ciclo = parseCiclo(cicloStr);
    if (!ciclo) return "❌ Ciclo inválido.";
    const url = `${PUBLIC_URL}/api/informe-pdf?ciclo=${encodeURIComponent(cicloStr)}`;
    return `📄 *Informe PDF — Ciclo ${ciclo.label}*\n\n📥 Descargá:\n${url}`;
  }

  if (accion.accion === "informe_mensual_pdf") {
    const meses = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
    const anio = accion.anio || new Date().getFullYear();
    const mes = accion.mes || new Date().getMonth() + 1;
    const url = `${PUBLIC_URL}/api/informe-mensual-pdf?anio=${anio}&mes=${mes}`;
    return `📄 *Informe PDF — ${meses[mes]} ${anio}*\n\n📥 Descargá:\n${url}`;
  }

  // BACKUP
  if (accion.accion === "backup") {
    const tipo = accion.tipo || "transacciones";
    if (tipo === "completo") {
      return `💾 *Backup completo:*\n\n📥 ${PUBLIC_URL}/api/backup-completo`;
    }
    return `💾 *Backup transacciones:*\n\n📥 ${PUBLIC_URL}/api/backup`;
  }

  return "No entendí. Probá de nuevo.";
}

// ── WEBHOOK INTERNO ───────────────────────────────────────────────────────────
app.post("/webhook-interno", async (req, res) => {
  try {
    const body = (req.body.Body || "").trim();
    const usuario = "videla";
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

    const raw = result.content[0].text.trim();
    historial.push({ role: "assistant", content: raw });
    saveHistorial(usuario, historial);

    const limpio = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    try {
      const jsonMatch = limpio.match(/\{[\s\S]*"accion"[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : limpio;
      const accion = JSON.parse(jsonStr);
      if (accion?.accion) {
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
    res.json({ respuesta: "❌ Error en VIDELA. Intentá de nuevo." });
  }
});

// ── WEBHOOK WHATSAPP ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const body = (req.body.Body || "").trim();
    const usuario = "videla";
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

    const raw = result.content[0].text.trim();
    historial.push({ role: "assistant", content: raw });
    saveHistorial(usuario, historial);

    const limpio = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    try {
      const jsonMatch = limpio.match(/\{[\s\S]*"accion"[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : limpio;
      const accion = JSON.parse(jsonStr);
      if (accion?.accion) {
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

// ── API REST ──────────────────────────────────────────────────────────────────
app.get("/api/transacciones", (req, res) => {
  const limite = parseInt(req.query.limite) || 100;
  const rows = db.prepare("SELECT * FROM transacciones ORDER BY fecha DESC, created_at DESC LIMIT ?").all(limite);
  res.json(rows);
});

app.get("/api/cuentas", (req, res) => {
  const cuentas = db.prepare("SELECT * FROM cuentas_corrientes ORDER BY proveedor").all();
  const conSaldo = cuentas.map(c => ({ ...c, ...getSaldoProveedor(c.proveedor) }));
  res.json(conSaldo);
});

app.get("/api/cheques", (req, res) => {
  res.json(db.prepare("SELECT * FROM cheques ORDER BY fecha_cobro ASC").all());
});

app.get("/api/inversores", (req, res) => {
  const rows = db.prepare("SELECT * FROM inversores ORDER BY inversor").all();
  res.json(rows.map(i => ({ ...i, deuda_calculada_kg: calcularDeudaInversor(i) })));
});

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

app.get("/api/resumen", (req, res) => {
  const mesActual = new Date().toISOString().slice(0, 7);
  const eg = db.prepare(`SELECT SUM(egreso_ars) as a, SUM(egreso_kg) as k FROM transacciones WHERE fecha LIKE ?`).get(`${mesActual}-%`);
  const ing = db.prepare(`SELECT SUM(ingreso_ars) as a, SUM(ingreso_kg) as k FROM transacciones WHERE fecha LIKE ?`).get(`${mesActual}-%`);
  const ch = db.prepare("SELECT COUNT(*) as t, SUM(monto_ars) as m, SUM(monto_kg) as mk FROM cheques WHERE estado = 'PENDIENTE'").get();
  const inv = getInversoresActivos();
  const totalDeudaKg = inv.reduce((s, i) => s + calcularDeudaInversor(i), 0);
  const totalMov = db.prepare("SELECT COUNT(*) as t FROM transacciones").get();

  res.json({
    egresos_mes_ars: eg?.a || 0,
    egresos_mes_kg: eg?.k || 0,
    ingresos_mes_ars: ing?.a || 0,
    ingresos_mes_kg: ing?.k || 0,
    cheques_pendientes: ch?.t || 0,
    monto_cheques_ars: ch?.m || 0,
    monto_cheques_kg: ch?.mk || 0,
    deuda_inversores_kg: totalDeudaKg,
    total_movimientos: totalMov?.t || 0
  });
});

app.get("/api/presupuestos", (req, res) => {
  const cicloStr = req.query.ciclo || getCicloActual().ciclo;
  const ciclo = parseCiclo(cicloStr);
  if (!ciclo) return res.status(400).json({ error: "Ciclo inválido" });

  const pres = db.prepare("SELECT * FROM presupuestos WHERE ciclo = ? ORDER BY concepto").all(ciclo.ciclo);
  const hoy = new Date().toISOString().slice(0, 10);
  const fechaHasta = ciclo.fecha_hasta < hoy ? ciclo.fecha_hasta : hoy;

  const resultado = pres.map(p => {
    const real = db.prepare(`
      SELECT COALESCE(SUM(egreso_kg), 0) as total
      FROM transacciones WHERE concepto = ? AND fecha >= ? AND fecha <= ?
    `).get(p.concepto, ciclo.fecha_desde, fechaHasta);
    return { ...p, gastado_kg: real.total, porcentaje: p.monto_kg_anual > 0 ? ((real.total / p.monto_kg_anual) * 100) : 0 };
  });

  res.json({ ciclo: ciclo.label, presupuestos: resultado });
});

app.post("/api/presupuestos", (req, res) => {
  const { ciclo, concepto, monto_kg_anual } = req.body;
  const cicloObj = parseCiclo(ciclo || getCicloActual().ciclo);
  if (!cicloObj || !concepto || !monto_kg_anual) return res.status(400).json({ error: "Faltan datos" });

  db.prepare(`
    INSERT INTO presupuestos (ciclo, concepto, monto_kg_anual)
    VALUES (?, ?, ?)
    ON CONFLICT(ciclo, concepto) DO UPDATE SET monto_kg_anual = excluded.monto_kg_anual
  `).run(cicloObj.ciclo, concepto.toUpperCase(), parseFloat(monto_kg_anual));

  res.json({ ok: true, ciclo: cicloObj.label, concepto: concepto.toUpperCase(), monto_kg_anual: parseFloat(monto_kg_anual) });
});

app.get("/api/informe-ciclo", (req, res) => {
  const cicloStr = req.query.ciclo || getCicloActual().ciclo;
  const inf = getInformeCiclo(cicloStr);
  if (!inf) return res.status(400).json({ error: "Ciclo inválido" });
  res.json({
    ciclo: inf.ciclo.label,
    fecha_desde: inf.ciclo.fecha_desde,
    fecha_hasta: inf.fechaHasta,
    total_egresos_ars: inf.totalEgresosArs,
    total_egresos_kg: inf.totalEgresosKg,
    total_ingresos_ars: inf.totalIngresosArs,
    total_ingresos_kg: inf.totalIngresosKg,
    total_movimientos: inf.totalMovimientos,
    categorias: inf.rows,
    presupuestos: inf.presupuestoMap
  });
});

app.get("/api/informe-mensual", (req, res) => {
  const anio = parseInt(req.query.anio) || new Date().getFullYear();
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const inf = getInformeMensual(anio, mes);
  res.json({
    periodo: inf.periodo,
    total_egresos_ars: inf.totalEgresosArs,
    total_egresos_kg: inf.totalEgresosKg,
    total_ingresos_ars: inf.totalIngresosArs,
    total_ingresos_kg: inf.totalIngresosKg,
    categorias: inf.rows,
    presupuestos_mensualizados: inf.presupuestoMap
  });
});

// ── BACKUP CSV ────────────────────────────────────────────────────────────────
app.get("/api/backup", (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const rows = db.prepare("SELECT * FROM transacciones ORDER BY fecha ASC, id ASC").all();
    const headers = ["id","fecha","concepto","detalle","ingreso_ars","egreso_ars","ingreso_kg","egreso_kg","precio_mag","semana_mag","proveedor","es_cc","fuente","created_at"];
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
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="VIDELA_backup_${hoy}.csv"`);
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("Error backup:", err);
    res.status(500).json({ error: "Error backup" });
  }
});

app.get("/api/backup-completo", (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    function tableToCsv(t) {
      const rows = db.prepare(`SELECT * FROM ${t}`).all();
      if (!rows.length) return "";
      const headers = Object.keys(rows[0]);
      const lines = [headers.join(",")];
      for (const r of rows) {
        const line = headers.map(h => {
          let v = r[h] ?? "";
          v = String(v).replace(/"/g, '""');
          if (String(v).includes(",") || String(v).includes('"') || String(v).includes("\n")) v = `"${v}"`;
          return v;
        });
        lines.push(line.join(","));
      }
      return lines.join("\n");
    }
    const tablas = ["transacciones","cuentas_corrientes","cheques","inversores","presupuestos","precios_mag"];
    const sep = "\n\n========================================\n";
    let cont = "";
    for (const t of tablas) {
      const csv = tableToCsv(t);
      if (csv) cont += `=== TABLA: ${t.toUpperCase()} ===\n${csv}${sep}`;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="VIDELA_backup_completo_${hoy}.csv"`);
    res.send(cont);
  } catch (err) {
    console.error("Error backup completo:", err);
    res.status(500).json({ error: "Error" });
  }
});

// ── INFORME PDF CICLO ─────────────────────────────────────────────────────────
app.get("/api/informe-pdf", (req, res) => {
  try {
    const cicloStr = req.query.ciclo || getCicloActual().ciclo;
    const inf = getInformeCiclo(cicloStr);
    if (!inf) return res.status(400).json({ error: "Ciclo inválido" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="VIDELA_${inf.ciclo.label.replace("/", "-")}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
    doc.pipe(res);

    const verde = "#2d5a3d";
    const dorado = "#c4923a";
    const gris = "#666666";

    doc.fillColor(verde).fontSize(20).font('Helvetica-Bold').text("VIDELA", 40, 40);
    doc.fillColor(dorado).fontSize(10).font('Helvetica').text("GESTIÓN GANADERA ARGENTINA", 40, 65);
    doc.fillColor(gris).fontSize(9).text(`Ciclo ${inf.ciclo.label}  ·  ${inf.ciclo.fecha_desde} → ${inf.fechaHasta}`, 40, 80);
    doc.moveTo(40, 100).lineTo(555, 100).strokeColor(verde).lineWidth(2).stroke();

    let y = 120;

    doc.fillColor(verde).fontSize(13).font('Helvetica-Bold').text("RESUMEN GENERAL", 40, y);
    y += 25;

    doc.fillColor("#000").fontSize(10).font('Helvetica');
    doc.text(`Egresos totales:  ${fmtKg(inf.totalEgresosKg)} kg carne   ($${fmtArs(inf.totalEgresosArs)} ARS)`, 40, y); y += 15;
    doc.text(`Ingresos totales: ${fmtKg(inf.totalIngresosKg)} kg carne   ($${fmtArs(inf.totalIngresosArs)} ARS)`, 40, y); y += 15;
    doc.fillColor(verde).font('Helvetica-Bold').text(`Resultado neto:   ${fmtKg(inf.totalIngresosKg - inf.totalEgresosKg)} kg carne`, 40, y); y += 25;
    doc.fillColor(gris).fontSize(8).font('Helvetica').text(`${inf.totalMovimientos} movimientos registrados`, 40, y); y += 25;

    doc.fillColor(verde).fontSize(13).font('Helvetica-Bold').text("DESGLOSE POR CATEGORÍA", 40, y); y += 20;

    doc.fillColor(gris).fontSize(9).font('Helvetica-Bold');
    doc.text("Categoría", 40, y);
    doc.text("Egresos (kg)", 240, y, { width: 100, align: "right" });
    doc.text("Egresos (ARS)", 350, y, { width: 110, align: "right" });
    doc.text("% Presup.", 470, y, { width: 80, align: "right" });
    y += 15;
    doc.moveTo(40, y).lineTo(555, y).strokeColor(verde).lineWidth(0.5).stroke();
    y += 8;

    doc.fillColor("#000").font('Helvetica').fontSize(9);
    inf.rows.filter(r => r.total_egreso_kg > 0).forEach(r => {
      if (y > 770) { doc.addPage(); y = 40; }
      const presup = inf.presupuestoMap[r.concepto];
      const pct = presup ? `${((r.total_egreso_kg / presup) * 100).toFixed(0)}%` : "—";
      doc.text(r.concepto, 40, y, { width: 195 });
      doc.text(fmtKg(r.total_egreso_kg), 240, y, { width: 100, align: "right" });
      doc.text(fmtArs(r.total_egreso_ars), 350, y, { width: 110, align: "right" });
      doc.fillColor(presup && r.total_egreso_kg > presup ? "#c23b3b" : "#000").text(pct, 470, y, { width: 80, align: "right" });
      doc.fillColor("#000");
      y += 14;
    });

    // Pie
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor(gris).font('Helvetica')
         .text(`VIDELA · Ciclo ${inf.ciclo.label} · Página ${i + 1} de ${pages.count}`,
           40, doc.page.height - 25, { width: doc.page.width - 80, align: "center" });
    }

    doc.end();
  } catch (err) {
    console.error("Error PDF:", err);
    res.status(500).json({ error: "Error generando PDF" });
  }
});

// ── INFORME PDF MENSUAL ───────────────────────────────────────────────────────
app.get("/api/informe-mensual-pdf", (req, res) => {
  try {
    const meses = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
    const anio = parseInt(req.query.anio) || new Date().getFullYear();
    const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
    const inf = getInformeMensual(anio, mes);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="VIDELA_${meses[mes]}_${anio}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
    doc.pipe(res);

    const verde = "#2d5a3d", dorado = "#c4923a", gris = "#666666";

    doc.fillColor(verde).fontSize(20).font('Helvetica-Bold').text("VIDELA", 40, 40);
    doc.fillColor(dorado).fontSize(10).font('Helvetica').text(`${meses[mes].toUpperCase()} ${anio}`, 40, 65);
    doc.moveTo(40, 90).lineTo(555, 90).strokeColor(verde).lineWidth(2).stroke();

    let y = 110;
    doc.fillColor("#000").fontSize(10);
    doc.text(`Egresos:  ${fmtKg(inf.totalEgresosKg)} kg   ($${fmtArs(inf.totalEgresosArs)} ARS)`, 40, y); y += 14;
    doc.text(`Ingresos: ${fmtKg(inf.totalIngresosKg)} kg   ($${fmtArs(inf.totalIngresosArs)} ARS)`, 40, y); y += 14;
    doc.fillColor(verde).font('Helvetica-Bold').text(`Neto:     ${fmtKg(inf.totalIngresosKg - inf.totalEgresosKg)} kg`, 40, y); y += 25;

    doc.fillColor(verde).fontSize(12).text("CATEGORÍAS", 40, y); y += 18;
    doc.fillColor("#000").font('Helvetica').fontSize(9);
    inf.rows.filter(r => r.total_egreso_kg > 0).forEach(r => {
      if (y > 770) { doc.addPage(); y = 40; }
      const presup = inf.presupuestoMap[r.concepto];
      const pct = presup ? ` (${((r.total_egreso_kg / presup) * 100).toFixed(0)}% presup. mes)` : "";
      doc.text(`• ${r.concepto}: ${fmtKg(r.total_egreso_kg)} kg / $${fmtArs(r.total_egreso_ars)}${pct}`, 40, y);
      y += 14;
    });

    doc.end();
  } catch (err) {
    console.error("Error PDF mensual:", err);
    res.status(500).json({ error: "Error" });
  }
});

// ── ENVIAR INFORME MANUAL (para testing y envíos forzados) ────────────────────
app.post("/api/enviar-informe", async (req, res) => {
  const anio = parseInt(req.body.anio) || new Date().getFullYear();
  const mes = parseInt(req.body.mes) || new Date().getMonth() + 1;
  if (mes < 1 || mes > 12) return res.status(400).json({ error: "Mes inválido" });
  await enviarInformeMensualWhatsApp(anio, mes);
  res.json({
    ok: true,
    mensaje: `Informe ${mes}/${anio} enviado a ${NUMEROS_ADMIN.length} admin(s)`,
    admins: NUMEROS_ADMIN
  });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "VIDELA Bot activo 🟢", version: "1.0", base: "kg carne (MAG)" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VIDELA Bot v1.0 corriendo en puerto ${PORT}`);
  scheduleScrapingMAG();
  scheduleInformeMensual();
  // Pre-cargar precio MAG actual al arrancar
  getPrecioReferencia(new Date().toISOString().slice(0, 10))
    .then(r => r && console.log(`💰 Precio MAG cargado: ${r.semana} = $${r.precio.toFixed(2)} ARS/kg`))
    .catch(e => console.error("Error pre-carga MAG:", e.message));
});

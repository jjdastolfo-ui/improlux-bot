// ─────────────────────────────────────────────────────────────────────────────
// EVENTOS DEL CAMPO
//
// Lo que le pasa al campo, no a un animal: lluvias, heladas, trabajos, visitas,
// un alambre cortado. Las notas colgaban de un RP, así que "llovió 40 mm" no
// tenía dónde ir y el bot contestaba que no tenía acceso.
//
// Escribe en diario_campo, la tabla que ya existe y que el tablero ya muestra.
// No se crea una tabla nueva a propósito: si el bot anotara en otro lado, la
// lluvia del tablero y la lluvia del bot serían dos números distintos.
//
// El trabajo de este módulo es entender la frase (qué pasó y cuántos mm) y
// llevar la cuenta de la lluvia, que es el único dato que se acumula.
// ─────────────────────────────────────────────────────────────────────────────

const TIPOS = {
  LLUVIA:   { unidad: "mm", acumula: true,  titulo: "Lluvia" },
  HELADA:   { unidad: null, acumula: false, titulo: "Helada" },
  GRANIZO:  { unidad: "mm", acumula: false, titulo: "Granizo" },
  VIENTO:   { unidad: null, acumula: false, titulo: "Viento" },
  SECA:     { unidad: null, acumula: false, titulo: "Seca" },
  TRABAJO:  { unidad: null, acumula: false, titulo: "Trabajo" },
  PASTURA:  { unidad: null, acumula: false, titulo: "Pastura" },
  SANIDAD:  { unidad: null, acumula: false, titulo: "Sanidad" },
  VISITA:   { unidad: null, acumula: false, titulo: "Visita" },
  PROBLEMA: { unidad: null, acumula: false, titulo: "Problema" },
  // El que ya usaba el diario para todo lo demás. Se mantiene para no partir
  // en dos lo que el tablero viene mostrando.
  ACONTECIMIENTO: { unidad: null, acumula: false, titulo: "Acontecimiento" }
};

// Se compara sin tildes y en minúscula: en el campo nadie escribe "llovió" con
// acento, y \b no funciona contra letras acentuadas.
const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Cómo se dice cada cosa en el campo. Son prefijos, no palabras completas, así
// que "sembr" agarra sembramos y sembrado. El orden manda: gana la primera que
// coincide, por eso el granizo va antes que la lluvia (viene con milímetros).
const SENALES = [
  { re: /graniz|piedra/,                                             tipo: "GRANIZO" },
  { re: /helo|hela|escarcha|bajo cero|frio fuerte/,                  tipo: "HELADA" },
  { re: /seca|sequia|sin agua|no llueve|no llovio/,                  tipo: "SECA" },
  { re: /llovi|lluvia|precipit|cayeron|cayo agua|milimetr|\d+\s?mm/, tipo: "LLUVIA" },
  { re: /viento|tormenta|temporal|vendaval/,                         tipo: "VIENTO" },
  { re: /vacun|desparasit|antiparasit|dosific|sanitari|veterinari|aftosa|garrapat|brucel/, tipo: "SANIDAD" },
  { re: /se corto|rompi|roto|problema|se escap|salieron|entraron|robo|cuatrer|muerto|murio/, tipo: "PROBLEMA" },
  { re: /visit|inspec|dicose|mgap|senasa|tecnico|asesor|vino el/,    tipo: "VISITA" },
  { re: /arregl|repar|limpi|desmalez|trabaj|hicimos|terminamos|pasamos/, tipo: "TRABAJO" },
  { re: /sembr|pastura|verdeo|fertiliz|pastorea|rotacion|rotamos|lote|alambr|aguada|tajamar|molino|potrero|racion|suplement/, tipo: "PASTURA" }
];

// Los milímetros vienen de muchas formas: "40mm", "40 mm", "llovió 40",
// "cayeron 15,5". Se toma el primer número que tenga sentido como lluvia.
function leerMm(texto) {
  const t = norm(texto);
  const conUnidad = t.match(/(\d+(?:[.,]\d+)?)\s*(?:mm|milimetros?)/);
  if (conUnidad) return parseFloat(conUnidad[1].replace(",", "."));
  // Sin unidad: sólo vale si la frase habla de lluvia y el número es plausible.
  if (!/llovi|lluvia|cayer|cayo|precipit|graniz/.test(t)) return null;
  const suelto = t.match(/\b(\d+(?:[.,]\d+)?)\b/);
  if (!suelto) return null;
  const n = parseFloat(suelto[1].replace(",", "."));
  return (n > 0 && n <= 500) ? n : null;
}

/** Qué entiende de una frase suelta. No escribe nada. */
function interpretar(texto) {
  const t = norm(texto);
  const hallada = SENALES.find(s => s.re.test(t));
  const tipo = hallada ? hallada.tipo : "ACONTECIMIENTO";
  const valor = tipo === "LLUVIA" || tipo === "GRANIZO" ? leerMm(texto) : null;
  return { tipo, valor, unidad: TIPOS[tipo].unidad };
}

/** Crea diario_campo si el sistema todavía no la tiene. Idempotente. */
function init(db, campoPorDefecto) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS diario_campo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campo TEXT DEFAULT '${String(campoPorDefecto || "").replace(/'/g, "")}',
      fecha TEXT NOT NULL,
      tipo TEXT DEFAULT 'ACONTECIMIENTO',
      mm REAL,
      titulo TEXT,
      detalle TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_diario_fecha ON diario_campo(fecha DESC);
    CREATE INDEX IF NOT EXISTS idx_diario_tipo ON diario_campo(tipo, fecha DESC);
  `);
}

const hoyISO = () => new Date().toISOString().slice(0, 10);

/** Anota lo que pasó. El tipo y los milímetros salen del texto si no vienen. */
function registrar(db, texto, opciones = {}) {
  const t = String(texto || "").trim();
  if (!t) return { ok: false, error: "No hay nada que anotar" };

  const leido = interpretar(t);
  const tipo = String(opciones.tipo || leido.tipo).toUpperCase();
  if (!TIPOS[tipo]) return { ok: false, error: `No conozco el tipo "${tipo}". Hay: ${Object.keys(TIPOS).join(", ")}` };
  const mm = opciones.mm != null ? parseFloat(opciones.mm)
           : opciones.valor != null ? parseFloat(opciones.valor)
           : leido.valor;
  const fecha = opciones.fecha || hoyISO();
  const campo = (opciones.campo || "").toUpperCase() || null;

  // Dos veces la misma lluvia el mismo día suele ser un reenvío, no dos lluvias.
  if (tipo === "LLUVIA" && mm != null && !opciones.forzar) {
    const repe = db.prepare(`SELECT id FROM diario_campo
      WHERE fecha=? AND tipo='LLUVIA' AND mm=? ${campo ? "AND campo=?" : ""}`)
      .get(...(campo ? [fecha, mm, campo] : [fecha, mm]));
    if (repe) {
      return { ok: false, repetido: true,
        error: `Ya hay ${mm} mm anotados el ${fecha}. Si llovió otra vez, decímelo y lo agrego igual.` };
    }
  }

  const titulo = opciones.titulo || (opciones.lugar ? `${TIPOS[tipo].titulo} · ${opciones.lugar}` : TIPOS[tipo].titulo);
  const info = db.prepare(`INSERT INTO diario_campo (campo,fecha,tipo,mm,titulo,detalle)
    VALUES (?,?,?,?,?,?)`).run(campo, fecha, tipo, mm, titulo, t);

  let mensaje = `📌 Anoté: ${titulo} · ${fecha}`;
  if (tipo === "LLUVIA" && mm != null) {
    const mes = acumulado(db, fecha.slice(0, 7), campo);
    mensaje = `🌧️ ${mm} mm el ${fecha}. Van ${mes.mm} mm en el mes.`;
  }
  return { ok: true, id: info.lastInsertRowid, tipo, mm, fecha, campo, mensaje };
}

/** Lo que llovió en un período: "2026-10" para el mes, "2026" para el año. */
function acumulado(db, periodo, campo) {
  const p = String(periodo || hoyISO().slice(0, 7));
  try {
    const r = db.prepare(`SELECT COUNT(*) dias, ROUND(SUM(mm),1) mm, MAX(mm) mayor,
      MIN(fecha) desde, MAX(fecha) hasta
      FROM diario_campo WHERE tipo='LLUVIA' AND mm IS NOT NULL AND fecha LIKE ?
      ${campo ? "AND campo=?" : ""}`)
      .get(...(campo ? [`${p}%`, campo] : [`${p}%`]));
    return { periodo: p, dias: r.dias || 0, mm: r.mm || 0, mayor: r.mayor || null,
             desde: r.desde || null, hasta: r.hasta || null };
  } catch (e) { return { periodo: p, dias: 0, mm: 0 }; }
}

/** Lluvia mes a mes, para ver el año de un vistazo. */
function lluviaPorMes(db, anio, campo) {
  const a = String(anio || hoyISO().slice(0, 4));
  try {
    return db.prepare(`SELECT substr(fecha,1,7) mes, COUNT(*) dias, ROUND(SUM(mm),1) mm
      FROM diario_campo WHERE tipo='LLUVIA' AND mm IS NOT NULL AND fecha LIKE ?
      ${campo ? "AND campo=?" : ""}
      GROUP BY mes ORDER BY mes`).all(...(campo ? [`${a}%`, campo] : [`${a}%`]));
  } catch (e) { return []; }
}

function listar(db, opciones = {}) {
  const where = [], params = [];
  if (opciones.tipo)  { where.push("tipo = ?");   params.push(String(opciones.tipo).toUpperCase()); }
  if (opciones.campo) { where.push("campo = ?");  params.push(String(opciones.campo).toUpperCase()); }
  if (opciones.desde) { where.push("fecha >= ?"); params.push(opciones.desde); }
  if (opciones.hasta) { where.push("fecha <= ?"); params.push(opciones.hasta); }
  const sql = `SELECT * FROM diario_campo ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY fecha DESC, id DESC LIMIT ?`;
  try { return db.prepare(sql).all(...params, opciones.limite || 100); }
  catch (e) { return []; }
}

function borrar(db, id) {
  const r = db.prepare("DELETE FROM diario_campo WHERE id=?").run(id);
  return r.changes ? { ok: true, mensaje: `Borré el registro ${id}.` }
                   : { ok: false, error: `No encuentro el registro ${id}` };
}

/** Lo que el campo viene teniendo, para el tablero y para que el bot lo cuente. */
function resumen(db, opciones = {}) {
  const hoy = opciones.hoy || hoyISO();
  const campo = opciones.campo ? String(opciones.campo).toUpperCase() : null;
  const mes = acumulado(db, hoy.slice(0, 7), campo);
  const anio = acumulado(db, hoy.slice(0, 4), campo);
  let ultimaLluvia = null, total = 0, porTipo = [];
  try {
    ultimaLluvia = db.prepare(`SELECT fecha, mm FROM diario_campo
      WHERE tipo='LLUVIA' AND mm IS NOT NULL ${campo ? "AND campo=?" : ""}
      ORDER BY fecha DESC LIMIT 1`).get(...(campo ? [campo] : [])) || null;
    total = db.prepare(`SELECT COUNT(*) n FROM diario_campo ${campo ? "WHERE campo=?" : ""}`)
      .get(...(campo ? [campo] : [])).n;
    porTipo = db.prepare(`SELECT tipo, COUNT(*) n FROM diario_campo
      WHERE fecha >= date(?, '-365 days') ${campo ? "AND campo=?" : ""}
      GROUP BY tipo ORDER BY n DESC`).all(...(campo ? [hoy, campo] : [hoy]));
  } catch (e) {}

  const dias = ultimaLluvia
    ? Math.round((new Date(hoy) - new Date(ultimaLluvia.fecha)) / 86400000) : null;

  return {
    hoy, campo, total,
    lluvia: {
      mes: mes.mm, dias_mes: mes.dias,
      anio: anio.mm, dias_anio: anio.dias,
      ultima: ultimaLluvia ? { fecha: ultimaLluvia.fecha, mm: ultimaLluvia.mm, hace_dias: dias } : null,
      // Sin agua hace mucho es lo primero que uno quiere saber.
      alerta_seca: dias != null && dias > 30 ? `${dias} días sin llover` : null
    },
    por_tipo: porTipo,
    por_mes: lluviaPorMes(db, hoy.slice(0, 4), campo),
    ultimos: listar(db, { limite: 10, campo: campo || undefined })
  };
}

// ── Herramienta para el bot ───────────────────────────────────────────────────
// El bot decide cuándo usarla; acá no hay reglas sobre qué es una consulta y
// qué es un reporte, porque eso lo entiende él leyendo el mensaje.
const TOOL = {
  name: "anotar_evento",
  description: `Anota algo que pasó EN EL CAMPO y no a un animal: lluvia, helada, granizo, viento, seca, trabajos, pasturas, sanidad general, visitas, problemas (alambres, animales afuera).

Usala cuando te cuenten un hecho del campo, por ejemplo "llovió 40 mm", "heló anoche", "sembramos el potrero 3", "se cortó el alambre del fondo", "vino el técnico". Nunca contestes que no tenés dónde guardar esto.

Va a diario_campo, la misma tabla que muestra el tablero. La lluvia se acumula y la respuesta te dice cuánto va en el mes.

NO la uses para preguntas ("¿cuánto llovió este mes?") — eso se responde consultando diario_campo. Tampoco para hechos de un animal (partos, pesadas, tactos), que tienen su propio lugar.`,
  input_schema: {
    type: "object",
    properties: {
      texto:  { type: "string", description: "Lo que pasó, en las palabras del usuario." },
      tipo:   { type: "string", enum: Object.keys(TIPOS),
                description: "Si no lo mandás, se deduce del texto." },
      mm:     { type: "number", description: "Milímetros, sólo para lluvia o granizo." },
      fecha:  { type: "string", description: "YYYY-MM-DD. Si no la mandás, es hoy. Si dicen 'anoche' o 'ayer', calculala." },
      lugar:  { type: "string", description: "Potrero o sector, si lo nombraron." },
      forzar: { type: "boolean", description: "Sólo si ya avisé que esa lluvia estaba anotada y el usuario confirma que llovió de nuevo." }
    },
    required: ["texto"]
  }
};

/** Ejecuta la herramienta. Devuelve el string que va como tool_result. */
function ejecutarTool(db, input, extra = {}) {
  try {
    const r = registrar(db, input?.texto, {
      tipo: input?.tipo, mm: input?.mm, fecha: input?.fecha,
      lugar: input?.lugar, forzar: input?.forzar,
      campo: extra.campo
    });
    return JSON.stringify(r);
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) });
  }
}

// Lo que se le dice al bot para que sepa que esto existe.
// ── Las mismas cosas, como acciones ──────────────────────────────────────────
// La herramienta de arriba sólo la ve el bot del financiero. Como acción entra
// también desde RODEO, que manda acciones por /api/ejecutar-accion.
const MANEJA = ["anotar_evento", "ver_eventos"];

function ejecutarAccion(db, accion = {}, ctx = {}) {
  try {
    switch (String(accion.accion || "")) {
      case "anotar_evento": {
        const r = registrar(db, accion.texto, {
          tipo: accion.tipo, mm: accion.mm, fecha: accion.fecha,
          lugar: accion.lugar, forzar: accion.forzar, campo: ctx.campo
        });
        return r.ok ? r.mensaje : `❌ ${r.error}`;
      }
      case "ver_eventos": {
        const r = resumen(db, { campo: ctx.campo, ...accion });
        const u = r.lluvia.ultima;
        return [
          `🌧️ Lluvia: ${r.lluvia.mes} mm este mes (${r.lluvia.dias_mes} día/s) · ${r.lluvia.anio} mm en el año.`,
          u ? `Última: ${u.mm} mm el ${u.fecha} (hace ${u.hace_dias} días).` : "Todavía no hay lluvias anotadas.",
          r.lluvia.alerta_seca ? `⚠️ ${r.lluvia.alerta_seca}.` : null,
          r.por_mes.length ? `Por mes: ${r.por_mes.map(m => `${m.mes} ${m.mm}mm`).join(" · ")}` : null,
          r.ultimos.length ? "\nÚltimo del diario:\n" + r.ultimos.slice(0, 8).map(x =>
            `  ${x.fecha} ${x.tipo}${x.mm != null ? " " + x.mm + "mm" : ""} · ${x.detalle || x.titulo || ""}`).join("\n") : null
        ].filter(Boolean).join("\n");
      }
      default: return null;   // no es nuestra
    }
  } catch (e) {
    return `❌ Error con el evento: ${String(e.message).slice(0, 180)}`;
  }
}

const ACCIONES = `EVENTOS DEL CAMPO — lo que le pasa al campo y no a un animal. Van al diario del campo, el mismo que muestra el tablero.
{"accion":"anotar_evento","texto":"lo que pasó, en palabras del usuario","tipo":"LLUVIA|HELADA|GRANIZO|VIENTO|SECA|TRABAJO|PASTURA|SANIDAD|VISITA|PROBLEMA|ACONTECIMIENTO","mm":0,"fecha":"YYYY-MM-DD","lugar":"potrero, si lo nombraron"}
// Para "llovió 40 mm", "heló anoche", "sembramos el potrero 3", "se cortó el alambre del fondo". El tipo y los milímetros se deducen del texto si no los mandás. La lluvia se acumula y la respuesta dice cuánto va en el mes.
{"accion":"ver_eventos"}
// Cuánto llovió en el mes y en el año, cuándo fue la última lluvia, y lo último del diario.`;

const INSTRUCCIONES = `EVENTOS DEL CAMPO: lo que le pasa al campo y no a un animal — lluvias, heladas, granizo, viento, seca, trabajos, pasturas, sanidad, visitas, problemas. Se anotan con la herramienta anotar_evento y quedan en diario_campo, la misma tabla que muestra el tablero.

Si te cuentan algo del campo — "llovió 40 mm", "heló anoche", "sembramos el potrero 3", "se cortó el alambre del fondo" — anotalo. No digas que no tenés acceso a eso ni que no manejás datos de lluvia.

Si te PREGUNTAN cuánto llovió, no anotes nada: consultá diario_campo sumando mm donde tipo='LLUVIA'.`;

module.exports = {
  init, registrar, acumulado, lluviaPorMes, listar, borrar, resumen,
  interpretar, leerMm, ejecutarTool, ejecutarAccion, MANEJA, TIPOS, TOOL, ACCIONES, INSTRUCCIONES
};

// ─────────────────────────────────────────────────────────────────────────────
// CARTERA DE CHEQUES DE TERCEROS
//
// Un cheque no es un movimiento, es un instrumento de cobro que circula. Nos
// pagan con él, lo guardamos, y después sale por una de tres puertas:
//
//   DEPÓSITO  el banco lo acredita           → entra plata de verdad
//   ENDOSO    se lo damos a un tercero       → es cobrarlo y pagarlo en el acto
//   RECHAZO   no tenía fondos                → vuelve a ser deuda de quien lo dio
//
// Mientras está en cartera no toca el flujo. Eso es lo que no se podía
// registrar antes: la tabla cheques guardaba que el cheque existía y nada más,
// marcarlo cobrado sólo daba vuelta una bandera y la plata nunca aparecía.
//
// EL ENDOSO ES EL CASO INTERESANTE. No pasa plata por el banco, así que la caja
// tiene que quedar igual, pero el cobro y el pago pasaron los dos. Se registran
// las dos patas con la misma fecha y el mismo monto:
//
//   ingreso  el cobro, con el concepto de lo que cobra (VENTA GANADO, etc.)
//   egreso   el pago, con el concepto de lo que paga
//
// Caja: +monto −monto = 0. Resultado: las dos cosas cuentan.
//
// Si el endoso paga una CUENTA CORRIENTE, el gasto ya se registró cuando se
// cargó la compra. Entonces el egreso va con concepto 'PAGO CUENTA CORRIENTE',
// que el sistema ya excluye de las compras del proveedor, y además se descuenta
// la deuda en cc_movimientos. Así la caja neutraliza y el gasto no se duplica.
//
// Los kg de carne se reconocen al cobrar o al endosar, nunca al recibir: hasta
// que el cheque no se hace efectivo de alguna de las dos formas, esa venta no
// se cobró.
//
// La moneda es la del sistema que lo hospeda: USD en Improlux y Amakaik, ARS en
// Videla. Acá no se convierte nada.
// ─────────────────────────────────────────────────────────────────────────────

const ESTADOS = {
  EN_CARTERA: "en cartera",
  DEPOSITADO: "depositado",
  COBRADO:    "cobrado",
  ENDOSADO:   "endosado",
  RECHAZADO:  "rechazado"
};

// La tabla venía con estado 'PENDIENTE' por defecto. Es lo mismo que estar en
// cartera, así que se lo trata igual en vez de migrar filas viejas.
const EN_CARTERA = "('EN_CARTERA','PENDIENTE')";

const hoyISO = () => new Date().toISOString().slice(0, 10);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fmt = n => (Math.round((n || 0) * 100) / 100).toLocaleString("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Agrega a la tabla cheques lo que le falta para ser una cartera.
 * Van como ALTER sueltos a propósito: una columna agregada al CREATE TABLE
 * IF NOT EXISTS no aparece nunca en una base que ya existe.
 */
function init(db) {
  const columnas = [
    ["numero",               "TEXT"],     // número de cheque o echeq
    ["es_electronico",       "INTEGER DEFAULT 0"],
    ["librador",             "TEXT"],     // quién lo emitió
    ["recibido_de",          "TEXT"],     // quién nos lo dio
    ["entregado_a",          "TEXT"],     // a quién lo endosamos
    ["fecha_recepcion",      "TEXT"],
    ["fecha_endoso",         "TEXT"],
    ["fecha_acreditacion",   "TEXT"],
    ["kg_carne",             "REAL"],     // se reconocen al cobrar o endosar
    ["concepto_cobro",       "TEXT"],     // qué cobra este cheque
    ["concepto_pago",        "TEXT"],     // qué pagó al endosarse
    ["moneda",               "TEXT"],
    ["transaccion_cobro_id", "INTEGER"],  // el ingreso que generó
    ["transaccion_pago_id",  "INTEGER"],  // el egreso que generó al endosarse
    ["cc_movimiento_id",     "INTEGER"],  // la deuda que descontó
    ["motivo_rechazo",       "TEXT"],
    ["notas",                "TEXT"]
  ];
  for (const [col, tipo] of columnas) {
    try { db.exec(`ALTER TABLE cheques ADD COLUMN ${col} ${tipo}`); } catch (e) {}
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cheques_estado ON cheques(estado, fecha_cobro);
             CREATE INDEX IF NOT EXISTS idx_cheques_numero ON cheques(numero);`);
  } catch (e) {}
}

// ── Lo que el sistema anfitrión nos presta ────────────────────────────────────
// Cada financiero tiene su moneda y su manera de nombrar las cosas; el módulo
// no asume ninguna.
function ctxDe(ctx = {}) {
  return {
    moneda: ctx.moneda || "USD",
    fuente: ctx.fuente || "whatsapp",
    concepto_venta: ctx.concepto_venta || "VENTA GANADO",
    concepto_pago_cc: ctx.concepto_pago_cc || "PAGO CUENTA CORRIENTE",
    // Sólo en VIDELA: el precio MAG de la semana, para el gemelo en kg.
    precio_mag: ctx.precio_mag > 0 ? Number(ctx.precio_mag) : null,
    semana_mag: ctx.semana_mag || null
  };
}

const enKg = (monto, p) => p ? ` · ${(Math.round((monto / p) * 10) / 10).toLocaleString("es-UY")} kg` : "";

// VIDELA no lleva la plata en pesos: lleva kg de carne, y los pesos son la
// referencia. Cada monto tiene su gemelo en kg al precio MAG de la semana. No
// se puede dar por sentado el esquema: se le pregunta a la tabla qué columnas
// tiene, y si están las de kg se llenan. Un cero en kg ahí no es un dato que
// falta, es un número mal.
const _esquema = new WeakMap();
function tieneCol(db, tabla, col) {
  let m = _esquema.get(db);
  if (!m) { m = new Map(); _esquema.set(db, m); }
  if (!m.has(tabla)) {
    let cols = [];
    try { cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map(c => c.name); } catch (e) {}
    m.set(tabla, new Set(cols));
  }
  return m.get(tabla).has(col);
}
/** ¿Este sistema lleva los montos también en kg de carne? */
const llevaKg = db => tieneCol(db, "transacciones", "ingreso_kg");

/** Si lleva kg y no nos pasaron el precio, no se escribe nada. */
function faltaPrecio(db, ctx) {
  if (!llevaKg(db) || ctx.precio_mag > 0) return null;
  return "Este sistema lleva los montos en kg de carne y no tengo el precio MAG de la semana. Sin eso, el movimiento quedaría en 0 kg y los informes en kilos saldrían mal.";
}

function insertarTransaccion(db, t) {
  const ing = t.ingreso || 0, egr = t.egreso || 0;
  if (llevaKg(db)) {
    const p = t.precio_mag;
    const r = db.prepare(`INSERT INTO transacciones
      (fecha, concepto, detalle, ingreso, egreso, ingreso_kg, egreso_kg, precio_mag, semana_mag, proveedor, es_cc, tc, fuente)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?)`)
      .run(t.fecha, t.concepto, t.detalle || "", ing, egr,
        p ? ing / p : 0, p ? egr / p : 0, p || null, t.semana_mag || null,
        t.proveedor || "", t.fuente);
    return r.lastInsertRowid;
  }
  const r = db.prepare(`INSERT INTO transacciones
    (fecha, concepto, detalle, ingreso, egreso, proveedor, es_cc, tc, fuente)
    VALUES (?,?,?,?,?,?,0,0,?)`)
    .run(t.fecha, t.concepto, t.detalle || "", ing, egr, t.proveedor || "", t.fuente);
  return r.lastInsertRowid;
}

/** Busca un cheque por número, por quién lo dio, o por monto. */
function buscar(db, texto) {
  const t = String(texto || "").trim();
  if (!t) return [];
  const comoNumero = num(t);
  try {
    return db.prepare(`SELECT * FROM cheques
      WHERE numero = ? OR numero LIKE ?
         OR LOWER(recibido_de) LIKE LOWER(?) OR LOWER(librador) LIKE LOWER(?)
         OR LOWER(proveedor) LIKE LOWER(?)
         OR (? IS NOT NULL AND monto = ?)
      ORDER BY CASE WHEN estado IN ${EN_CARTERA} THEN 0 ELSE 1 END, fecha_cobro
      LIMIT 20`)
      .all(t, `%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`, comoNumero, comoNumero);
  } catch (e) { return []; }
}

/** Un cheque concreto: por id, o por lo que se dijo de él. */
function encontrarUno(db, ref) {
  if (ref == null || ref === "") return { error: "No me dijiste cuál cheque." };
  const porId = num(ref);
  if (porId != null && String(ref).match(/^\d+$/) && String(ref).length <= 6) {
    const c = db.prepare("SELECT * FROM cheques WHERE id = ?").get(porId);
    if (c) return { cheque: c };
  }
  const hallados = buscar(db, ref);
  if (!hallados.length) return { error: `No encuentro ningún cheque que coincida con "${ref}".` };
  if (hallados.length > 1) {
    const enCartera = hallados.filter(c => ["EN_CARTERA", "PENDIENTE"].includes(c.estado));
    if (enCartera.length === 1) return { cheque: enCartera[0] };
    return { error: `Hay ${hallados.length} cheques que coinciden con "${ref}":\n` +
      hallados.slice(0, 6).map(c => `  #${c.id} · ${c.numero || "sin número"} · ${fmt(c.monto)} · ${c.recibido_de || c.proveedor || "?"} · ${ESTADOS[c.estado] || c.estado}`).join("\n") +
      `\nDecime el número de cheque o el id.` };
  }
  return { cheque: hallados[0] };
}

// ── 1. ENTRA: nos pagan con un cheque ────────────────────────────────────────
// No toca el flujo. Todavía no se cobró nada.
function recibir(db, datos = {}, ctx = {}) {
  const c = ctxDe(ctx);
  const monto = num(datos.monto);
  if (!monto || monto <= 0) return { ok: false, error: "Falta el monto del cheque." };
  const sinPrecio = faltaPrecio(db, c);
  if (sinPrecio) return { ok: false, error: sinPrecio };

  const fecha = datos.fecha_recepcion || datos.fecha || hoyISO();
  const numero = datos.numero ? String(datos.numero).trim() : null;

  if (numero) {
    const repe = db.prepare(`SELECT id, estado FROM cheques WHERE numero = ?`).get(numero);
    if (repe && !datos.forzar) {
      return { ok: false, repetido: true,
        error: `El cheque ${numero} ya está cargado (#${repe.id}, ${ESTADOS[repe.estado] || repe.estado}). Si es otro distinto, decímelo y lo agrego igual.` };
    }
  }

  const r = db.prepare(`INSERT INTO cheques
    (fecha_emision, fecha_cobro, tipo, proveedor, monto, estado, banco, concepto,
     numero, es_electronico, librador, recibido_de, fecha_recepcion, kg_carne,
     concepto_cobro, moneda, notas)
    VALUES (?,?,'RECIBIDO',?,?,'EN_CARTERA',?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      datos.fecha_emision || fecha,
      datos.fecha_cobro || datos.vencimiento || null,
      datos.recibido_de || datos.de || "",
      monto,
      datos.banco || "",
      datos.concepto || datos.concepto_cobro || "",
      numero,
      datos.es_electronico ? 1 : (datos.echeq ? 1 : 0),
      datos.librador || null,
      datos.recibido_de || datos.de || null,
      fecha,
      num(datos.kg_carne),
      datos.concepto_cobro || datos.concepto || c.concepto_venta,
      c.moneda,
      datos.notas || null
    );

  // El gemelo en kg, donde el sistema lo lleva.
  if (c.precio_mag && tieneCol(db, "cheques", "monto_kg")) {
    try {
      db.prepare(`UPDATE cheques SET monto_kg=?, precio_mag=? WHERE id=?`)
        .run(monto / c.precio_mag, c.precio_mag, r.lastInsertRowid);
    } catch (e) {}
  }

  const vto = datos.fecha_cobro || datos.vencimiento;
  const total = cartera(db).total;
  return {
    ok: true, id: r.lastInsertRowid, monto, numero,
    mensaje: [
      `📥 Cheque en cartera · #${r.lastInsertRowid}`,
      `${datos.es_electronico || datos.echeq ? "e-cheq" : "Cheque"}${numero ? " " + numero : ""} · ${fmt(monto)} ${c.moneda}${enKg(monto, c.precio_mag)}`,
      datos.recibido_de || datos.de ? `De: ${datos.recibido_de || datos.de}` : null,
      vto ? `Vence: ${vto}` : "Sin fecha de vencimiento",
      num(datos.kg_carne) ? `${fmt(num(datos.kg_carne))} kg de carne, se reconocen al cobrarlo` : null,
      `Todavía no mueve el flujo. En cartera hay ${fmt(total)} ${c.moneda}.`
    ].filter(Boolean).join("\n")
  };
}

// ── 2. SALE POR EL BANCO: se acredita ────────────────────────────────────────
// Acá sí entra plata.
function cobrar(db, ref, datos = {}, ctx = {}) {
  const c = ctxDe(ctx);
  const { cheque, error } = encontrarUno(db, ref);
  if (error) return { ok: false, error };
  if (!["EN_CARTERA", "PENDIENTE"].includes(cheque.estado)) {
    return { ok: false, error: `El cheque #${cheque.id} ya está ${ESTADOS[cheque.estado] || cheque.estado}.` };
  }
  const sinPrecio = faltaPrecio(db, c);
  if (sinPrecio) return { ok: false, error: sinPrecio };

  const fecha = datos.fecha || hoyISO();
  const concepto = datos.concepto || cheque.concepto_cobro || c.concepto_venta;
  const quien = cheque.recibido_de || cheque.proveedor || "";
  const detalle = [
    `Cobro de cheque${cheque.numero ? " " + cheque.numero : ""}`,
    quien ? `de ${quien}` : null,
    cheque.concepto ? `· ${cheque.concepto}` : null
  ].filter(Boolean).join(" ");

  const idIngreso = insertarTransaccion(db, {
    fecha, concepto, detalle, ingreso: cheque.monto, egreso: 0,
    proveedor: quien, fuente: c.fuente,
    precio_mag: c.precio_mag, semana_mag: c.semana_mag
  });

  db.prepare(`UPDATE cheques SET estado='COBRADO', fecha_acreditacion=?,
    transaccion_cobro_id=? WHERE id=?`).run(fecha, idIngreso, cheque.id);

  return {
    ok: true, id: cheque.id, transaccion_cobro_id: idIngreso, monto: cheque.monto,
    kg_carne: cheque.kg_carne || null,
    mensaje: [
      `✅ Cheque #${cheque.id} cobrado · ${fecha}`,
      `${fmt(cheque.monto)} ${c.moneda}${enKg(cheque.monto, c.precio_mag)} entraron al flujo como ${concepto}.`,
      quien ? `De: ${quien}` : null,
      cheque.kg_carne ? `Se reconocen ${fmt(cheque.kg_carne)} kg de carne.` : null
    ].filter(Boolean).join("\n")
  };
}

// ── 3. SALE POR ENDOSO: se lo damos a un tercero ─────────────────────────────
// Cobrarlo y pagarlo en el mismo acto. Las dos patas, caja en cero.
function endosar(db, ref, datos = {}, ctx = {}) {
  const c = ctxDe(ctx);
  const { cheque, error } = encontrarUno(db, ref);
  if (error) return { ok: false, error };
  if (!["EN_CARTERA", "PENDIENTE"].includes(cheque.estado)) {
    return { ok: false, error: `El cheque #${cheque.id} ya está ${ESTADOS[cheque.estado] || cheque.estado}.` };
  }
  const a = datos.entregado_a || datos.a || datos.proveedor;
  if (!a) return { ok: false, error: "¿A quién se lo endosaste?" };
  const sinPrecio = faltaPrecio(db, c);
  if (sinPrecio) return { ok: false, error: sinPrecio };

  const fecha = datos.fecha || hoyISO();
  const quien = cheque.recibido_de || cheque.proveedor || "";
  const conceptoCobro = datos.concepto_cobro || cheque.concepto_cobro || c.concepto_venta;

  // ¿Paga una cuenta corriente? Entonces el gasto ya se registró con la compra.
  let esCC = datos.es_cuenta_corriente;
  if (esCC == null) {
    try {
      esCC = !!db.prepare("SELECT 1 FROM cuentas_corrientes WHERE LOWER(proveedor)=LOWER(?)").get(a);
    } catch (e) { esCC = false; }
  }
  const conceptoPago = esCC ? c.concepto_pago_cc
    : (datos.concepto_pago || datos.concepto || "VARIOS");

  const refCheque = `cheque${cheque.numero ? " " + cheque.numero : " #" + cheque.id}`;

  // Pata 1: el cobro.
  const idIngreso = insertarTransaccion(db, {
    fecha, concepto: conceptoCobro,
    detalle: `Cobro de ${refCheque}${quien ? ` de ${quien}` : ""} · endosado a ${a}`,
    ingreso: cheque.monto, egreso: 0, proveedor: quien, fuente: c.fuente,
    precio_mag: c.precio_mag, semana_mag: c.semana_mag
  });

  // Pata 2: el pago. Mismo monto, misma fecha: la caja queda igual.
  const idEgreso = insertarTransaccion(db, {
    fecha, concepto: conceptoPago,
    detalle: `Pago a ${a} con ${refCheque}${esCC ? " (cuenta corriente)" : ""}`,
    ingreso: 0, egreso: cheque.monto, proveedor: a, fuente: c.fuente,
    precio_mag: c.precio_mag, semana_mag: c.semana_mag
  });

  // Y si era cuenta corriente, se descuenta la deuda.
  let idCC = null;
  if (esCC) {
    try {
      const conKg = c.precio_mag && tieneCol(db, "cc_movimientos", "monto_kg");
      const rcc = db.prepare(conKg
        ? `INSERT INTO cc_movimientos (fecha, proveedor, monto, monto_kg, medio, notas) VALUES (?,?,?,?,?,?)`
        : `INSERT INTO cc_movimientos (fecha, proveedor, monto, medio, notas) VALUES (?,?,?,?,?)`)
        .run(...(conKg ? [fecha, a, cheque.monto, cheque.monto / c.precio_mag] : [fecha, a, cheque.monto]),
          `${cheque.es_electronico ? "ECHEQ" : "CHEQUE"} DE TERCEROS${cheque.numero ? " " + cheque.numero : ""}`,
          `Endoso de ${refCheque}${quien ? ` recibido de ${quien}` : ""}`);
      idCC = rcc.lastInsertRowid;
    } catch (e) {}
  }

  db.prepare(`UPDATE cheques SET estado='ENDOSADO', entregado_a=?, fecha_endoso=?,
    concepto_pago=?, transaccion_cobro_id=?, transaccion_pago_id=?, cc_movimiento_id=?
    WHERE id=?`).run(a, fecha, conceptoPago, idIngreso, idEgreso, idCC, cheque.id);

  let saldo = null;
  if (esCC) {
    try {
      const compras = db.prepare(`SELECT COALESCE(SUM(egreso),0) t FROM transacciones
        WHERE LOWER(proveedor)=LOWER(?) AND concepto != ?`).get(a, c.concepto_pago_cc).t;
      const pagos = db.prepare(`SELECT COALESCE(SUM(monto),0) t FROM cc_movimientos
        WHERE LOWER(proveedor)=LOWER(?)`).get(a).t;
      saldo = compras - pagos;
    } catch (e) {}
  }

  return {
    ok: true, id: cheque.id, monto: cheque.monto, entregado_a: a,
    transaccion_cobro_id: idIngreso, transaccion_pago_id: idEgreso, cc_movimiento_id: idCC,
    kg_carne: cheque.kg_carne || null,
    mensaje: [
      `🔁 Cheque #${cheque.id} endosado a ${a} · ${fecha}`,
      `${fmt(cheque.monto)} ${c.moneda}${enKg(cheque.monto, c.precio_mag)} — se registró el cobro y el pago en el mismo acto, así que la caja no se mueve.`,
      `  Cobro: ${conceptoCobro}${quien ? ` (${quien})` : ""}`,
      `  Pago:  ${conceptoPago} (${a})`,
      esCC ? `Le descontamos la deuda a ${a}.${saldo != null ? ` Saldo: ${fmt(saldo)} ${c.moneda}` : ""}` : null,
      cheque.kg_carne ? `Se reconocen ${fmt(cheque.kg_carne)} kg de carne.` : null
    ].filter(Boolean).join("\n")
  };
}

// ── 4. REBOTA ────────────────────────────────────────────────────────────────
// Si ya se había cobrado o endosado, hay que deshacer lo que generó.
function rechazar(db, ref, datos = {}, ctx = {}) {
  const c = ctxDe(ctx);
  const { cheque, error } = encontrarUno(db, ref);
  if (error) return { ok: false, error };
  if (cheque.estado === "RECHAZADO") return { ok: false, error: `El cheque #${cheque.id} ya estaba rechazado.` };

  const fecha = datos.fecha || hoyISO();
  const revertidas = [];

  // Las patas que había generado se dan de baja: esa plata nunca existió.
  for (const [campo, etiqueta] of [["transaccion_cobro_id", "cobro"], ["transaccion_pago_id", "pago"]]) {
    if (cheque[campo]) {
      try {
        db.prepare("DELETE FROM transacciones WHERE id=?").run(cheque[campo]);
        revertidas.push(etiqueta);
      } catch (e) {}
    }
  }
  if (cheque.cc_movimiento_id) {
    try {
      db.prepare("DELETE FROM cc_movimientos WHERE id=?").run(cheque.cc_movimiento_id);
      revertidas.push("descuento de cuenta corriente");
    } catch (e) {}
  }

  db.prepare(`UPDATE cheques SET estado='RECHAZADO', motivo_rechazo=?,
    transaccion_cobro_id=NULL, transaccion_pago_id=NULL, cc_movimiento_id=NULL
    WHERE id=?`).run(datos.motivo || datos.motivo_rechazo || null, cheque.id);

  const quien = cheque.recibido_de || cheque.proveedor || "quien lo dio";
  return {
    ok: true, id: cheque.id, revertidas,
    mensaje: [
      `⚠️ Cheque #${cheque.id} rechazado · ${fecha}`,
      `${fmt(cheque.monto)} ${c.moneda}${cheque.numero ? ` · ${cheque.numero}` : ""}`,
      datos.motivo || datos.motivo_rechazo ? `Motivo: ${datos.motivo || datos.motivo_rechazo}` : null,
      revertidas.length ? `Dimos de baja: ${revertidas.join(", ")}.` : null,
      cheque.estado === "ENDOSADO" && cheque.entregado_a
        ? `OJO: estaba endosado a ${cheque.entregado_a}, así que esa deuda volvió a quedar abierta.` : null,
      `${quien} sigue debiendo ese monto.`
    ].filter(Boolean).join("\n")
  };
}

// ── 5. ME EQUIVOQUÉ: VOLVER ATRÁS ────────────────────────────────────────────
// Distinto de rechazar. Rechazar es un hecho: el cheque rebotó, y queda
// anotado. Esto es deshacer una carga mal hecha: el cheque vuelve a cartera
// como si nunca se hubiera movido, y se borra todo lo que había generado.
function deshacer(db, ref, datos = {}, ctx = {}) {
  const c = ctxDe(ctx);
  const { cheque, error } = encontrarUno(db, ref);
  if (error) return { ok: false, error };
  if (["EN_CARTERA", "PENDIENTE"].includes(cheque.estado)) {
    return { ok: false, error: `El cheque #${cheque.id} ya está en cartera: no hay nada que deshacer.` };
  }

  const estaba = ESTADOS[cheque.estado] || cheque.estado;
  const borrado = [];
  for (const [campo, etiqueta] of [["transaccion_cobro_id", "el cobro"], ["transaccion_pago_id", "el pago"]]) {
    if (cheque[campo]) {
      try {
        if (db.prepare("DELETE FROM transacciones WHERE id=?").run(cheque[campo]).changes) borrado.push(etiqueta);
      } catch (e) {}
    }
  }
  if (cheque.cc_movimiento_id) {
    try {
      if (db.prepare("DELETE FROM cc_movimientos WHERE id=?").run(cheque.cc_movimiento_id).changes)
        borrado.push(`el descuento de la cuenta de ${cheque.entregado_a || "el proveedor"}`);
    } catch (e) {}
  }

  db.prepare(`UPDATE cheques SET estado='EN_CARTERA', entregado_a=NULL, fecha_endoso=NULL,
    fecha_acreditacion=NULL, concepto_pago=NULL, motivo_rechazo=NULL,
    transaccion_cobro_id=NULL, transaccion_pago_id=NULL, cc_movimiento_id=NULL
    WHERE id=?`).run(cheque.id);

  return {
    ok: true, id: cheque.id, estaba, borrado,
    mensaje: [
      `↩️ Cheque #${cheque.id} de vuelta en cartera (estaba ${estaba}).`,
      `${fmt(cheque.monto)} ${c.moneda}${cheque.numero ? ` · ${cheque.numero}` : ""}${cheque.recibido_de ? ` · de ${cheque.recibido_de}` : ""}`,
      borrado.length ? `Di de baja ${borrado.length > 1 ? borrado.slice(0, -1).join(", ") + " y " + borrado[borrado.length - 1] : borrado[0]}.`
                     : "No había movimientos que dar de baja.",
      cheque.entregado_a ? `La deuda con ${cheque.entregado_a} volvió a quedar abierta.` : null
    ].filter(Boolean).join("\n")
  };
}

/** Corregir los datos de un cheque. */
function editar(db, ref, datos = {}, ctx = {}) {
  const c = ctxDe(ctx);
  const { cheque, error } = encontrarUno(db, ref);
  if (error) return { ok: false, error };

  // Si ya se movió, sus movimientos quedaron con el monto y la fecha de
  // entonces. Cambiarlos acá los dejaría mintiendo.
  if (!["EN_CARTERA", "PENDIENTE"].includes(cheque.estado)) {
    return { ok: false, error:
      `El cheque #${cheque.id} está ${ESTADOS[cheque.estado] || cheque.estado} y ya generó movimientos. ` +
      `Deshacelo primero y después editalo, si no los asientos quedan con los datos viejos.` };
  }

  const campos = {
    monto: "monto", numero: "numero", banco: "banco", librador: "librador",
    recibido_de: "recibido_de", fecha_cobro: "fecha_cobro", vencimiento: "fecha_cobro",
    fecha_emision: "fecha_emision", kg_carne: "kg_carne", concepto_cobro: "concepto_cobro",
    notas: "notas", es_electronico: "es_electronico"
  };
  const sets = [], params = [], contados = [];
  for (const [entra, col] of Object.entries(campos)) {
    if (datos[entra] === undefined || sets.some(x => x.startsWith(col + "="))) continue;
    let v = datos[entra];
    if (col === "monto" || col === "kg_carne") { v = num(v); if (col === "monto" && !(v > 0)) return { ok: false, error: "El monto tiene que ser mayor a cero." }; }
    if (col === "es_electronico") v = v ? 1 : 0;
    sets.push(`${col}=?`); params.push(v); contados.push(`${col} → ${v}`);
  }
  if (!sets.length) return { ok: false, error: "No me dijiste qué cambiar. Podés cambiar monto, numero, banco, librador, recibido_de, fecha_cobro, kg_carne o notas." };

  // El monto nuevo arrastra los kg, donde el sistema los lleva.
  if (sets.some(x => x.startsWith("monto=")) && c.precio_mag && tieneCol(db, "cheques", "monto_kg")) {
    const nuevo = params[sets.findIndex(x => x.startsWith("monto="))];
    sets.push("monto_kg=?", "precio_mag=?"); params.push(nuevo / c.precio_mag, c.precio_mag);
  }

  db.prepare(`UPDATE cheques SET ${sets.join(", ")} WHERE id=?`).run(...params, cheque.id);
  const ahora = db.prepare("SELECT * FROM cheques WHERE id=?").get(cheque.id);
  return {
    ok: true, id: cheque.id, cambios: contados,
    mensaje: [
      `✏️ Cheque #${cheque.id} corregido.`,
      `${ahora.numero ? ahora.numero + " · " : ""}${fmt(ahora.monto)} ${c.moneda}${enKg(ahora.monto, c.precio_mag)}${ahora.recibido_de ? ` · de ${ahora.recibido_de}` : ""}${ahora.fecha_cobro ? ` · vence ${ahora.fecha_cobro}` : ""}`
    ].join("\n")
  };
}

/** Borrarlo del todo: se cargó por error y no existía. */
function borrarCheque(db, ref, datos = {}, ctx = {}) {
  const c = ctxDe(ctx);
  const { cheque, error } = encontrarUno(db, ref);
  if (error) return { ok: false, error };

  const movido = !["EN_CARTERA", "PENDIENTE"].includes(cheque.estado);
  if (movido && !datos.forzar) {
    return { ok: false, error:
      `El cheque #${cheque.id} está ${ESTADOS[cheque.estado] || cheque.estado}: ya generó movimientos. ` +
      `Si de verdad querés borrarlo con todo lo que generó, decímelo de nuevo y lo hago; si sólo te equivocaste al moverlo, mejor deshacelo.` };
  }
  for (const campo of ["transaccion_cobro_id", "transaccion_pago_id"]) {
    if (cheque[campo]) { try { db.prepare("DELETE FROM transacciones WHERE id=?").run(cheque[campo]); } catch (e) {} }
  }
  if (cheque.cc_movimiento_id) { try { db.prepare("DELETE FROM cc_movimientos WHERE id=?").run(cheque.cc_movimiento_id); } catch (e) {} }
  db.prepare("DELETE FROM cheques WHERE id=?").run(cheque.id);
  return { ok: true, id: cheque.id,
    mensaje: `🗑️ Borré el cheque #${cheque.id}${cheque.numero ? ` (${cheque.numero})` : ""} de ${fmt(cheque.monto)} ${c.moneda}${movido ? ", con los movimientos que había generado" : ""}.` };
}

// ── Lo que tenemos en mano ───────────────────────────────────────────────────
function cartera(db, opciones = {}) {
  const hoy = opciones.hoy || hoyISO();
  let enCartera = [];
  try {
    enCartera = db.prepare(`SELECT * FROM cheques
      WHERE tipo='RECIBIDO' AND estado IN ${EN_CARTERA}
      ORDER BY COALESCE(fecha_cobro, '9999') , id`).all();
  } catch (e) { return { total: 0, cantidad: 0, cheques: [], vencidos: [], proximos: [] }; }

  const total = enCartera.reduce((s, c) => s + (c.monto || 0), 0);
  const vencidos = enCartera.filter(c => c.fecha_cobro && c.fecha_cobro < hoy);
  const proximos = enCartera.filter(c => c.fecha_cobro && c.fecha_cobro >= hoy);
  const sinFecha = enCartera.filter(c => !c.fecha_cobro);

  return {
    hoy, total, cantidad: enCartera.length,
    cheques: enCartera, vencidos, proximos, sinFecha,
    total_vencido: vencidos.reduce((s, c) => s + (c.monto || 0), 0),
    kg_carne_pendiente: enCartera.reduce((s, c) => s + (c.kg_carne || 0), 0)
  };
}

/** Para el tablero y para que el bot sepa de entrada qué hay. */
function resumen(db, opciones = {}) {
  const c = ctxDe(opciones);
  const cart = cartera(db, opciones);
  let movidos = [];
  try {
    movidos = db.prepare(`SELECT estado, COUNT(*) n, ROUND(SUM(monto),2) monto
      FROM cheques WHERE tipo='RECIBIDO' GROUP BY estado`).all();
  } catch (e) {}
  return { ...cart, moneda: c.moneda, por_estado: movidos };
}

function lineaCheque(ch, moneda) {
  return [
    `#${ch.id}`,
    ch.numero || null,
    `${fmt(ch.monto)} ${moneda}`,
    ch.recibido_de || ch.proveedor || null,
    ch.fecha_cobro ? `vence ${ch.fecha_cobro}` : "sin vencimiento",
    ch.kg_carne ? `${fmt(ch.kg_carne)} kg` : null
  ].filter(Boolean).join(" · ");
}

function textoCartera(db, opciones = {}) {
  const c = ctxDe(opciones);
  const r = cartera(db, opciones);
  if (!r.cantidad) return "No hay cheques en cartera.";
  const partes = [`📁 Cartera: ${r.cantidad} cheque/s por ${fmt(r.total)} ${c.moneda}`];
  if (r.vencidos.length) {
    partes.push(`\n⚠️ Vencidos sin cobrar (${fmt(r.total_vencido)} ${c.moneda}):`);
    r.vencidos.forEach(ch => partes.push("  " + lineaCheque(ch, c.moneda)));
  }
  if (r.proximos.length) {
    partes.push(`\nPor vencer:`);
    r.proximos.slice(0, 15).forEach(ch => partes.push("  " + lineaCheque(ch, c.moneda)));
  }
  if (r.sinFecha.length) {
    partes.push(`\nSin fecha de vencimiento:`);
    r.sinFecha.forEach(ch => partes.push("  " + lineaCheque(ch, c.moneda)));
  }
  if (r.kg_carne_pendiente) partes.push(`\n${fmt(r.kg_carne_pendiente)} kg de carne todavía sin reconocer.`);
  return partes.join("\n");
}

// ── Las acciones, como las espera ejecutarAccion del financiero ──────────────
function ejecutarAccion(db, accion = {}, ctx = {}) {
  const a = String(accion.accion || "");
  const ref = accion.cheque ?? accion.id ?? accion.numero;
  try {
    switch (a) {
      case "recibir_cheque": {
        const r = recibir(db, accion, ctx);
        return r.ok ? r.mensaje : `❌ ${r.error}`;
      }
      case "cobrar_cheque": {
        const r = cobrar(db, ref, accion, ctx);
        return r.ok ? r.mensaje : `❌ ${r.error}`;
      }
      case "endosar_cheque": {
        const r = endosar(db, ref, accion, ctx);
        return r.ok ? r.mensaje : `❌ ${r.error}`;
      }
      case "rechazar_cheque": {
        const r = rechazar(db, ref, accion, ctx);
        return r.ok ? r.mensaje : `❌ ${r.error}`;
      }
      case "deshacer_cheque": {
        const r = deshacer(db, ref, accion, ctx);
        return r.ok ? r.mensaje : `❌ ${r.error}`;
      }
      case "editar_cheque": {
        const r = editar(db, ref, accion, ctx);
        return r.ok ? r.mensaje : `❌ ${r.error}`;
      }
      case "borrar_cheque": {
        const r = borrarCheque(db, ref, accion, ctx);
        return r.ok ? r.mensaje : `❌ ${r.error}`;
      }
      case "ver_cartera":
        return textoCartera(db, { ...ctx, ...accion });
      case "buscar_cheque": {
        const hallados = buscar(db, accion.texto || accion.q || ref);
        if (!hallados.length) return "No encontré ningún cheque con eso.";
        const c = ctxDe(ctx);
        return hallados.map(ch =>
          `#${ch.id} · ${ch.numero || "sin número"} · ${fmt(ch.monto)} ${c.moneda} · ` +
          `${ch.recibido_de || ch.proveedor || "?"} · ${ESTADOS[ch.estado] || ch.estado}` +
          (ch.entregado_a ? ` → ${ch.entregado_a}` : "")
        ).join("\n");
      }
      default:
        return null;   // no es nuestra
    }
  } catch (e) {
    return `❌ Error con el cheque: ${String(e.message).slice(0, 180)}`;
  }
}

const MANEJA = ["recibir_cheque", "cobrar_cheque", "endosar_cheque", "rechazar_cheque",
  "deshacer_cheque", "editar_cheque", "borrar_cheque", "ver_cartera", "buscar_cheque"];

// Lo que se le dice al bot para que las use.
const ACCIONES = `CHEQUES DE TERCEROS — un cheque es un instrumento de cobro que circula, no un movimiento. Mientras está en cartera NO mueve el flujo.
{"accion":"recibir_cheque","monto":0,"recibido_de":"quién nos lo dio","numero":"nro de cheque o echeq","fecha_cobro":"YYYY-MM-DD (vencimiento)","es_electronico":true,"banco":"","librador":"quién lo emitió, si no es el mismo","kg_carne":0,"concepto_cobro":"VENTA GANADO","notas":""}
// Usar cuando nos PAGAN con un cheque. Queda en cartera, no entra al flujo todavía. Ej: "me pagaron con un echeq de 12000 a 60 días de Juan Pérez" → recibir_cheque con monto 12000, recibido_de "Juan Pérez", es_electronico true, y fecha_cobro calculada a 60 días.
// Si es el cobro de una venta de ganado y te dicen los kilos, poné kg_carne: se reconocen cuando el cheque se cobra o se endosa, no ahora.
{"accion":"cobrar_cheque","cheque":"id o número","fecha":"YYYY-MM-DD","concepto":"categoría del ingreso"}
// El banco lo acreditó. ACÁ entra la plata al flujo como ingreso.
{"accion":"endosar_cheque","cheque":"id o número","entregado_a":"a quién","fecha":"YYYY-MM-DD","concepto_pago":"categoría de lo que paga"}
// Se lo dimos a un tercero. Es cobrarlo y pagarlo en el mismo acto: se registran las DOS patas (ingreso + egreso) con la misma fecha y monto, así que la caja no se mueve y las dos cosas cuentan en el resultado.
// Si el que recibe el cheque tiene cuenta corriente, se detecta solo: el egreso va como PAGO CUENTA CORRIENTE (el gasto ya se registró con la compra) y se le descuenta la deuda.
{"accion":"rechazar_cheque","cheque":"id o número","motivo":"sin fondos"}
// Rebotó DE VERDAD, en el banco. Queda anotado como rechazado y quien lo dio vuelve a deber. No la uses para corregir una carga mal hecha.
{"accion":"deshacer_cheque","cheque":"id o número"}
// ME EQUIVOQUÉ: vuelve el cheque a cartera como si nunca se hubiera movido, y da de baja el cobro, el pago y el descuento de cuenta corriente que había generado. Es lo que se usa cuando lo cobraste o endosaste por error, o se lo adjudicaste a quien no era. Sirve también para sacar un cheque de rechazado.
{"accion":"editar_cheque","cheque":"id o número","monto":0,"numero":"","recibido_de":"","fecha_cobro":"YYYY-MM-DD","banco":"","librador":"","kg_carne":0,"notas":""}
// Corrige los datos. Mandá sólo los campos que cambian. Si el cheque ya se movió hay que deshacerlo primero: si no, los asientos que generó quedarían con el monto viejo.
{"accion":"borrar_cheque","cheque":"id o número","forzar":true}
// El cheque no existía, se cargó por error. Si ya se había movido pide confirmación antes de borrarlo con todo lo que generó. Si sólo te equivocaste al moverlo, deshacé en vez de borrar.
{"accion":"ver_cartera"}
// Qué cheques tenemos en mano, qué vence y qué está vencido sin cobrar.
{"accion":"buscar_cheque","texto":"número, persona o monto"}
// Para encontrar un cheque cuando no te dan el id.`;

const INSTRUCCIONES = `CHEQUES DE TERCEROS: cobramos con cheques y echeqs, y después usamos esos mismos cheques para pagar. El cheque es un instrumento de cobro, no un movimiento.

Mientras está en cartera no mueve el flujo. El flujo se mueve de dos maneras: cuando el banco lo acredita (cobrar_cheque), o cuando lo endosamos a un tercero (endosar_cheque) — endosar es cobrarlo y pagarlo en el mismo acto, así que se registran las dos patas y la caja queda igual.

Los kg de carne de una venta se reconocen cuando el cheque se cobra o se endosa, nunca cuando entra a cartera.

Si no sabés qué cheque es, buscalo con buscar_cheque o ver_cartera antes de preguntar.`;

module.exports = {
  init, recibir, cobrar, endosar, rechazar, deshacer, editar, borrarCheque,
  cartera, resumen, buscar, encontrarUno,
  textoCartera, ejecutarAccion, MANEJA, ACCIONES, INSTRUCCIONES, ESTADOS
};

// ============================================================================
// A3 · Flujos de Node-RED del VPS (ingesta, estado y alertas) como código.
// instalar_flujos.js los mezcla en /data/flows.json: reemplaza solo los nodos con
// id "a3...", así que se puede reinstalar sin tocar otros flujos.
// Credenciales: MQTT en flows_cred.json (cifrado con credentialSecret); PostgreSQL y
// CallMeBot por variables de entorno del contenedor (PG_USER, PG_PASS, CALLMEBOT_*).
// ============================================================================

const T_INGESTA = "a3tab_ingesta";
const T_ALERTAS = "a3tab_alertas";
const BROKER = "a3cfg_mqtt";
const PG = "a3cfg_pg";

const fn = (id, z, name, code, x, y, wires, outputs = 1) =>
  ({ id, type: "function", z, name, func: code.trim(), outputs, timeout: 0, noerr: 0,
     initialize: "", finalize: "", libs: [], x, y, wires });
const pg = (id, z, name, query, x, y, wires = [[]]) =>
  ({ id, type: "postgresql", z, name, query: query.trim(), postgreSQLConfig: PG, split: false,
     rowsPerMsg: 1, outputs: 1, x, y, wires });
const mqttIn = (id, z, name, topic, x, y, wires) =>
  ({ id, type: "mqtt in", z, name, topic, qos: "1", datatype: "json", broker: BROKER, nl: false,
     rap: true, rh: 0, inputs: 0, x, y, wires });
const comentario = (id, z, name, info, x, y) => ({ id, type: "comment", z, name, info, x, y, wires: [] });

module.exports = [
  // ------------------------------------------------------------------ Configuración
  { id: BROKER, type: "mqtt-broker", name: "EMQX (red interna)", broker: "emqx", port: "1883",
    clientid: "svc-nodered-vps", autoConnect: true, usetls: false, protocolVersion: "4",
    keepalive: "60", cleansession: false, autoUnsubscribe: true,
    birthTopic: "", closeTopic: "", willTopic: "", userProps: "", sessionExpiry: "" },
  { id: PG, type: "postgreSQLConfig", name: "TimescaleDB (app_nodered)",
    host: "timescaledb", hostFieldType: "str", port: "5432", portFieldType: "num",
    database: "iot_db", databaseFieldType: "str", ssl: "false", sslFieldType: "bool",
    applicationName: "nodered-a3", applicationNameType: "str", max: "5", maxFieldType: "num",
    idle: "1000", idleFieldType: "num", connectionTimeout: "10000", connectionTimeoutFieldType: "num",
    user: "PG_USER", userFieldType: "env", password: "PG_PASS", passwordFieldType: "env" },

  // ------------------------------------------------------------------ Pestaña: ingesta
  { id: T_INGESTA, type: "tab", label: "A3 · Ingesta y estado", disabled: false,
    info: "cafe/+/telemetria -> TimescaleDB (telemetria) y reglas de alerta.\ncafe/+/estado (LWT) -> estado y eventos_estado." },
  comentario("a3c_ing", T_INGESTA, "Telemetría de las marquesinas (vía bridge del fog)", "", 230, 40),
  mqttIn("a3_mq_tel", T_INGESTA, "cafe/+/telemetria", "cafe/+/telemetria", 140, 100, [["a3_fn_val"]]),
  fn("a3_fn_val", T_INGESTA, "validar y preparar", `
// Descarta mensajes mal formados o cuyo id no coincide con el tópico (ACL de contenido).
const p = msg.payload;
const id = msg.topic.split('/')[1];
if (!p || typeof p !== 'object' || p.id !== id || typeof p.ts !== 'number' || p.ts < 1.7e12) {
    node.warn('descartado: ' + msg.topic + ' ' + JSON.stringify(p));
    return null;
}
msg.marquesina = id;
// Rangos físicos del DHT22 (-40..80 °C, 0..100 %); fuera de rango se guarda como nulo.
const enRango = (v, min, max) => (typeof v === 'number' && v >= min && v <= max) ? v : null;
p.temp = enRango(p.temp, -40, 80);
p.hr = enRango(p.hr, 0, 100);
if (p.temp === 0 && p.hr === 0) { p.temp = null; p.hr = null; }
const ts = new Date(p.ts).toISOString();
msg.params = [ts, id, p.seq ?? null, p.temp ?? null, p.hr ?? null, p.lux ?? null,
              p.co ?? null, p.rssi ?? null, p.m ?? null];
const ultimo = { params: [id, ts] };
return [msg, ultimo, { marquesina: id, payload: p }];`, 360, 100, [["a3_pg_tel"], ["a3_pg_ult"], ["a3_lo_reg"]], 3),
  pg("a3_pg_tel", T_INGESTA, "INSERT telemetria", `
INSERT INTO telemetria (ts, marquesina, seq, temp, hr, lux, co, rssi, motivo)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT DO NOTHING;`, 600, 60),
  pg("a3_pg_ult", T_INGESTA, "estado.ultimo_dato", `
INSERT INTO estado (marquesina, estado, ultimo_dato) VALUES ($1, 'online', $2)
ON CONFLICT (marquesina) DO UPDATE SET ultimo_dato = GREATEST(estado.ultimo_dato, EXCLUDED.ultimo_dato);`, 610, 100),
  { id: "a3_lo_reg", type: "link out", z: T_INGESTA, name: "a reglas", mode: "link", links: ["a3_li_reg"], x: 575, y: 140, wires: [] },

  comentario("a3c_est", T_INGESTA, "Estado online/offline (LWT retenido)", "", 200, 220),
  mqttIn("a3_mq_est", T_INGESTA, "cafe/+/estado", "cafe/+/estado", 130, 280, [["a3_fn_est"]]),
  fn("a3_fn_est", T_INGESTA, "estado y cambios", `
const id = msg.topic.split('/')[1];
const p = msg.payload || {};
const estado = p.estado === 'online' ? 'online' : 'offline';
const { id: _i, estado: _e, ...info } = p;
const upsert = { params: [id, estado, Object.keys(info).length ? JSON.stringify(info) : null] };
// Solo los cambios generan evento (los retenidos se repiten al reconectar)
const anterior = context.get(id);
context.set(id, estado);
if (anterior === estado) return [upsert, null, null];
const evento = { params: [id, estado] };
const alerta = (estado === 'offline' && anterior !== undefined)
    ? { marquesina: id, alerta: { tipo: 'offline', valor: null, umbral: null,
        txt: 'se desconectó (última voluntad MQTT)' } }
    : null;
return [upsert, evento, alerta];`, 340, 280, [["a3_pg_est"], ["a3_pg_evt"], ["a3_lo_reg2"]], 3),
  pg("a3_pg_est", T_INGESTA, "UPSERT estado", `
INSERT INTO estado (marquesina, estado, desde, info, actualizado) VALUES ($1, $2, now(), $3::jsonb, now())
ON CONFLICT (marquesina) DO UPDATE SET
  desde = CASE WHEN estado.estado <> EXCLUDED.estado THEN now() ELSE estado.desde END,
  estado = EXCLUDED.estado, info = COALESCE(EXCLUDED.info, estado.info), actualizado = now();`, 570, 240),
  pg("a3_pg_evt", T_INGESTA, "INSERT eventos_estado", `
INSERT INTO eventos_estado (marquesina, estado) VALUES ($1, $2);`, 580, 280),
  { id: "a3_lo_reg2", type: "link out", z: T_INGESTA, name: "a antirebote", mode: "link", links: ["a3_li_ant"], x: 555, y: 320, wires: [] },

  // ------------------------------------------------------------------ Pestaña: alertas
  { id: T_ALERTAS, type: "tab", label: "A3 · Alertas", disabled: false,
    info: "Reglas con la tabla umbrales (editable desde el panel), antirebote, WhatsApp (CallMeBot), cafe/alertas y tabla alertas." },
  comentario("a3c_umb", T_ALERTAS, "Umbrales: se recargan cada minuto desde la tabla umbrales", "", 270, 40),
  { id: "a3_in_umb", type: "inject", z: T_ALERTAS, name: "cada 60 s", props: [], repeat: "60", crontab: "",
    once: true, onceDelay: "5", topic: "", x: 120, y: 80, wires: [["a3_pg_umb"]] },
  pg("a3_pg_umb", T_ALERTAS, "SELECT umbrales", `SELECT * FROM umbrales;`, 300, 80, [["a3_fn_umb"]]),
  fn("a3_fn_umb", T_ALERTAS, "guardar en flow", `
flow.set('umbrales', msg.payload || []);
node.status({ text: (msg.payload || []).length + ' filas · ' + new Date().toLocaleTimeString('es-CO') });
return null;`, 490, 80, [[]], 1),

  comentario("a3c_reg", T_ALERTAS, "Reglas por lectura", "", 150, 140),
  { id: "a3_li_reg", type: "link in", z: T_ALERTAS, name: "reglas", links: ["a3_lo_reg"], x: 75, y: 180, wires: [["a3_fn_reg"]] },
  fn("a3_fn_reg", T_ALERTAS, "evaluar umbrales", `
const filas = flow.get('umbrales') || [];
const id = msg.marquesina, p = msg.payload;
const base = filas.find(r => r.marquesina === '*') || {};
const r = Object.assign({}, base, filas.find(f => f.marquesina === id) || {});
const salida = [];
const regla = (cond, tipo, valor, umbral, txt) => {
    if (cond) salida.push({ marquesina: id, antirebote: r.antirebote_min, alerta: { tipo, valor, umbral, txt } });
};
if (p.temp != null && r.temp_max != null)
    regla(p.temp > r.temp_max, 'temp_alta', p.temp, r.temp_max, 'temperatura ' + p.temp + ' °C > ' + r.temp_max + ' °C (riesgo de sobresecado)');
if (p.temp != null && r.temp_min != null)
    regla(p.temp < r.temp_min, 'temp_baja', p.temp, r.temp_min, 'temperatura ' + p.temp + ' °C < ' + r.temp_min + ' °C');
const deDia = !r.hr_solo_dia || (p.lux ?? 0) >= r.lux_dia;
if (p.hr != null && r.hr_max != null && deDia)
    regla(p.hr > r.hr_max, 'hr_alta', p.hr, r.hr_max, 'humedad ' + p.hr + ' % > ' + r.hr_max + ' % (secado lento, riesgo de hongos)');
if (p.co != null && r.co_max != null)
    regla(p.co > r.co_max, 'co_alto', p.co, r.co_max, 'CO ' + p.co + ' ppm > ' + r.co_max + ' ppm');
return [salida];`, 260, 180, [["a3_fn_ant"]], 1),

  comentario("a3c_off", T_ALERTAS, "Sin datos: revisa estado.ultimo_dato cada minuto", "", 240, 240),
  { id: "a3_in_off", type: "inject", z: T_ALERTAS, name: "cada 60 s", props: [], repeat: "60", crontab: "",
    once: true, onceDelay: "30", topic: "", x: 120, y: 280, wires: [["a3_pg_off"]] },
  pg("a3_pg_off", T_ALERTAS, "marquesinas sin datos", `
SELECT e.marquesina, round(EXTRACT(EPOCH FROM now() - e.ultimo_dato) / 60) AS minutos,
       COALESCE(u.offline_min, d.offline_min) AS limite, COALESCE(u.antirebote_min, d.antirebote_min) AS antirebote
FROM estado e
LEFT JOIN umbrales u ON u.marquesina = e.marquesina
CROSS JOIN (SELECT offline_min, antirebote_min FROM umbrales WHERE marquesina = '*') d
WHERE e.ultimo_dato < now() - make_interval(mins => COALESCE(u.offline_min, d.offline_min));`, 310, 280, [["a3_fn_off"]]),
  fn("a3_fn_off", T_ALERTAS, "a alertas", `
return [(msg.payload || []).map(f => ({ marquesina: f.marquesina, antirebote: f.antirebote,
    alerta: { tipo: 'sin_datos', valor: Number(f.minutos), umbral: f.limite,
              txt: 'sin datos hace ' + f.minutos + ' min (límite ' + f.limite + ' min)' } }))];`, 500, 280, [["a3_fn_ant"]], 1),

  comentario("a3c_anom", T_ALERTAS, "Anomalías del servicio Python (puntaje z) -> alerta", "", 250, 600),
  mqttIn("a3_mq_anom", T_ALERTAS, "cafe/+/anomalia", "cafe/+/anomalia", 130, 640, [["a3_fn_anom"]]),
  fn("a3_fn_anom", T_ALERTAS, "a alerta", `
const p = msg.payload || {};
const nombres = { temp: 'temperatura', hr: 'humedad', lux: 'luz', co: 'CO' };
const unidades = { temp: ' °C', hr: ' %', lux: ' lx', co: ' ppm' };
return { marquesina: p.id, alerta: { tipo: 'anomalia_' + p.variable, valor: p.valor, umbral: p.z,
    txt: 'anomalía en ' + (nombres[p.variable] || p.variable) + ': ' + p.valor + (unidades[p.variable] || '') +
         ' (puntaje z ' + p.z + '; lo normal ~' + p.media + (unidades[p.variable] || '') + ')' } };`, 330, 640, [["a3_fn_ant"]], 1),
  comentario("a3c_ant", T_ALERTAS, "Antirebote -> MQTT cafe/alertas + Telegram + WhatsApp + tabla alertas", "", 290, 340),
  { id: "a3_li_ant", type: "link in", z: T_ALERTAS, name: "antirebote", links: ["a3_lo_reg2"], x: 75, y: 380, wires: [["a3_fn_ant"]] },
  fn("a3_fn_ant", T_ALERTAS, "antirebote", `
// Una alerta del mismo tipo y marquesina no se repite dentro de antirebote_min minutos.
const filas = flow.get('umbrales') || [];
const minutos = msg.antirebote ?? (filas.find(r => r.marquesina === '*') || {}).antirebote_min ?? 10;
const clave = msg.marquesina + '|' + msg.alerta.tipo;
const ultimo = context.get(clave) || 0;
if (Date.now() - ultimo < minutos * 60000) return null;
context.set(clave, Date.now());
const hora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
msg.texto = 'Alerta secado de café · ' + msg.marquesina + ': ' + msg.alerta.txt + ' · ' + hora;
node.status({ fill: 'red', shape: 'dot', text: clave + ' ' + hora });
return msg;`, 260, 380, [["a3_fn_mq", "a3_fn_tg"]], 1),
  fn("a3_fn_mq", T_ALERTAS, "JSON cafe/alertas", `
msg.topic = 'cafe/alertas';
msg.payload = { marquesina: msg.marquesina, tipo: msg.alerta.tipo, valor: msg.alerta.valor,
                umbral: msg.alerta.umbral, mensaje: msg.texto, ts: Date.now() };
msg.qos = 1;
return msg;`, 470, 340, [["a3_mq_out"]], 1),
  { id: "a3_mq_out", type: "mqtt out", z: T_ALERTAS, name: "cafe/alertas", topic: "", qos: "1", retain: "false",
    respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker: BROKER, x: 660, y: 340, wires: [] },
  // Canales al celular en cadena: Telegram (bot propio) y luego WhatsApp (CallMeBot).
  // Cada uno es opcional: sin sus variables de entorno se salta y la alerta se guarda igual.
  fn("a3_fn_tg", T_ALERTAS, "¿Telegram configurado?", `
const token = env.get('TELEGRAM_TOKEN'), chat = env.get('TELEGRAM_CHAT_ID');
msg.telegram = false;
if (!token || !chat) { node.status({ fill: 'yellow', shape: 'ring', text: 'sin TELEGRAM_*' }); return [null, msg]; }
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
msg.url = 'https://api.telegram.org/bot' + token + '/sendMessage';
msg.method = 'POST';
msg.headers = { 'content-type': 'application/json' };
msg.payload = { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
    text: '⚠️ <b>Alerta secado de café · ' + esc(msg.marquesina) + '</b>\\n' + esc(msg.alerta.txt) + '\\n🕒 ' + esc(hora) };
return [msg, null];`, 480, 400, [["a3_dl_tg"], ["a3_fn_wa"]], 2),
  { id: "a3_dl_tg", type: "delay", z: T_ALERTAS, name: "máx. 1 por segundo", pauseType: "rate", timeout: "1",
    timeoutUnits: "seconds", rate: "1", nbRateUnits: "1", rateUnits: "second", randomFirst: "1",
    randomLast: "5", randomUnits: "seconds", drop: false, allowrate: false, outputs: 1, x: 690, y: 400, wires: [["a3_http_tg"]] },
  { id: "a3_http_tg", type: "http request", z: T_ALERTAS, name: "Telegram sendMessage", method: "use", ret: "obj",
    paytoqs: "ignore", url: "", tls: "", persist: false, proxy: "", insecureHTTPParser: false,
    authType: "", senderr: false, headers: [], x: 880, y: 400, wires: [["a3_fn_tok"]] },
  fn("a3_fn_tok", T_ALERTAS, "resultado Telegram", `
msg.telegram = msg.statusCode === 200 && msg.payload && msg.payload.ok === true;
node.status({ fill: msg.telegram ? 'green' : 'red', shape: 'dot', text: 'HTTP ' + msg.statusCode });
if (!msg.telegram) node.warn('Telegram respondió ' + msg.statusCode + ': ' + JSON.stringify(msg.payload).slice(0, 200));
delete msg.headers; delete msg.method; delete msg.payload;
return msg;`, 1070, 400, [["a3_fn_wa"]], 1),

  fn("a3_fn_wa", T_ALERTAS, "¿WhatsApp configurado?", `
const tel = env.get('CALLMEBOT_PHONE'), key = env.get('CALLMEBOT_APIKEY');
msg.whatsapp = false;
if (!tel || !key) { node.status({ fill: 'yellow', shape: 'ring', text: 'sin CALLMEBOT_*' }); return [null, msg]; }
msg.url = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(tel) +
          '&text=' + encodeURIComponent(msg.texto) + '&apikey=' + encodeURIComponent(key);
return [msg, null];`, 480, 460, [["a3_dl_wa"], ["a3_fn_ins"]], 2),
  { id: "a3_dl_wa", type: "delay", z: T_ALERTAS, name: "máx. 1 cada 5 s", pauseType: "rate", timeout: "5",
    timeoutUnits: "seconds", rate: "1", nbRateUnits: "5", rateUnits: "second", randomFirst: "1",
    randomLast: "5", randomUnits: "seconds", drop: false, allowrate: false, outputs: 1, x: 690, y: 460, wires: [["a3_http_wa"]] },
  { id: "a3_http_wa", type: "http request", z: T_ALERTAS, name: "CallMeBot", method: "GET", ret: "txt",
    paytoqs: "ignore", url: "", tls: "", persist: false, proxy: "", insecureHTTPParser: false,
    authType: "", senderr: false, headers: [], x: 870, y: 460, wires: [["a3_fn_wok"]] },
  fn("a3_fn_wok", T_ALERTAS, "resultado", `
msg.whatsapp = msg.statusCode === 200;
node.status({ fill: msg.whatsapp ? 'green' : 'red', shape: 'dot', text: 'HTTP ' + msg.statusCode });
if (!msg.whatsapp) node.warn('CallMeBot respondió ' + msg.statusCode + ': ' + String(msg.payload).slice(0, 200));
return msg;`, 1030, 460, [["a3_fn_ins"]], 1),
  fn("a3_fn_ins", T_ALERTAS, "preparar INSERT", `
msg.params = [msg.marquesina, msg.alerta.tipo, msg.alerta.valor, msg.alerta.umbral, msg.texto,
              !!msg.whatsapp, !!msg.telegram];
return msg;`, 700, 520, [["a3_pg_ale"]], 1),
  pg("a3_pg_ale", T_ALERTAS, "INSERT alertas", `
INSERT INTO alertas (marquesina, tipo, valor, umbral, mensaje, whatsapp, telegram) VALUES ($1, $2, $3, $4, $5, $6, $7);`, 900, 520),
];

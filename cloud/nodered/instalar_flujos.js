// ============================================================================
// A3 · Instala flujos_a3.js en el Node-RED del VPS (ejecutar DENTRO del contenedor,
// con Node-RED detenido o reiniciándolo después):
//   MQTT_USER=svc-nodered MQTT_PASS=... node instalar_flujos.js /tmp/flujos_a3.js
// - Reemplaza los nodos con id "a3..." y conserva el resto de /data/flows.json.
// - Agrega la credencial del broker MQTT en /data/flows_cred.json cifrada igual que
//   Node-RED (aes-256-ctr con sha256(credentialSecret) de settings.js).
// ============================================================================
const fs = require("fs");
const crypto = require("crypto");

const nuevos = require(process.argv[2] || "/tmp/flujos_a3.js");
const FLOWS = "/data/flows.json", CRED = "/data/flows_cred.json";
const secreto = require("/data/settings.js").credentialSecret;
if (!secreto) throw new Error("settings.js no define credentialSecret");
const clave = crypto.createHash("sha256").update(secreto).digest();

const cifrar = (obj) => {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-ctr", clave, iv);
  return { $: iv.toString("hex") + c.update(JSON.stringify(obj), "utf8", "base64") + c.final("base64") };
};
const descifrar = (o) => {
  if (!o || !o.$) return o || {};
  const iv = Buffer.from(o.$.substring(0, 32), "hex");
  const d = crypto.createDecipheriv("aes-256-ctr", clave, iv);
  return JSON.parse(d.update(o.$.substring(32), "base64", "utf8") + d.final("utf8"));
};

const actuales = fs.existsSync(FLOWS) ? JSON.parse(fs.readFileSync(FLOWS, "utf8")) : [];
const conservados = actuales.filter((n) => !String(n.id).startsWith("a3"));
fs.copyFileSync(FLOWS, FLOWS + ".antes-a3");
fs.writeFileSync(FLOWS, JSON.stringify([...conservados, ...nuevos], null, 2));

let cred = {};
try { cred = descifrar(JSON.parse(fs.readFileSync(CRED, "utf8"))); }
catch (e) { console.log("flows_cred.json no se pudo leer con el credentialSecret actual; se crea de nuevo"); }
for (const k of Object.keys(cred)) if (k.startsWith("a3")) delete cred[k];
cred.a3cfg_mqtt = { user: process.env.MQTT_USER, password: process.env.MQTT_PASS };
fs.writeFileSync(CRED, JSON.stringify(cifrar(cred)));

console.log(`flows.json: ${conservados.length} nodos conservados + ${nuevos.length} nodos A3`);

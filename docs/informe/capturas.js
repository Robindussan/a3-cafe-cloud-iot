// Capturas del panel para el informe (Edge sin ventana, 1440x900 a 2x) por el túnel local.
// Uso: CLAVE=... node capturas.js
const puppeteer = require("puppeteer-core");
const BASE = "http://localhost:8089";
const OUT = __dirname + "/img/";
const esperar = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const nav = await puppeteer.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: "new", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const p = await nav.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  p.setDefaultTimeout(180000);

  await p.goto(BASE + "/login", { waitUntil: "networkidle0" });
  await p.screenshot({ path: OUT + "fig_login.png" });
  await p.type('input[name="usuario"]', "robin");
  await p.type('input[name="clave"]', process.env.CLAVE);
  await Promise.all([p.waitForNavigation({ waitUntil: "networkidle0" }), p.click('button[type="submit"]')]);

  await p.waitForFunction(() => document.querySelectorAll("[data-spark] svg path").length >= 3, { timeout: 120000 }).catch(() => {}); await esperar(3000);
  await p.screenshot({ path: OUT + "fig_resumen.png", fullPage: true });
  // Versiones recortadas para el informe: solo el contenido, sin el menú lateral
  await (await p.$(".contenido")).screenshot({ path: OUT + "fig_resumen_rec.png" });

  await p.goto(BASE + "/marquesina/marquesina-01", { waitUntil: "networkidle0" });
  await esperar(12000);
  await p.screenshot({ path: OUT + "fig_gemelo.png" });
  await (await p.$("#detalle")).screenshot({ path: OUT + "fig_gemelo_rec.png" });
  // Histórico de 6 h (incluye la prueba de anomalía de las 16:06)
  await p.click('#rangos button[data-h="6"]');
  await esperar(10000);
  const graf = await p.$(".graficas");
  await graf.screenshot({ path: OUT + "fig_historico.png" });

  await p.goto(BASE + "/alertas", { waitUntil: "networkidle0" });
  await esperar(2000);
  await p.screenshot({ path: OUT + "fig_alertas.png" });

  await p.goto(BASE + "/admin/dataset", { waitUntil: "networkidle0" });
  await p.screenshot({ path: OUT + "fig_dataset.png", fullPage: true });

  await p.goto(BASE + "/logout");
  await nav.close();
  console.log("capturas listas");
})().catch(e => { console.error(e); process.exit(1); });

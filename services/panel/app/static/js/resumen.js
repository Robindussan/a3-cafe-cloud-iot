// Resumen: tarjetas por marquesina + indicadores generales, refrescados cada 10 s.
(() => {
  const C = Panel.colores;
  const sparks = {};
  const $ = (sel, raiz = document) => raiz.querySelector(sel);

  function pintarTarjeta(m, umbrales) {
    const t = document.querySelector(`[data-id="${m.id}"]`);
    if (!t) return;
    const e = Panel.estado(m);
    const p = $('[data-campo="estado"]', t);
    p.textContent = e.txt;
    p.className = "pastilla " + e.cls;
    $('[data-campo="temp"]', t).textContent = Panel.fmt(m.temp);
    $('[data-campo="hr"]', t).textContent = m.hr == null ? "–" : Panel.fmt(m.hr) + " %";
    $('[data-campo="lux"]', t).textContent = Panel.luz(m.lux);
    $('[data-campo="co"]', t).textContent = m.co == null ? "–" : Panel.fmt(m.co) + " ppm";
    $('[data-campo="hace"]', t).textContent = "Última lectura " + Panel.hace(m.ts);
    const pct = (v, max) => v == null ? 0 : Math.min(100, Math.max(2, (v / max) * 100));
    $('[data-barra="hr"]', t).style.width = pct(m.hr, 100) + "%";
    $('[data-barra="lux"]', t).style.width = pct(m.lux, 100000) + "%";
    $('[data-barra="co"]', t).style.width = pct(m.co, umbrales.co_max * 1.5) + "%";
  }

  async function sparkline(id) {
    const el = document.querySelector(`[data-spark="${id}"]`);
    if (!el || !window.echarts) return;
    const d = await Panel.json(`/api/serie/${id}?horas=24`);
    const datos = d.puntos.filter(p => p.temp != null).map(p => [p.t, p.temp]);
    sparks[id] = sparks[id] || echarts.init(el, null, { renderer: "svg" });
    sparks[id].setOption({
      animation: false, grid: { left: 0, right: 0, top: 4, bottom: 0 },
      xAxis: { type: "time", show: false }, yAxis: { type: "value", show: false, scale: true },
      tooltip: { trigger: "axis", backgroundColor: "#1a1612", borderColor: C.borde, textStyle: { color: "#f4ece3" },
                 valueFormatter: v => Panel.fmt(v) + " °C" },
      series: [{ type: "line", data: datos, showSymbol: false, smooth: true, lineStyle: { width: 1.6, color: C.temp },
                 areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                   { offset: 0, color: "rgba(224,169,109,.35)" }, { offset: 1, color: "rgba(224,169,109,0)" }]) } }],
    });
  }

  async function actualizar() {
    try {
      const d = await Panel.json("/api/resumen");
      const ms = d.marquesinas;
      ms.forEach(m => pintarTarjeta(m, d.umbrales));
      const online = ms.filter(m => Panel.estado(m).cls === "p-ok").length;
      $("#k-online").textContent = online + " / " + ms.length;
      $("#k-online-sub").textContent = online === ms.length ? "Todas transmitiendo" : (ms.length - online) + " requieren revisión";
      const temps = ms.map(m => m.temp).filter(v => v != null);
      $("#k-temp").innerHTML = temps.length ? Panel.fmt(temps.reduce((a, b) => a + b) / temps.length) + "<small>°C</small>" : "–";
      $("#k-temp-sub").textContent = "Máximo permitido " + Panel.fmt(d.umbrales.temp_max, 0) + " °C";
      const al = ms.reduce((a, m) => a + Number(m.alertas_24h), 0);
      const ab = ms.reduce((a, m) => a + Number(m.alertas_abiertas), 0);
      $("#k-alertas").textContent = al;
      $("#k-alertas-sub").textContent = ab + " sin reconocer (7 días)";
      if (d.latencia && $("#k-lat")) {
        $("#k-lat").innerHTML = d.latencia.p50 == null ? "–"
          : Panel.fmt(d.latencia.p50 / 1000, 2) + "<small>s</small> / " + Panel.fmt(d.latencia.p95 / 1000, 2) + "<small>s</small>";
        $("#k-lat-sub").textContent = "p50 / p95 · " + d.latencia.mensajes + " mensajes en 24 h";
      }
      if ($("#k-luz")) {
        const l = ms.map(m => m.lux).filter(v => v != null);
        $("#k-luz").textContent = l.length ? Panel.luz(l.reduce((a, b) => a + b) / l.length) : "–";
      }
    } catch (e) { console.warn(e); }
  }

  // SLI/SLO (solo admin y técnico): verde si cumple, ámbar si consume presupuesto, rojo si lo agotó
  let horasSli = 24;
  function pintarSli(clave, sli, slo, sub) {
    const v = document.querySelector(`[data-sli="${clave}"]`);
    if (!v) return;
    v.textContent = sli == null ? "–" : Panel.fmt(sli, 2) + " %";
    v.style.color = sli == null ? "" : sli >= slo ? "var(--ok)" : sli >= slo - (100 - slo) ? "var(--aviso)" : "var(--peligro)";
    document.querySelector(`[data-sli-barra="${clave}"]`).style.width = (sli == null ? 0 : Math.max(2, sli)) + "%";
    document.querySelector(`[data-sli-sub="${clave}"]`).textContent = sub;
  }
  async function actualizarSli() {
    if (!document.getElementById("sli")) return;
    try {
      const d = await Panel.json(`/api/sli?horas=${horasSli}`);
      const l = d.latencia;
      pintarSli("lat", l.sli, l.slo, `SLO ${l.slo} % · p50 ${Panel.fmt(l.p50 / 1000, 2)} s · p95 ${Panel.fmt(l.p95 / 1000, 2)} s · presupuesto ${l.presupuesto_restante_pct ?? "–"} %`);
      d.disponibilidad.forEach(x => pintarSli(x.marquesina, x.sli, x.slo,
        `SLO ${x.slo} % · ${x.con_datos}/${x.ventanas} ventanas · presupuesto ${x.presupuesto_restante_pct ?? "–"} %`));
    } catch (e) { console.warn(e); }
  }
  document.querySelectorAll("#sli-rango button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("#sli-rango button").forEach(x => x.classList.toggle("activo", x === b));
    horasSli = Number(b.dataset.h);
    actualizarSli();
  }));

  actualizar();
  setInterval(actualizar, 10000);
  actualizarSli();
  setInterval(actualizarSli, 60000);
  // ECharts carga en paralelo (async): los datos se muestran antes y las mini gráficas al llegar
  const dibujarSparks = () => document.querySelectorAll("[data-spark]").forEach(el => sparkline(el.dataset.spark));
  if (window.echarts) dibujarSparks();
  else document.getElementById("echarts").addEventListener("load", dibujarSparks);
  setInterval(dibujarSparks, 60000);
  window.addEventListener("resize", () => Object.values(sparks).forEach(s => s.resize()));
})();

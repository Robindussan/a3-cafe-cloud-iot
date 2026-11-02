// Detalle de marquesina: gemelo digital en vivo, indicadores y gráficas históricas sincronizadas.
import { crearGemelo } from "./gemelo.js";

const C = Panel.colores;
const id = document.getElementById("detalle").dataset.id;
const $ = s => document.querySelector(s);
let umbrales = { temp_max: 50, hr_max: 65, co_max: 35, lux_dia: 1000 };
let horas = 24;

let gemelo = null;
try { gemelo = crearGemelo($("#gemelo")); }
catch (e) { console.warn("WebGL no disponible", e); $("#gemelo").insertAdjacentHTML("beforeend", '<p class="muted" style="position:absolute;top:50%;width:100%;text-align:center">Este navegador no soporta WebGL.</p>'); }

// ------------------------------------------------------------ En vivo
async function enVivo() {
  try {
    const d = await Panel.json("/api/resumen");
    umbrales = d.umbrales;
    const m = d.marquesinas.find(x => x.id === id);
    if (!m) return;
    const e = Panel.estado(m);
    $("#g-estado").textContent = e.txt;
    $("#g-estado").className = "pastilla " + e.cls;
    $("#v-temp").innerHTML = m.temp == null ? "–" : Panel.fmt(m.temp) + "<small>°C</small>";
    $("#s-temp").textContent = m.temp == null ? "Sensor sin lectura" : (m.temp > umbrales.temp_max ? "Sobre el máximo de " : "Máximo ") + Panel.fmt(umbrales.temp_max, 0) + " °C";
    $("#v-hr").innerHTML = m.hr == null ? "–" : Panel.fmt(m.hr) + "<small>%</small>";
    $("#s-hr").textContent = m.hr == null ? "Sensor sin lectura" : "Máximo de día " + Panel.fmt(umbrales.hr_max, 0) + " %";
    $("#v-lux").innerHTML = m.lux == null ? "–" : Panel.luz(m.lux).replace(/ (k?lx)$/, "<small>$1</small>");
    $("#s-lux").textContent = m.lux == null ? "" : (m.lux >= umbrales.lux_dia ? "Día: secado activo" : "Noche o nublado");
    $("#v-co").innerHTML = m.co == null ? "–" : Panel.fmt(m.co) + "<small>ppm</small>";
    $("#s-co").textContent = "Límite " + Panel.fmt(umbrales.co_max, 0) + " ppm";
    const i = m.info || {};
    $("#v-nodo").innerHTML = `Última lectura ${Panel.hace(m.ts)} · señal ${m.rssi ?? "–"} dBm<br>` +
      `Firmware ${i.fw ?? "–"} · banda muerta ${i.banda === false ? "apagada" : "activa"} · latencia ${m.latencia_ms == null ? "–" : Panel.fmt(m.latencia_ms / 1000, 2) + " s"}`;
    if (gemelo) gemelo.actualizar(m, umbrales);
  } catch (e) { console.warn(e); }
}

// ------------------------------------------------------------ Gráficas
const graficas = {};
const base = (titulo, unidad, color) => ({
  animation: false, backgroundColor: "transparent", textStyle: { fontFamily: "Inter, Segoe UI, sans-serif" },
  title: { text: titulo, left: 0, top: 0, textStyle: { color: "#f4ece3", fontSize: 13, fontWeight: 600 } },
  grid: { left: 44, right: 14, top: 34, bottom: 46 },
  tooltip: { trigger: "axis", backgroundColor: "#1a1612", borderColor: C.borde, textStyle: { color: "#f4ece3", fontSize: 12 },
             valueFormatter: v => v == null ? "–" : Panel.fmt(v) + " " + unidad },
  xAxis: { type: "time", axisLine: { lineStyle: { color: C.borde } }, axisLabel: { color: C.texto, fontSize: 11 }, splitLine: { show: false } },
  yAxis: { type: "value", scale: true, axisLabel: { color: C.texto, fontSize: 11 }, splitLine: { lineStyle: { color: "#231c16" } } },
  dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 6, borderColor: C.borde, fillerColor: "rgba(224,169,109,.15)",
                                    handleStyle: { color: color }, textStyle: { color: C.texto }, dataBackground: { lineStyle: { color: color, opacity: .4 }, areaStyle: { opacity: 0 } } }],
});

function serie(nombre, datos, color, banda) {
  const s = [];
  if (banda) {
    s.push({ name: "mín", type: "line", data: banda.min, stack: nombre, symbol: "none", lineStyle: { opacity: 0 }, tooltip: { show: false } });
    s.push({ name: "rango", type: "line", data: banda.rango, stack: nombre, symbol: "none", lineStyle: { opacity: 0 },
             areaStyle: { color: color, opacity: 0.14 }, tooltip: { show: false } });
  }
  s.push({ name: nombre, type: "line", data: datos, showSymbol: false, smooth: 0.3, lineStyle: { width: 2, color }, itemStyle: { color },
           areaStyle: banda ? undefined : { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
             { offset: 0, color: color + "55" }, { offset: 1, color: color + "00" }]) } });
  return s;
}

function umbral(valor, texto) {
  return { silent: true, symbol: "none", lineStyle: { color: C.co, type: "dashed", width: 1 },
           label: { formatter: texto, color: C.co, fontSize: 10, position: "insideEndTop" }, data: [{ yAxis: valor }] };
}

async function cargarHistorico() {
  const d = await Panel.json(`/api/serie/${id}?horas=${horas}`);
  $("#resolucion").textContent = "· resolución " + (d.resolucion === "cruda" ? "por lectura" : d.resolucion.replace("minutes", "min").replace("hours", "h").replace("day", "día"));
  const P = d.puntos;
  const col = k => P.map(p => [p.t, p[k]]);
  const banda = k => d.resolucion === "cruda" ? null : {
    min: P.map(p => [p.t, p[k + "_min"]]), rango: P.map(p => [p.t, p[k + "_max"] == null ? null : p[k + "_max"] - p[k + "_min"]]) };
  const marcas = tipo => d.alertas.filter(a => a.tipo === tipo).map(a => ({ coord: [a.t, a.valor], value: "!" }));
  const def = {
    temp: ["Temperatura (°C)", "°C", C.temp, col("temp"), banda("temp"), umbral(umbrales.temp_max, "máx " + umbrales.temp_max), "temp_alta"],
    hr: ["Humedad relativa (%)", "%", C.hr, col("hr"), banda("hr"), umbral(umbrales.hr_max, "máx " + umbrales.hr_max), "hr_alta"],
    lux: ["Radiación solar (lux)", "lx", C.lux, col("lux"), null, null, null],
    co: ["Monóxido de carbono (ppm)", "ppm", C.co, col("co"), null, umbral(umbrales.co_max, "límite " + umbrales.co_max), "co_alto"],
  };
  for (const [k, [titulo, unidad, color, datos, b, linea, tipoAlerta]] of Object.entries(def)) {
    const el = document.getElementById("g-" + k);
    graficas[k] = graficas[k] || echarts.init(el, null, { renderer: "canvas" });
    const opcion = base(titulo, unidad, color);
    opcion.series = serie(titulo, datos, color, b);
    const principal = opcion.series[opcion.series.length - 1];
    if (linea) principal.markLine = linea;
    if (tipoAlerta) principal.markPoint = { symbol: "pin", symbolSize: 26, itemStyle: { color: C.co }, label: { color: "#fff", fontSize: 10 }, data: marcas(tipoAlerta) };
    // Anomalías del servicio de puntaje z: rombos violeta sobre la variable afectada
    const anom = (d.anomalias || []).filter(a => a.variable === k).map(a => [a.t, a.valor, a.puntaje]);
    if (anom.length) opcion.series.push({ name: "Anomalía", type: "scatter", data: anom, symbol: "diamond", symbolSize: 11,
      itemStyle: { color: "#b48cf2", borderColor: "#1a1612", borderWidth: 1 }, z: 5,
      tooltip: { valueFormatter: undefined, formatter: p => `Anomalía · ${Panel.fmt(p.value[1])} ${unidad}<br>puntaje z ${p.value[2]}` } });
    graficas[k].setOption(opcion, true);
  }
  echarts.connect(Object.values(graficas));
}

document.querySelectorAll("#rangos button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("#rangos button").forEach(x => x.classList.toggle("activo", x === b));
  horas = Number(b.dataset.h);
  cargarHistorico();
}));
window.addEventListener("resize", () => Object.values(graficas).forEach(g => g.resize()));

await enVivo();
setInterval(enVivo, 10000);
// ECharts llega en paralelo (async); el gemelo y los indicadores no lo esperan
const conGraficas = () => { cargarHistorico(); setInterval(cargarHistorico, 60000); };
if (window.echarts) conGraficas();
else document.getElementById("echarts").addEventListener("load", conGraficas);

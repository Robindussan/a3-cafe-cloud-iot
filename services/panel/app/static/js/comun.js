// Utilidades compartidas del panel (sin dependencias).
const Panel = {
  async json(url) {
    const r = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (r.status === 401) { location.href = "/login"; throw new Error("sesión expirada"); }
    if (!r.ok) throw new Error(url + " → HTTP " + r.status);
    return r.json();
  },
  fmt(v, dec = 1) {
    return v === null || v === undefined || Number.isNaN(v) ? "–"
      : Number(v).toLocaleString("es-CO", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  },
  // Luz legible: lux enteros bajo techo o nublado; klx solo con sol fuerte.
  luz(v) {
    if (v === null || v === undefined) return "–";
    return v < 1000 ? Math.round(v).toLocaleString("es-CO") + " lx" : Panel.fmt(v / 1000, 1) + " klx";
  },
  hace(iso) {
    if (!iso) return "sin datos";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "hace " + Math.round(s) + " s";
    if (s < 3600) return "hace " + Math.round(s / 60) + " min";
    if (s < 86400) return "hace " + Math.round(s / 3600) + " h";
    return "hace " + Math.round(s / 86400) + " d";
  },
  // Estado mostrado: offline por LWT, o "sin datos" si pasó más del umbral de inactividad.
  estado(m) {
    if (!m.estado) return { txt: "sin datos", cls: "p-neutra" };
    if (m.estado === "offline") return { txt: "desconectada", cls: "p-mal" };
    const edad = m.ultimo_dato ? (Date.now() - new Date(m.ultimo_dato).getTime()) / 60000 : 1e9;
    if (edad > 12) return { txt: "sin datos " + Math.round(edad) + " min", cls: "p-aviso" };
    return { txt: "en línea", cls: "p-ok" };
  },
  colores: { temp: "#e0a96d", hr: "#6fb3dc", lux: "#f2c14e", co: "#ef6a55", hoja: "#8cc084", texto: "#b5a492", borde: "#33291f" },
};

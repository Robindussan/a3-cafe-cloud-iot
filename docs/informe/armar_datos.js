// Arma datos.json con las mediciones reales y el modelo de costos.
const fs = require("fs");
const dim = f => { const b = fs.readFileSync(__dirname + "/img/" + f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const opt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const A = opt.fase_A, B = opt.fase_B;
const motB = Object.values(B.por_marquesina).reduce((t, m) => { for (const [k, v] of Object.entries(m.motivos)) t[k] = (t[k] || 0) + v; return t; }, {});
const hora = e => new Date(e * 1000).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false });
const cop = n => "$ " + Math.round(n).toLocaleString("es-CO");

// ---------------------------------------------------------------- modelo de costos (COP/mes)
const msgMarqH = B.mensajes_h / 3;                       // con banda muerta (medido)
const msgMarqHSin = A.mensajes_h / 3;                    // sin banda muerta (medido)
const bytesFincaMes = (bytesAireH, mpf) => {
  const carga = bytesAireH / 3 * mpf * 720;              // tópico + carga + MQTT + TLS (medido)
  const tcpip = (bytesAireH / 3 / 110) * mpf * 720 * 80; // ~80 B de TCP/IP y ACK por mensaje (supuesto)
  const keepalive = 3 * 60 * 24 * 30 * 2 * 71;           // PINGREQ/PINGRESP cada 20 s con TLS y TCP/IP
  return carga + tcpip + keepalive;
};
const escenario = (marq) => {
  const fincas = Math.ceil(marq / 3);
  const filasMes = marq * msgMarqH * 720, filasMesSin = marq * msgMarqHSin * 720;
  const vps = marq <= 200 ? 25000 : 50000 + 25000 + 25000;  // KVM 2 | KVM 4 + VPS de respaldo + copias externas
  const datos = fincas * 10000;                             // plan prepago 1 GB por finca
  const hw = marq * 80000 / 36 + fincas * 320000 / 36;      // nodo y Raspberry amortizados a 36 meses
  return { marq, fincas, filasMes, filasMesSin, vps, datos, hw, total: vps + datos + hw };
};
const e20 = escenario(20), e2k = escenario(2000);
const mbFinca = bytesFincaMes(B.bytes_aire_h, 3) / 1e6, mbFincaSin = bytesFincaMes(A.bytes_aire_h, 3) / 1e6;
const gb = filas => (filas * 120 / 1e9);                    // ~120 B por fila sin comprimir (con índices)

const D = {
  fecha: "2 de noviembre de 2026", fecha_corta: "2 de noviembre de 2026", fw: "3.0.4",
  repo: "https://github.com/Robindussan/a3-cafe-cloud-iot", panel: "https://panel.agrotecnet.cloud",
  video: "(se agrega al publicar el video)",
  img: { resumen: dim("fig_resumen_rec.png"), gemelo: dim("fig_gemelo_rec.png") },
  tls: { registros: 45 }, anom: { v10_co: 695 },
  optimizacion: {
    minutos: opt.minutos_por_fase,
    A: { mensajes_h: A.mensajes_h, bytes_aire_h: A.bytes_aire_h, p50: A.latencia_p50_ms, p95: A.latencia_p95_ms },
    B: { mensajes_h: B.mensajes_h, bytes_aire_h: B.bytes_aire_h, p50: B.latencia_p50_ms, p95: B.latencia_p95_ms,
         motivos: `${motB.c || 0} por cambio (c) y ${motB.l || 0} latidos (l)` },
    red_msg: opt.reduccion_mensajes_pct, red_bytes: opt.reduccion_bytes_pct,
    horaA: `${hora(A.inicio_epoch)} a ${hora(A.fin_epoch)}`, horaB: `${hora(B.inicio_epoch)} a ${hora(B.fin_epoch)}`,
    discusion: `Con la banda muerta cada marquesina pasó de 360 a unos ${Math.round(msgMarqH)} mensajes por hora; ${motB.c || 0} de los ${B.mensajes} mensajes de la fase con banda se enviaron por un cambio real y solo ${motB.l || 0} fueron latidos, de modo que no se perdió información relevante: los cambios bruscos (que son los que disparan alertas) se publican de inmediato. La latencia p95 bajó de ${A.latencia_p95_ms.toLocaleString("es-CO")} ms a ${B.latencia_p95_ms} ms porque, con menos mensajes, se redujeron las colas en el WiFi y en el bridge; la mediana apenas cambió (${A.latencia_p50_ms} ms frente a ${B.latencia_p50_ms} ms). El ahorro se traslada a la nube: ${Math.round(opt.reduccion_mensajes_pct)} % menos filas en la base y menos trabajo de ingesta, alertas y detección de anomalías. La reducción depende de la variabilidad: en horas de sol cambiante habrá más envíos que en esta medición en interior.`,
  },
  latencia: { p50: 63, p95: 1234, n: 1419 },
  sli: { periodo: "14:19–18:22", lat: 97.74, lat_presupuesto: (97.74 - 95) / 5 * 100, disp: "100 % (01, 02 y 03; 25/25 ventanas)", disp_presupuesto: "100 %" },
  costos: {
    filas: [
      ["Fincas (1 Raspberry cada una)", String(e20.fincas), e2k.fincas.toLocaleString("es-CO"), "3 marquesinas por finca en promedio"],
      ["Mensajes al mes (con banda muerta)", Math.round(e20.filasMes).toLocaleString("es-CO"), Math.round(e2k.filasMes).toLocaleString("es-CO"), `${msgMarqH.toFixed(0)} mensajes/marquesina/h medidos`],
      ["Mensajes al mes (sin banda muerta)", Math.round(e20.filasMesSin).toLocaleString("es-CO"), Math.round(e2k.filasMesSin).toLocaleString("es-CO"), "360 mensajes/marquesina/h medidos"],
      ["Datos en la BD al mes, sin comprimir", gb(e20.filasMes).toFixed(2).replace(".", ",") + " GB", gb(e2k.filasMes).toFixed(1).replace(".", ",") + " GB", "~120 B por fila; TimescaleDB comprime ~10× a los 7 días"],
      ["Nube (VPS)", cop(e20.vps), cop(e2k.vps), "Real: KVM 2 por COP 600.000/24 meses. 2.000: KVM 4 + VPS de respaldo + copias externas (estimado)"],
      ["Dominio, certificados y Telegram", cop(0), cop(0), "Dominio incluido en el plan; Let's Encrypt y Telegram gratuitos"],
      ["Datos móviles", cop(e20.datos), cop(e2k.datos), `Plan prepago de 1 GB por finca (COP 10.000); consumo estimado ${mbFinca.toFixed(0)} MB/mes por finca (${mbFincaSin.toFixed(0)} MB sin banda muerta)`],
      ["Hardware amortizado (36 meses)", cop(e20.hw), cop(e2k.hw), "Nodo COP 80.000; Raspberry con fuente y SD COP 320.000 por finca"],
      ["**Total mensual**", "**" + cop(e20.total) + "**", "**" + cop(e2k.total) + "**", ""],
      ["Total por marquesina", cop(e20.total / 20), cop(e2k.total / 2000), ""],
      ["Solo nube por marquesina", cop(e20.vps / 20), cop(e2k.vps / 2000), ""],
    ],
    nota: "Valores en pesos colombianos por mes. El precio del VPS es el pagado por el autor; los demás son supuestos de referencia del mercado colombiano en 2026. No incluye mano de obra de instalación ni mantenimiento.",
    discusion: `Con 20 marquesinas el VPS actual sobra: recibe menos de un mensaje cada ${Math.round(3600 / (20 * msgMarqH))} s y la base crece ${gb(e20.filasMes).toFixed(2).replace(".", ",")} GB al mes. A 2.000 marquesinas el flujo sigue siendo bajo para EMQX y TimescaleDB (${(2000 * msgMarqH / 3600).toFixed(0)} mensajes/s y ${e2k.fincas} conexiones de bridge), pero se recomienda un VPS mayor y uno de respaldo por disponibilidad y copias de seguridad, no por capacidad; además, EMQX Community no admite clúster, por lo que la alta disponibilidad requeriría una licencia comercial o un esquema activo-pasivo. El costo dominante no es la nube sino el campo: los planes de datos y el hardware representan más del ${Math.round(100 * (e2k.datos + e2k.hw) / e2k.total)} % del total a gran escala, y la nube cuesta unos ${cop(e2k.vps / 2000)} por marquesina al mes. La banda muerta es lo que hace viable la escala: sin ella, 2.000 marquesinas generarían ${(e2k.filasMesSin / 1e6).toFixed(0)} millones de filas al mes (${gb(e2k.filasMesSin).toFixed(0)} GB sin comprimir), más de lo que admite el disco de 100 GB del plan actual en pocos meses.`,
  },
  referencias: [
    "Banks, A., Briggs, E., Borgendale, K., & Gupta, R. (Eds.). (2019). *MQTT version 5.0* (OASIS Standard). OASIS. https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html",
    "Barker, E. (2020). *Recommendation for key management: Part 1 – General* (NIST SP 800-57 Part 1 Rev. 5). National Institute of Standards and Technology. https://doi.org/10.6028/NIST.SP.800-57pt1r5",
    "Beyer, B., Jones, C., Petoff, J., & Murphy, N. R. (Eds.). (2016). *Site reliability engineering: How Google runs production systems*. O'Reilly Media.",
    "EMQ Technologies. (2026a). *EMQX documentation*. Recuperado el 2 de noviembre de 2026, de https://docs.emqx.com/",
    "EMQ Technologies. (2026b). *NanoMQ documentation*. Recuperado el 2 de noviembre de 2026, de https://nanomq.io/docs/",
    "Liu, F. T., Ting, K. M., & Zhou, Z.-H. (2008). Isolation forest. En *2008 Eighth IEEE International Conference on Data Mining* (pp. 413–422). IEEE. https://doi.org/10.1109/ICDM.2008.17",
    "Rescorla, E. (2018). *The Transport Layer Security (TLS) protocol version 1.3* (RFC 8446). Internet Engineering Task Force. https://doi.org/10.17487/RFC8446",
    "Roa, G., Oliveros, C. E., Álvarez, J., Ramírez, C. A., Sanz, J. R., Dávila, M. T., Álvarez, J. R., Zambrano, D. A., Puerta, G. I., & Rodríguez, N. (1999). *Beneficio ecológico del café*. Cenicafé.",
    "Shi, W., Cao, J., Zhang, Q., Li, Y., & Xu, L. (2016). Edge computing: Vision and challenges. *IEEE Internet of Things Journal, 3*(5), 637–646. https://doi.org/10.1109/JIOT.2016.2579198",
    "Shostack, A. (2014). *Threat modeling: Designing for security*. Wiley.",
    "Timescale. (2026). *TimescaleDB documentation*. Recuperado el 2 de noviembre de 2026, de https://docs.timescale.com/",
    "Yousefpour, A., Fung, C., Nguyen, T., Kadiyala, K., Jalali, F., Niakanlahiji, A., Kong, J., & Jue, J. P. (2019). All one needs to know about fog computing and related edge computing paradigms: A complete survey. *Journal of Systems Architecture, 98*, 289–330. https://doi.org/10.1016/j.sysarc.2019.02.009",
  ],
};
fs.writeFileSync(__dirname + "/datos.json", JSON.stringify(D, null, 1));
console.log("20:", Math.round(e20.total), "2000:", Math.round(e2k.total), "MB/finca:", mbFinca.toFixed(1), mbFincaSin.toFixed(1));

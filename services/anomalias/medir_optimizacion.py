"""Mide la técnica de optimización (banda muerta en el ESP32): fase A sin banda, fase B con banda.

En cada fase cuenta, por marquesina y en total, los mensajes de telemetría que llegan a EMQX,
los bytes de carga útil, una estimación de bytes en el aire (cabecera MQTT + registro TLS) y la
latencia nodo -> broker en la nube (llegada - ts del nodo). Al final deja la banda activa.

    MINUTOS=60 python medir_optimizacion.py > resultado.json
"""
import json
import os
import statistics
import sys
import threading
import time

import paho.mqtt.client as mqtt

MINUTOS = float(os.environ.get("MINUTOS", "60"))
CALENTAMIENTO_S = 30
MARQUESINAS = os.environ.get("MARQUESINAS", "marquesina-01,marquesina-02,marquesina-03").split(",")
TLS_POR_REGISTRO = 29     # cabecera + MAC de un registro TLS 1.3 (AES-GCM) aprox.

fase = None
datos = {}
cerrojo = threading.Lock()


def nueva_fase(nombre):
    return {"nombre": nombre, "inicio": None, "fin": None,
            "por_marquesina": {m: {"mensajes": 0, "bytes_carga": 0, "bytes_aire": 0, "latencias_ms": [],
                                   "motivos": {}} for m in MARQUESINAS}}


def al_mensaje(_c, _u, msg):
    llegada = time.time() * 1000
    with cerrojo:
        if fase is None or datos[fase]["inicio"] is None:
            return
        m = msg.topic.split("/")[1]
        r = datos[fase]["por_marquesina"].get(m)
        if r is None:
            return
        r["mensajes"] += 1
        r["bytes_carga"] += len(msg.payload)
        # PUBLISH QoS0: 1 byte de tipo + 1-2 de longitud + 2 + tópico + carga, dentro de un registro TLS
        r["bytes_aire"] += 2 + 2 + len(msg.topic) + len(msg.payload) + TLS_POR_REGISTRO
        try:
            p = json.loads(msg.payload)
            r["latencias_ms"].append(llegada - p["ts"])
            r["motivos"][p.get("m", "?")] = r["motivos"].get(p.get("m", "?"), 0) + 1
        except (ValueError, KeyError, TypeError):
            pass


def banda(cliente, activa):
    for m in MARQUESINAS:
        cliente.publish(f"cafe/{m}/cmd", json.dumps({"cmd": "banda", "activa": activa}), qos=1)


def correr_fase(cliente, nombre, activa):
    global fase
    with cerrojo:
        fase = nombre
        datos[nombre] = nueva_fase(nombre)
    banda(cliente, activa)
    time.sleep(CALENTAMIENTO_S)
    with cerrojo:
        datos[nombre]["inicio"] = time.time()
    print(f"[{time.strftime('%H:%M:%S')}] fase {nombre} ({MINUTOS:g} min)", file=sys.stderr, flush=True)
    time.sleep(MINUTOS * 60)
    with cerrojo:
        datos[nombre]["fin"] = time.time()
        fase = None


def resumir(f):
    horas = (f["fin"] - f["inicio"]) / 3600
    tot = {"mensajes": 0, "bytes_carga": 0, "bytes_aire": 0}
    lat = []
    por_m = {}
    for m, r in f["por_marquesina"].items():
        for k in tot:
            tot[k] += r[k]
        lat += r["latencias_ms"]
        por_m[m] = {"mensajes": r["mensajes"], "mensajes_h": round(r["mensajes"] / horas, 1),
                    "bytes_carga": r["bytes_carga"], "motivos": r["motivos"]}
    q = statistics.quantiles(lat, n=20) if len(lat) >= 20 else []
    return {"nombre": f["nombre"], "inicio_epoch": f["inicio"], "fin_epoch": f["fin"], "horas": round(horas, 3),
            "mensajes": tot["mensajes"], "mensajes_h": round(tot["mensajes"] / horas, 1),
            "bytes_carga": tot["bytes_carga"], "bytes_aire_estimados": tot["bytes_aire"],
            "bytes_aire_h": round(tot["bytes_aire"] / horas),
            "latencia_p50_ms": round(statistics.median(lat)) if lat else None,
            "latencia_p95_ms": round(q[18]) if q else None, "por_marquesina": por_m}


if __name__ == "__main__":
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="svc-monitor-optimizacion")
    c.username_pw_set(os.environ["MONITOR_USER"], os.environ["MONITOR_PASS"])
    c.on_message = al_mensaje
    c.connect(os.environ.get("MQTT_HOST", "emqx"), 1883, keepalive=60)
    c.subscribe("cafe/+/telemetria", qos=0)
    c.loop_start()
    try:
        correr_fase(c, "A_sin_banda_muerta", False)
        correr_fase(c, "B_con_banda_muerta", True)
    finally:
        banda(c, True)
        time.sleep(2)
        c.loop_stop()
    a, b = resumir(datos["A_sin_banda_muerta"]), resumir(datos["B_con_banda_muerta"])
    red = lambda x, y: round(100 * (1 - y / x), 1) if x else None
    print(json.dumps({"minutos_por_fase": MINUTOS, "fase_A": a, "fase_B": b,
                      "reduccion_mensajes_pct": red(a["mensajes_h"], b["mensajes_h"]),
                      "reduccion_bytes_pct": red(a["bytes_aire_h"], b["bytes_aire_h"])}, indent=2))

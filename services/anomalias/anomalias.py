"""Detección de anomalías por puntaje z en ventana móvil (una ventana por marquesina y variable).

Se suscribe a cafe/+/telemetria (usuario MQTT svc-anomalias), compara cada lectura con las
últimas N de esa misma marquesina y variable, y si |z| supera el umbral publica en
cafe/<id>/anomalia y la guarda en la tabla anomalias (rol app_anomalias), con el mismo ts de
la lectura para poder unirla al dataset de ML.

    z = (x - media) / desviación      con media y desviación de la ventana SIN incluir x

Una lectura anómala no entra a la ventana, para que un pico no "contamine" la referencia.
Al arrancar la ventana se precarga con el histórico reciente de TimescaleDB.
"""
import json
import logging
import os
import statistics
from collections import defaultdict, deque
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
import psycopg

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("anomalias")

VENTANA = int(os.environ.get("VENTANA", "60"))          # lecturas de referencia
MINIMO = int(os.environ.get("MINIMO", "20"))            # lecturas antes de evaluar
UMBRAL_Z = float(os.environ.get("UMBRAL_Z", "3.0"))
# Desviación mínima por variable: evita marcar como anomalía el ruido de una señal casi plana
DESV_MIN = {"temp": 0.3, "hr": 1.0, "lux": 50.0, "co": 1.0}
VARIABLES = tuple(DESV_MIN)
METODO = f"zscore_v{VENTANA}_u{UMBRAL_Z:g}"

ventanas = defaultdict(lambda: deque(maxlen=VENTANA))
db = psycopg.connect(host=os.environ.get("PG_HOST", "timescaledb"), dbname=os.environ.get("PG_DB", "iot_db"),
                     user=os.environ["PG_USER"], password=os.environ["PG_PASS"],
                     application_name="anomalias-a3", autocommit=True)


def precargar():
    filas = db.execute(
        """SELECT marquesina, temp, hr, lux, co FROM (
               SELECT *, row_number() OVER (PARTITION BY marquesina ORDER BY ts DESC) AS n
               FROM telemetria WHERE ts > now() - interval '12 hours') t
           WHERE n <= %s ORDER BY marquesina, ts""", (VENTANA,)).fetchall()
    for m, *valores in filas:
        for var, v in zip(VARIABLES, valores):
            if v is not None:
                ventanas[(m, var)].append(float(v))
    log.info("ventanas precargadas: %s", {f"{k[0][-2:]}:{k[1]}": len(v) for k, v in ventanas.items()})


def evaluar(marquesina, ts_ms, lectura):
    anomalias = []
    for var in VARIABLES:
        x = lectura.get(var)
        if x is None:
            continue
        v = ventanas[(marquesina, var)]
        if len(v) >= MINIMO:
            media = statistics.fmean(v)
            desv = max(statistics.pstdev(v), DESV_MIN[var])
            z = (x - media) / desv
            if abs(z) >= UMBRAL_Z:
                anomalias.append({"variable": var, "valor": x, "z": round(z, 2), "media": round(media, 2),
                                  "desv": round(desv, 3)})
                continue          # no se agrega a la ventana
        v.append(float(x))
    return anomalias


def al_conectar(cliente, _u, _f, rc, _p=None):
    log.info("conectado a EMQX (rc=%s)", rc)
    cliente.subscribe("cafe/+/telemetria", qos=1)


def al_mensaje(cliente, _u, msg):
    try:
        p = json.loads(msg.payload)
        marquesina = msg.topic.split("/")[1]
        if p.get("id") != marquesina or not isinstance(p.get("ts"), (int, float)):
            return
        for a in evaluar(marquesina, p["ts"], p):
            ts = datetime.fromtimestamp(p["ts"] / 1000, tz=timezone.utc)
            salida = {"id": marquesina, "ts": p["ts"], "seq": p.get("seq"), "metodo": METODO, **a}
            cliente.publish(f"cafe/{marquesina}/anomalia", json.dumps(salida), qos=1)
            db.execute("INSERT INTO anomalias (ts, marquesina, variable, valor, puntaje, metodo) "
                       "VALUES (%s, %s, %s, %s, %s, %s)", (ts, marquesina, a["variable"], a["valor"], a["z"], METODO))
            log.warning("ANOMALÍA %s %s=%s z=%s (media %s, desv %s)", marquesina, a["variable"], a["valor"],
                        a["z"], a["media"], a["desv"])
    except Exception:
        log.exception("error procesando %s", msg.topic)


if __name__ == "__main__":
    precargar()
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="svc-anomalias-vps", clean_session=False)
    c.username_pw_set(os.environ["MQTT_USER"], os.environ["MQTT_PASS"])
    c.on_connect, c.on_message = al_conectar, al_mensaje
    c.reconnect_delay_set(1, 30)
    c.connect(os.environ.get("MQTT_HOST", "emqx"), int(os.environ.get("MQTT_PORT", "1883")), keepalive=60)
    c.loop_forever()

# Servicio de anomalías (puntaje z)

Contenedor Python sin puertos: se suscribe a `cafe/+/telemetria` (usuario MQTT `svc-anomalias`) y por cada
marquesina y variable (temp, hr, lux, co) compara la lectura con las últimas `VENTANA` (60) lecturas:

`z = (x − media) / max(desv, desv_mín)`; si `|z| ≥ UMBRAL_Z` (3) es anomalía.

- Publica `cafe/<id>/anomalia` → Node-RED la convierte en alerta (tipo `anomalia_<variable>`) con antirebote y
  la envía a Telegram.
- La guarda en la tabla `anomalias` (rol `app_anomalias`) con el mismo `ts` de la lectura → columna `anomalia`
  del dataset de ML del panel. El panel la marca con un rombo violeta en el histórico.
- La lectura anómala no entra a la ventana (no contamina la referencia). Al arrancar precarga 12 h de TimescaleDB.
- `desv_mín` por variable (0,3 °C, 1 %, 50 lx, 1 ppm) evita falsos positivos en señales casi planas.
- Versión del "modelo" = parámetros (`metodo = zscore_v60_u3`), fijados en la imagen y en `docker-compose.yml`:
  cambiar el modelo es publicar una imagen nueva (`agrotecnet/anomalias-cafe:x.y.z`).

`medir_optimizacion.py` (misma imagen) mide la banda muerta: 60 min sin banda y 60 min con banda, contando
mensajes, bytes y latencia en EMQX con el usuario `svc-monitor`.

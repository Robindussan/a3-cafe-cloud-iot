# Node-RED del VPS — ingesta, estado y alertas

Los flujos viven como código en `flujos_a3.js` (ids `a3...`). Para instalarlos o actualizarlos:

```bash
scp flujos_a3.js instalar_flujos.js root@VPS:/tmp/
# en el VPS
MP=$(awk '$1=="svc-nodered"{print $2}' /root/a3_secretos/mqtt_usuarios.txt)
docker stop nodered
docker run --rm --volumes-from nodered -v /tmp:/tmp:ro -e MQTT_USER=svc-nodered -e MQTT_PASS="$MP" \
  --entrypoint node nodered/node-red:latest /tmp/instalar_flujos.js /tmp/flujos_a3.js
docker start nodered
```

| Pestaña | Qué hace |
|---|---|
| A3 · Ingesta y estado | `cafe/+/telemetria` → validación (id = tópico, rangos) → `telemetria`; `cafe/+/estado` (LWT) → `estado` y `eventos_estado` |
| A3 · Alertas | reglas con la tabla `umbrales` (recarga cada 60 s), "sin datos" > `offline_min`, antirebote, `cafe/alertas`, WhatsApp (CallMeBot, máx. 1 cada 5 s) y tabla `alertas` |

PostgreSQL usa el rol `app_nodered` por variables de entorno (`nodered.env.example`); la credencial MQTT
va cifrada en `flows_cred.json` con el `credentialSecret` de `settings.js`.

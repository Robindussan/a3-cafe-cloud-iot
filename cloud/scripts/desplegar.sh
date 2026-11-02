#!/bin/bash
# Despliegue en el VPS (lo llama GitHub Actions o se ejecuta a mano). Idempotente.
#  1. Actualiza panel y anomalías a la versión VERSION (imagen de GHCR) o los reconstruye.
#  2. Reinstala los flujos de Node-RED desde el repositorio.
#  3. Verifica que el panel responda; si no, termina con error (el job de GitHub queda en rojo y
#     se vuelve a la versión anterior relanzando el workflow sobre el commit previo).
set -euo pipefail
D=/opt/a3/despliegue
S=/root/a3_secretos
VERSION=${VERSION:-local}

desplegar_servicio() {   # $1 = panel | anomalias
  local s=$1 dir=/opt/a3/$1
  local anterior; anterior=$(docker inspect -f '{{.Config.Image}}' "$s" 2>/dev/null || true)
  rm -rf "$dir.nuevo" && cp -r "$D/services/$s" "$dir.nuevo"
  rm -rf "$dir" && mv "$dir.nuevo" "$dir"
  (cd "$dir" && docker compose -p "$s" up -d --build)
  echo "$s: $anterior -> $(docker inspect -f '{{.Config.Image}}' "$s") ($VERSION)"
}

desplegar_servicio anomalias
desplegar_servicio panel

# Flujos de Node-RED (solo los nodos a3..., conserva el resto)
cp "$D/cloud/nodered/flujos_a3.js" "$D/cloud/nodered/instalar_flujos.js" /tmp/
MP=$(awk '$1=="svc-nodered"{print $2}' $S/mqtt_usuarios.txt)
docker stop nodered >/dev/null
docker run --rm --volumes-from nodered -v /tmp:/tmp:ro -e MQTT_USER=svc-nodered -e MQTT_PASS="$MP" \
  --entrypoint node "$(docker inspect -f '{{.Config.Image}}' nodered)" /tmp/instalar_flujos.js /tmp/flujos_a3.js
docker start nodered >/dev/null

# Verificación de salud
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' panel)
for i in $(seq 1 30); do curl -sf -o /dev/null "http://$IP:8000/login" && break; sleep 2; done
curl -sf -o /dev/null "http://$IP:8000/login" || { echo "panel no responde"; exit 1; }
docker logs --tail 3 anomalias
echo "despliegue $VERSION OK"

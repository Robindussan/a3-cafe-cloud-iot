#!/bin/sh
# Copia el certificado de mqtt.agrotecnet.cloud que renueva NPM a una ruta legible por EMQX
# y reinicia EMQX solo si cambió. Lo ejecuta cron a diario.
L=$(docker volume inspect -f '{{.Mountpoint}}' nginx-proxy-manager_npm_letsencrypt)/live/npm-5
D=/opt/a3/emqx/certs
if ! cmp -s "$L/fullchain.pem" "$D/fullchain.pem" || ! cmp -s "$L/privkey.pem" "$D/privkey.pem"; then
  install -o 1000 -g 1000 -m 644 "$L/fullchain.pem" "$D/fullchain.pem"
  install -o 1000 -g 1000 -m 600 "$L/privkey.pem" "$D/privkey.pem"
  [ "$1" = "--no-restart" ] || docker restart emqx >/dev/null
  logger -t emqx-cert-sync "certificado actualizado"
fi

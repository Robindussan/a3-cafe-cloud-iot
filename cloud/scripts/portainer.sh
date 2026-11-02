#!/bin/sh
# Portainer sin puertos publicados; se accede por https://portainer.agrotecnet.cloud (NPM)
docker run -d --name portainer --restart=always --network iot_network \
  -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:2.45.2

#!/bin/bash
# A3 - Red del fog (Raspberry Pi 3 B+, Raspberry Pi OS 13 con NetworkManager).
#   eth0  : LAN del router por DHCP (salida a Internet); administración por raspberry-robin.local
#           (sin acceso al router del proveedor no se puede reservar una IP fija)
#   wlan0 : punto de acceso "AgroTecnet-Fog" (WPA2), 192.168.50.1/24 con DHCP para los nodos
#   Nodos : sin salida a Internet (solo MQTT/TLS al NanoMQ y NTP de la Raspberry)
# Se ejecuta con: sudo systemd-run --unit a3-red /home/robin/a3/fog/red/configurar_red.sh
# (desacoplado de SSH: la sesión se corta cuando la WiFi deja de estar en el router).
set -e
exec > /home/robin/a3/fog/red/configurar_red.log 2>&1
read -r SSID PSK < /home/robin/a3/secretos/wifi_fog.txt
echo "== $(date) inicio"

# 1) País de la WiFi (canales y potencia legales en Colombia)
raspi-config nonint do_wifi_country CO || iw reg set CO

# 2) NTP para los nodos: chrony sincroniza con Internet y sirve la hora a 192.168.50.0/24
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chrony
cat > /etc/chrony/conf.d/a3-fog.conf <<CH
# A3: servidor NTP para los nodos de la red del fog
allow 192.168.50.0/24
local stratum 10
CH
systemctl restart chrony

# 3) DNS y DHCP de la red de nodos (dnsmasq que lanza NetworkManager en modo "shared")
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
cat > /etc/NetworkManager/dnsmasq-shared.d/a3-fog.conf <<DM
# A3: nombre del broker (coincide con el certificado del NanoMQ) y NTP local
address=/fog.finca/192.168.50.1
dhcp-option=option:ntp-server,192.168.50.1
DM

# 4) Aislamiento: los nodos no salen a Internet (sí llegan al NanoMQ por el DNAT de Docker)
cat > /etc/nftables.d-a3-fog.nft <<NF
table inet a3_fog {
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "wlan0" oifname "eth0" counter drop comment "nodos sin Internet"
  }
}
NF
cat > /etc/systemd/system/a3-fog-nft.service <<SV
[Unit]
Description=A3 aislamiento de la red de nodos del fog
After=network-pre.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/nftables.d-a3-fog.nft
ExecStop=/usr/sbin/nft delete table inet a3_fog
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
SV
systemctl daemon-reload
nft delete table inet a3_fog 2>/dev/null || true
systemctl enable --now a3-fog-nft.service

# 5) eth0 se deja en DHCP
ETH=$(nmcli -g NAME,DEVICE con show | awk -F: '$2=="eth0"{print $1; exit}')

# 6) wlan0: dejar el router y crear el punto de acceso
WIFI=$(nmcli -g NAME,TYPE con show | awk -F: '$2=="802-11-wireless" && $1!="fog-ap"{print $1}')
for c in $WIFI; do nmcli con mod "$c" connection.autoconnect no || true; nmcli con down "$c" || true; done
nmcli con delete fog-ap 2>/dev/null || true
nmcli con add type wifi ifname wlan0 con-name fog-ap autoconnect yes ssid "$SSID" \
  802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel 6 \
  wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp wifi-sec.psk "$PSK" \
  802-11-wireless.powersave 2 ipv4.method shared ipv4.addresses 192.168.50.1/24 ipv6.method disabled
nmcli con up fog-ap
nmcli con up "$ETH"
echo "== $(date) fin"; ip -br addr; nmcli -t -f NAME,DEVICE,STATE con show --active

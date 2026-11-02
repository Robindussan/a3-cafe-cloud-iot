#!/bin/bash
# A3 - Deshace configurar_red.sh: wlan0 vuelve al router y eth0 a DHCP.
nmcli con delete fog-ap 2>/dev/null
for c in $(nmcli -g NAME,TYPE con show | awk -F: '$2=="802-11-wireless"{print $1}'); do nmcli con mod "$c" connection.autoconnect yes; nmcli con up "$c"; done
ETH=$(nmcli -g NAME,DEVICE con show | awk -F: '$2=="eth0"{print $1; exit}')
nmcli con mod "$ETH" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""; nmcli con up "$ETH"
systemctl disable --now a3-fog-nft.service

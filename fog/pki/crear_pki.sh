#!/bin/sh
# PKI de la finca: CA propia (EC P-256, 10 años) y certificado del NanoMQ para fog.finca / 192.168.50.1.
# Las claves privadas (*.key) quedan solo en la Raspberry (~/a3/fog/pki, permisos 600).
set -e; umask 077
[ -f ca_finca.key ] || { openssl ecparam -name prime256v1 -genkey -noout -out ca_finca.key
  openssl req -x509 -new -key ca_finca.key -sha256 -days 3650 -subj "/C=CO/O=AgroTecnet/OU=Finca/CN=CA Finca AgroTecnet" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca_finca.crt; }
openssl ecparam -name prime256v1 -genkey -noout -out fog.key
openssl req -new -key fog.key -subj "/C=CO/O=AgroTecnet/CN=fog.finca" -out fog.csr
printf "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyAgreement\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:fog.finca,IP:192.168.50.1\n" > fog.ext
openssl x509 -req -in fog.csr -CA ca_finca.crt -CAkey ca_finca.key -CAcreateserial -days 825 -sha256 -extfile fog.ext -out fog.crt
chmod 644 ca_finca.crt fog.crt

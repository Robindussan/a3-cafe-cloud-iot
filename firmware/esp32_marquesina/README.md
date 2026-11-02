# Firmware ESP32-C3 — 3 marquesinas sobre un mismo montaje

Arduino IDE · placa **ESP32C3 Dev Module** (núcleo esp32 3.x) · *USB CDC On Boot: Enabled*.
Librerías: PubSubClient 2.8, ArduinoJson 7.x, DHT sensor library 1.4.x, RTClib 2.1.x.

## Archivos locales (no se versionan)
1. `secrets.h` ← copia de `secrets.h.example` (WiFi de la Raspberry, usuarios MQTT, NTP).
2. `ca_fog.h` ← copia de `ca_fog.h.example` con el certificado público de la CA de la finca
   (se genera en la Raspberry, Fase 2). Sin él el firmware no intenta conectarse al NanoMQ.

`ca_nube.h` (ISRG Root X1) sí se versiona: es público y solo se usa en `MODO_PRUEBA_NUBE`.

## Comandos (`cafe/<id>/cmd`)
| JSON | Efecto |
|---|---|
| `{"cmd":"leer_ahora"}` | publica ya (`m:"f"`) |
| `{"cmd":"banda","activa":false}` | sin banda muerta: publica cada periodo (`m:"p"`) |
| `{"cmd":"banda","activa":true,"temp":0.3,"hr":1,"luz_pct":15,"co":5}` | umbrales de la banda muerta |
| `{"cmd":"latido","valor":300}` | publicación mínima aunque no haya cambios (`m:"l"`) |
| `{"cmd":"periodo","valor":10}` | muestreo de sensores (todas las marquesinas) |
| `{"cmd":"estado"}` / `{"cmd":"calibrar_mq7"}` / `{"cmd":"reiniciar"}` | |

## Prueba realizada (02/11/2026, modo prueba contra mqtt.agrotecnet.cloud)
- 3 conexiones TLS simultáneas: ~42 KB de heap cada una; heap libre final ~75 KB.
- Comandos `leer_ahora` y `banda` recibidos y aplicados por marquesina.
- Log: `docs/evidencias/fase1_serial_3_conexiones_tls.log`.

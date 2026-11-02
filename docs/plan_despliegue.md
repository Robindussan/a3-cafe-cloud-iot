# Plan de despliegue — IaC, CI/CD, OTA y modelos

## 1. Infraestructura como código (IaC)
Todo lo que corre está descrito en archivos versionados; los secretos quedan fuera (`*.example`).

| Capa | Archivo | Qué define |
|---|---|---|
| Nube (VPS) | `cloud/stacks/*.yml` | EMQX 6.3.1, Node-RED 5.0.8, TimescaleDB 2.30.2-pg16, NPM 2.16.0 en la red `iot_network` |
| Nube | `cloud/emqx/acl.conf`, `usuarios.csv.example` | autorización de mínimo privilegio y usuarios (hash) |
| Nube | `cloud/timescale/01_esquema.sql`, `02_roles.sql` | hypertables, compresión, retención y roles |
| Nube | `cloud/nodered/flujos_a3.js` + `instalar_flujos.js` | flujos como código (ingesta, estado, alertas, anomalías) |
| Nube | `services/panel`, `services/anomalias` | imágenes propias con versión fija |
| Fog | `fog/stacks/*.yml`, `fog/nanomq/*`, `fog/red/configurar_red.sh` | NanoMQ, PostgreSQL, punto de acceso y aislamiento |
| Fog | `fog/pki/crear_pki.sh` | CA de la finca y certificado del broker local |
| Edge | `firmware/esp32_marquesina` | firmware y configuración (`secrets.h.example`) |

Todas las imágenes tienen etiqueta exacta (no `latest`): una reconstrucción produce el mismo sistema.
Para replicar una finca nueva basta con: instalar Raspberry Pi OS + Docker, copiar `fog/`, ejecutar
`crear_pki.sh` y `configurar_red.sh`, y levantar los stacks.

## 2. CI/CD (`.github/workflows/ci-cd.yml`)
1. **secretos** — gitleaks y bloqueo de archivos sensibles (`secrets.h`, `.env`, `*.key`).
2. **revisar** — sintaxis de Python, de los flujos de Node-RED y del JavaScript del panel.
3. **firmware** — compila el ESP32-C3 con `arduino-cli` (secretos de ejemplo) y guarda el `.bin` como artefacto.
4. **imagenes** — construye panel y anomalías; en `main` las publica en GHCR con el SHA del commit.
5. **desplegar** — solo en `main` y con aprobación manual (environment `produccion`): copia por SSH y
   ejecuta `cloud/scripts/desplegar.sh` (actualiza servicios, reinstala flujos y verifica que el panel responda).

## 3. Actualización OTA del firmware por etapas
El ESP32-C3 usa la tabla de particiones por defecto con **dos ranuras de aplicación** (`ota_0` / `ota_1`):
se escribe la ranura inactiva y, si el nuevo firmware no confirma su arranque, el gestor de arranque
vuelve al anterior (*rollback*).

1. **Publicación**: el `.bin` del job *firmware* se firma (SHA-256) y se publica en un servidor HTTPS del VPS
   (p. ej. `https://ota.agrotecnet.cloud/esp32/3.0.5.bin`).
2. **Orden**: Node-RED envía por MQTT `cafe/<id>/cmd` → `{"cmd":"ota","url":"…","sha256":"…","version":"3.0.5"}`.
   El nodo descarga por HTTPS verificando el certificado, comprueba el SHA-256, escribe la ranura inactiva y reinicia.
3. **Confirmación**: al arrancar publica `estado` con `fw = 3.0.5`; si en 5 min no logra conectarse al broker,
   no marca la imagen como válida y el siguiente reinicio vuelve a la versión anterior.
4. **Etapas** (anillos):

| Etapa | Alcance | Condición para avanzar |
|---|---|---|
| Canario | 1 marquesina (`marquesina-01`) | 24 h en línea, SLI-2 ≥ 99 %, sin anomalías nuevas atribuibles al firmware |
| Piloto | 10 % de las marquesinas (1 finca por zona) | 48 h sin aumento de alertas `sin_datos` ni de latencia p95 |
| General | resto, por lotes de 20 % | mismo criterio por lote; se detiene si se agota el presupuesto de error |

En el fog la actualización del NanoMQ/Node-RED se hace cambiando la etiqueta de la imagen en
`fog/stacks/*.yml` y aplicando por SSH, finca por finca, con el mismo esquema de anillos.

## 4. Despliegue de modelos (anomalías y, a futuro, tiempo de secado)
- El modelo es un contenedor con versión (`agrotecnet/anomalias-cafe:1.0.0`); sus parámetros
  (ventana 60, umbral z = 3) quedan en la imagen y en el campo `metodo` de cada anomalía (`zscore_v60_u3`),
  así cada resultado es trazable a la versión que lo produjo.
- **Entrenamiento**: el admin descarga el dataset (`/admin/dataset.csv`, con etiquetas de alerta y anomalía),
  entrena fuera de línea (p. ej. Isolation Forest o un regresor de tiempo de secado) y versiona el modelo.
- **Despliegue sombra**: la versión nueva corre en paralelo publicando en `cafe/<id>/anomalia_v2`, sin generar
  alertas; se comparan tasas de anomalías y falsos positivos contra la versión vigente durante 7 días.
- **Promoción**: si mejora, se cambia la etiqueta en `services/anomalias/docker-compose.yml` y el CI/CD la
  despliega; volver atrás es reponer la etiqueta anterior.

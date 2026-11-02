# Panel web — panel.agrotecnet.cloud

FastAPI + Jinja2 + Apache ECharts + Three.js (gemelo digital en WebGL). Lee TimescaleDB con el
rol `app_panel`. Un solo contenedor sin puertos publicados; Nginx Proxy Manager lo publica con HTTPS.

| Perfil | Ve | Puede |
|---|---|---|
| admin | todas las marquesinas | usuarios, umbrales, reconocer alertas, descargar el dataset CSV |
| tecnico | todas las marquesinas, alertas, latencia | reconocer alertas |
| caficultor | solo sus marquesinas asignadas | consultar gemelo e histórico |

## Seguridad
- bcrypt (costo 12), bloqueo de 15 min tras 5 intentos, sesión firmada (HttpOnly, Secure, SameSite=Lax, 8 h).
- Token CSRF en todos los formularios POST; autorización en el servidor en cada ruta y API
  (una marquesina ajena responde 404).
- CSP `script-src 'self'`: ECharts y Three.js se descargan al construir la imagen y se sirven desde el panel.
- Contenedor de solo lectura, usuario sin privilegios (uid 10001).

## Gemelo digital (`app/static/js/gemelo.js`)
Marquesina de 8 × 4 m en alambrado: muros de 1,1 m, techo en arco de plástico, dos camas elevadas con el
café pergamino, estufa de apoyo y el nodo sensor. Temperatura → color/velocidad del aire caliente;
humedad → color del café; lux → sol y rayos; CO → humo de la estufa; estado → pulso del nodo.

## Despliegue (VPS)
```bash
# /root/a3_secretos/panel.env con PG_USER=app_panel, PG_PASS y SESSION_SECRET (ver panel.env.example)
cd /opt/a3/panel && docker compose -p panel up -d --build
docker exec -it panel python crear_usuario.py robin "Robin Dussán" admin
docker exec -it panel python crear_usuario.py caficultor1 "Caficultor 1" caficultor marquesina-01
```
NPM: proxy host `panel.agrotecnet.cloud` → `http://panel:8000`, Let's Encrypt, Force SSL, HTTP/2.

## Dataset para ML
`/admin/dataset.csv?desde=AAAA-MM-DDTHH:MM&hasta=...&marquesinas=...` (solo admin), en streaming con
cursor de servidor. Columnas: lecturas crudas, latencia, `fuera_*` (umbral vigente), `alerta_*`
(alerta registrada dentro de los 60 s siguientes) y `anomalia`.

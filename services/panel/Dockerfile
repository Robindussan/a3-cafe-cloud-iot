FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY crear_usuario.py .

# Librerías del navegador servidas desde el propio panel (la CSP solo permite 'self').
# OrbitControls importa 'three' como módulo desnudo: se reescribe a la ruta local.
RUN python - <<'PY'
import os, urllib.request
d = "app/static/vendor"; os.makedirs(d, exist_ok=True)
archivos = {
    "echarts.min.js": "https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js",
    "three.module.min.js": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js",
    "OrbitControls.js": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js",
}
for nombre, url in archivos.items():
    datos = urllib.request.urlopen(url, timeout=60).read().decode()
    if nombre == "OrbitControls.js":
        datos = datos.replace("from 'three'", "from './three.module.min.js'")
    open(os.path.join(d, nombre), "w").write(datos)
    print(nombre, len(datos), "bytes")
PY

RUN useradd --uid 10001 --no-create-home panel
USER panel
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--workers", "2"]

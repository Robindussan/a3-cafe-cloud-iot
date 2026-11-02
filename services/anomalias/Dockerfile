FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir "paho-mqtt==2.1.0" "psycopg[binary]==3.2.3"
WORKDIR /srv
COPY anomalias.py medir_optimizacion.py ./
RUN useradd --uid 10002 --no-create-home anomalias
USER anomalias
CMD ["python", "anomalias.py"]

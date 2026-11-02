-- ============================================================================
-- A3 · Secado de café · Esquema de TimescaleDB (base iot_db)
-- Se puede ejecutar varias veces: crea solo lo que falta.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------- Catálogo
CREATE TABLE IF NOT EXISTS marquesinas (
    id          text PRIMARY KEY,                 -- marquesina-01 ...
    nombre      text NOT NULL,
    finca       text,
    asociado    text,
    creado      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Telemetría (serie de tiempo)
-- ts         : hora de la lectura en el nodo (ESP32, ms UTC)
-- ts_ingesta : hora en que Node-RED la escribe -> latencia de extremo a extremo
CREATE TABLE IF NOT EXISTS telemetria (
    ts          timestamptz NOT NULL,
    ts_ingesta  timestamptz NOT NULL DEFAULT now(),
    marquesina  text        NOT NULL,
    seq         integer,
    temp        real,
    hr          real,
    lux         integer,
    co          real,
    rssi        smallint,
    motivo      char(1),                          -- c cambio, l latido, p periódico, f forzado
    latencia_ms integer GENERATED ALWAYS AS
                ((EXTRACT(EPOCH FROM (ts_ingesta - ts)) * 1000)::integer) STORED
);
SELECT create_hypertable('telemetria', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetria_marquesina_ts ON telemetria (marquesina, ts DESC);
-- Evita duplicados cuando el bridge reenvía mensajes guardados (store-and-forward)
CREATE UNIQUE INDEX IF NOT EXISTS telemetria_unica ON telemetria (marquesina, ts, seq);

ALTER TABLE telemetria SET (timescaledb.compress, timescaledb.compress_segmentby = 'marquesina',
                            timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('telemetria', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('telemetria', INTERVAL '365 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------- Estado online/offline
CREATE TABLE IF NOT EXISTS estado (
    marquesina   text PRIMARY KEY,
    estado       text NOT NULL,                   -- online / offline
    desde        timestamptz NOT NULL DEFAULT now(),
    ultimo_dato  timestamptz,
    info         jsonb,                           -- fw, ip, rssi, heap, banda, latido...
    actualizado  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eventos_estado (
    ts          timestamptz NOT NULL DEFAULT now(),
    marquesina  text        NOT NULL,
    estado      text        NOT NULL
);
SELECT create_hypertable('eventos_estado', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE);

-- ---------------------------------------------------------------- Umbrales de alerta
-- marquesina = '*' es el valor por defecto; una fila por marquesina lo reemplaza.
CREATE TABLE IF NOT EXISTS umbrales (
    marquesina      text PRIMARY KEY,
    temp_max        real    NOT NULL DEFAULT 50,  -- sobresecado / daño del grano
    temp_min        real,                         -- opcional
    hr_max          real    NOT NULL DEFAULT 65,  -- secado lento / riesgo de hongos
    hr_solo_dia     boolean NOT NULL DEFAULT true,-- HR solo se evalúa con luz (lux >= lux_dia)
    lux_dia         integer NOT NULL DEFAULT 1000,
    co_max          real    NOT NULL DEFAULT 35,  -- ppm (quemador / estufa de apoyo)
    offline_min     integer NOT NULL DEFAULT 12,  -- > 2 latidos de 5 min
    antirebote_min  integer NOT NULL DEFAULT 10,
    actualizado     timestamptz NOT NULL DEFAULT now(),
    actualizado_por text
);
INSERT INTO umbrales (marquesina, actualizado_por) VALUES ('*', 'esquema') ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- Alertas
CREATE TABLE IF NOT EXISTS alertas (
    id          bigserial,
    ts          timestamptz NOT NULL DEFAULT now(),
    marquesina  text        NOT NULL,
    tipo        text        NOT NULL,             -- temp_alta, temp_baja, hr_alta, co_alto, offline
    valor       real,
    umbral      real,
    mensaje     text        NOT NULL,
    whatsapp    boolean     NOT NULL DEFAULT false,-- true si CallMeBot respondió OK
    reconocida  boolean     NOT NULL DEFAULT false,
    reconocida_por text,
    PRIMARY KEY (id, ts)
);
SELECT create_hypertable('alertas', by_range('ts', INTERVAL '30 days'), if_not_exists => TRUE);
ALTER TABLE alertas ADD COLUMN IF NOT EXISTS telegram boolean NOT NULL DEFAULT false;  -- true si Telegram confirmó

-- ---------------------------------------------------------------- Anomalías (servicio Python)
CREATE TABLE IF NOT EXISTS anomalias (
    ts          timestamptz NOT NULL,
    marquesina  text        NOT NULL,
    variable    text        NOT NULL,
    valor       real,
    puntaje     real,                             -- puntaje z u otro
    metodo      text        NOT NULL
);
SELECT create_hypertable('anomalias', by_range('ts', INTERVAL '30 days'), if_not_exists => TRUE);

-- ---------------------------------------------------------------- Usuarios del panel web
CREATE TABLE IF NOT EXISTS usuarios (
    id                bigserial PRIMARY KEY,
    usuario           text UNIQUE NOT NULL,
    nombre            text NOT NULL,
    rol               text NOT NULL CHECK (rol IN ('admin', 'tecnico', 'caficultor')),
    hash              text NOT NULL,              -- bcrypt
    activo            boolean NOT NULL DEFAULT true,
    intentos_fallidos integer NOT NULL DEFAULT 0,
    bloqueado_hasta   timestamptz,
    ultimo_ingreso    timestamptz,
    creado            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usuario_marquesina (
    usuario_id  bigint REFERENCES usuarios(id) ON DELETE CASCADE,
    marquesina  text   REFERENCES marquesinas(id) ON DELETE CASCADE,
    PRIMARY KEY (usuario_id, marquesina)
);

INSERT INTO marquesinas (id, nombre, finca, asociado) VALUES
    ('marquesina-01', 'Marquesina 1', 'Finca piloto', 'Asociado 1'),
    ('marquesina-02', 'Marquesina 2', 'Finca piloto', 'Asociado 2'),
    ('marquesina-03', 'Marquesina 3', 'Finca piloto', 'Asociado 3')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- Vistas para el panel y el monitoreo
CREATE OR REPLACE VIEW ultima_lectura AS
SELECT DISTINCT ON (marquesina) marquesina, ts, temp, hr, lux, co, rssi, latencia_ms
FROM telemetria ORDER BY marquesina, ts DESC;

-- Latencia de extremo a extremo (nodo -> base de datos) por hora
CREATE OR REPLACE VIEW latencia_por_hora AS
SELECT time_bucket('1 hour', ts) AS hora, marquesina, count(*) AS mensajes,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY latencia_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms) AS p95_ms
FROM telemetria GROUP BY 1, 2;

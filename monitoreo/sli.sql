-- ============================================================================
-- A3 · Monitoreo: latencia de extremo a extremo y SLI/SLO (las mismas consultas usa el panel, /api/sli)
-- latencia_ms = ts_ingesta (Node-RED escribe en TimescaleDB) - ts (lectura en el ESP32)
-- ============================================================================

-- Latencia p50 / p95 de las últimas 24 h, total y por marquesina
SELECT marquesina, count(*) AS mensajes,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY latencia_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms) AS p95_ms
FROM telemetria WHERE ts > now() - interval '24 hours' AND latencia_ms >= 0
GROUP BY ROLLUP (marquesina) ORDER BY marquesina NULLS LAST;

-- SLI-1 (frescura): % de lecturas que llegan a la base en menos de 2 s.   SLO: 95 % en 7 días.
SELECT 100.0 * count(*) FILTER (WHERE latencia_ms < 2000) / count(*) AS sli_latencia_pct
FROM telemetria WHERE ts > now() - interval '7 days' AND latencia_ms >= 0;

-- SLI-2 (disponibilidad): % de ventanas de 10 min con al menos una lectura, por marquesina.
-- SLO: 99 % mensual. 10 min = 2 latidos de la banda muerta (5 min), así una marquesina estable cumple.
WITH ventanas AS (
  SELECT generate_series(time_bucket('10 minutes', GREATEST(now() - interval '30 days', (SELECT min(ts) FROM telemetria))),
                         time_bucket('10 minutes', now()) - interval '10 minutes', interval '10 minutes') AS b),
con_datos AS (SELECT DISTINCT marquesina, time_bucket('10 minutes', ts) AS b FROM telemetria
              WHERE ts > now() - interval '30 days 10 minutes')
SELECT m.id, count(*) AS ventanas, count(c.b) AS con_datos, 100.0 * count(c.b) / count(*) AS sli_disponibilidad_pct
FROM marquesinas m CROSS JOIN ventanas v LEFT JOIN con_datos c ON c.marquesina = m.id AND c.b = v.b
GROUP BY m.id ORDER BY m.id;

-- Presupuesto de error restante = (SLI - SLO) / (100 - SLO). Ej.: SLI 99,07 % y SLO 95 % -> 81,4 %.

-- Pérdidas por tramo: huecos en la secuencia seq de cada marquesina (mensajes que no llegaron)
SELECT marquesina, sum(GREATEST(seq - lag_seq - 1, 0)) AS perdidos
FROM (SELECT marquesina, seq, lag(seq) OVER (PARTITION BY marquesina ORDER BY ts) AS lag_seq
      FROM telemetria WHERE ts > now() - interval '24 hours') s
WHERE lag_seq IS NOT NULL AND seq > lag_seq GROUP BY marquesina;

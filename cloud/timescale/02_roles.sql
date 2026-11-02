-- ============================================================================
-- A3 · Roles de mínimo privilegio. Las claves se pasan con psql -v (no se versionan):
--   psql -v pw_nodered=... -v pw_panel=... -v pw_anomalias=... -f 02_roles.sql
-- ============================================================================
SELECT format('CREATE ROLE %I LOGIN', r) FROM unnest(ARRAY['app_nodered','app_panel','app_anomalias']) r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

ALTER ROLE app_nodered   PASSWORD :'pw_nodered';
ALTER ROLE app_panel     PASSWORD :'pw_panel';
ALTER ROLE app_anomalias PASSWORD :'pw_anomalias';

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_nodered, app_panel, app_anomalias;

-- Node-RED: escribe telemetría, estado y alertas; lee umbrales
GRANT SELECT, INSERT           ON telemetria, eventos_estado, alertas TO app_nodered;
GRANT SELECT, INSERT, UPDATE   ON estado TO app_nodered;
GRANT SELECT                   ON umbrales, marquesinas, ultima_lectura, latencia_por_hora TO app_nodered;
GRANT USAGE                    ON SEQUENCE alertas_id_seq TO app_nodered;

-- Panel web: lee todo; administra usuarios, umbrales y marquesinas; reconoce alertas
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_panel;
GRANT INSERT, UPDATE, DELETE ON usuarios, usuario_marquesina, umbrales, marquesinas TO app_panel;
GRANT UPDATE (reconocida, reconocida_por) ON alertas TO app_panel;
GRANT USAGE ON SEQUENCE usuarios_id_seq TO app_panel;

-- Servicio de anomalías: lee telemetría y escribe anomalías
GRANT SELECT ON telemetria TO app_anomalias;
GRANT INSERT, SELECT ON anomalias TO app_anomalias;

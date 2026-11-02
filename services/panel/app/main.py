"""Panel web del secado de café (panel.agrotecnet.cloud).

Páginas: resumen, detalle de marquesina con gemelo digital e histórico, alertas y, para el
administrador, usuarios, umbrales y descarga del dataset para machine learning.
"""
import csv
import io
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from psycopg.rows import tuple_row
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.sessions import SessionMiddleware

from . import auth, db
from .auth import NOMBRES_ROL, ROLES, NoAutenticado, requiere_rol, usuario_actual

BASE = os.path.dirname(__file__)
TZ_COLOMBIA = timezone(timedelta(hours=-5))


@asynccontextmanager
async def ciclo_de_vida(app):
    await db.pool.open()
    yield
    await db.pool.close()


app = FastAPI(title="Panel secado de café", lifespan=ciclo_de_vida, docs_url=None, redoc_url=None,
              openapi_url=None)
app.add_middleware(SessionMiddleware, secret_key=os.environ["SESSION_SECRET"],
                   session_cookie="panel_sesion", max_age=auth.SESION_S, same_site="lax",
                   https_only=os.environ.get("COOKIE_SEGURA", "1") == "1")
# Conexiones rurales lentas: comprimir (ECharts 1 MB -> ~330 KB) y cachear los estáticos.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)
app.mount("/static", StaticFiles(directory=os.path.join(BASE, "static")), name="static")
plantillas = Jinja2Templates(directory=os.path.join(BASE, "templates"))
plantillas.env.globals["NOMBRES_ROL"] = NOMBRES_ROL


@app.middleware("http")
async def cabeceras_seguridad(request: Request, call_next):
    r = await call_next(request)
    r.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; "
        "form-action 'self'")
    r.headers["X-Content-Type-Options"] = "nosniff"
    r.headers["Referrer-Policy"] = "same-origin"
    r.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/static/"):
        # vendor/ no cambia entre versiones de la imagen; css/js propios se revalidan a diario
        r.headers["Cache-Control"] = "public, max-age=604800, immutable" if "/vendor/" in request.url.path \
            else "public, max-age=3600"
    return r


@app.exception_handler(NoAutenticado)
async def al_no_autenticado(request: Request, exc):
    if request.url.path.startswith("/api/") or request.url.path.endswith(".csv"):
        return JSONResponse({"error": "sesión expirada"}, status_code=401)
    return RedirectResponse("/login", status_code=303)


def pagina(request: Request, plantilla: str, u: dict | None, **datos):
    return plantillas.TemplateResponse(request, plantilla, {
        "u": u, "csrf": auth.token_csrf(request), "ruta": request.url.path, **datos})


# ============================================================================ Login
@app.get("/login", response_class=HTMLResponse)
async def ver_login(request: Request):
    if request.session.get("u"):
        return RedirectResponse("/", status_code=303)
    return pagina(request, "login.html", None, error=None)


@app.post("/login")
async def hacer_login(request: Request, usuario: str = Form(...), clave: str = Form(...),
                      csrf: str = Form("")):
    auth.validar_csrf(request, csrf)
    datos, error = await auth.autenticar(usuario, clave)
    if error:
        return pagina(request, "login.html", None, error=error, usuario=usuario)
    request.session.clear()
    request.session["u"] = datos
    return RedirectResponse("/", status_code=303)


@app.get("/logout")
async def salir(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


# ============================================================================ Páginas
@app.get("/", response_class=HTMLResponse)
async def resumen(request: Request, u: dict = Depends(usuario_actual)):
    visibles = await auth.marquesinas_visibles(u)
    marquesinas = await db.filas("SELECT * FROM marquesinas WHERE id = ANY(%s) ORDER BY id", (visibles,))
    return pagina(request, "resumen.html", u, marquesinas=marquesinas)


@app.get("/marquesina/{mid}", response_class=HTMLResponse)
async def detalle(mid: str, request: Request, u: dict = Depends(usuario_actual)):
    await auth.exigir_acceso(u, mid)
    m = await db.fila("SELECT * FROM marquesinas WHERE id = %s", (mid,))
    return pagina(request, "marquesina.html", u, m=m)


@app.get("/alertas", response_class=HTMLResponse)
async def alertas(request: Request, u: dict = Depends(usuario_actual)):
    visibles = await auth.marquesinas_visibles(u)
    lista = await db.filas(
        """SELECT id, ts, marquesina, tipo, valor, umbral, mensaje, whatsapp, telegram,
                  reconocida, reconocida_por
           FROM alertas WHERE marquesina = ANY(%s) ORDER BY ts DESC LIMIT 300""", (visibles,))
    return pagina(request, "alertas.html", u, alertas=lista, tz=TZ_COLOMBIA)


@app.post("/alertas/{aid}/reconocer")
async def reconocer(aid: int, request: Request, csrf: str = Form(""),
                    u: dict = Depends(requiere_rol("admin", "tecnico"))):
    auth.validar_csrf(request, csrf)
    await db.ejecutar("UPDATE alertas SET reconocida = true, reconocida_por = %s WHERE id = %s",
                      (u["usuario"], aid))
    return RedirectResponse("/alertas", status_code=303)


# ============================================================================ Administración
RE_USUARIO = re.compile(r"^[a-z0-9._-]{3,32}$")


@app.get("/admin/usuarios", response_class=HTMLResponse)
async def usuarios(request: Request, u: dict = Depends(requiere_rol("admin")), aviso: str = ""):
    lista = await db.filas(
        """SELECT u.*, COALESCE(array_agg(um.marquesina ORDER BY um.marquesina)
                  FILTER (WHERE um.marquesina IS NOT NULL), '{}') AS marquesinas
           FROM usuarios u LEFT JOIN usuario_marquesina um ON um.usuario_id = u.id
           GROUP BY u.id ORDER BY u.rol, u.usuario""")
    todas = await db.filas("SELECT id, nombre FROM marquesinas ORDER BY id")
    return pagina(request, "admin_usuarios.html", u, usuarios=lista, todas=todas, roles=ROLES,
                  aviso=aviso, tz=TZ_COLOMBIA)


async def _asignar_marquesinas(uid: int, marquesinas: list[str]):
    await db.ejecutar("DELETE FROM usuario_marquesina WHERE usuario_id = %s", (uid,))
    for m in marquesinas:
        await db.ejecutar("INSERT INTO usuario_marquesina VALUES (%s, %s) ON CONFLICT DO NOTHING", (uid, m))


@app.post("/admin/usuarios")
async def crear_usuario(request: Request, u: dict = Depends(requiere_rol("admin"))):
    f = await request.form()
    auth.validar_csrf(request, f.get("csrf", ""))
    usuario, nombre, rol, clave = (f.get("usuario", "").strip().lower(), f.get("nombre", "").strip(),
                                   f.get("rol", ""), f.get("clave", ""))
    if not RE_USUARIO.match(usuario) or not nombre or rol not in ROLES or len(clave) < 10:
        return RedirectResponse("/admin/usuarios?aviso=Datos+inválidos:+usuario+3-32+caracteres+"
                                "(a-z,+0-9,+.+_+-)+y+clave+de+10+o+más", status_code=303)
    if await db.fila("SELECT 1 FROM usuarios WHERE usuario = %s", (usuario,)):
        return RedirectResponse("/admin/usuarios?aviso=Ese+usuario+ya+existe", status_code=303)
    nuevo = await db.fila("INSERT INTO usuarios (usuario, nombre, rol, hash) VALUES (%s, %s, %s, %s) "
                          "RETURNING id", (usuario, nombre, rol, auth.hash_clave(clave)))
    await _asignar_marquesinas(nuevo["id"], f.getlist("marquesinas") if rol == "caficultor" else [])
    return RedirectResponse("/admin/usuarios?aviso=Usuario+creado", status_code=303)


@app.post("/admin/usuarios/{uid}")
async def actualizar_usuario(uid: int, request: Request, u: dict = Depends(requiere_rol("admin"))):
    f = await request.form()
    auth.validar_csrf(request, f.get("csrf", ""))
    rol, activo, clave = f.get("rol", ""), f.get("activo") == "on", f.get("clave", "")
    if rol not in ROLES:
        raise HTTPException(400, "Rol inválido")
    if uid == u["id"] and (rol != "admin" or not activo):
        return RedirectResponse("/admin/usuarios?aviso=No+puede+quitarse+a+sí+mismo+el+perfil+admin",
                                status_code=303)
    await db.ejecutar("UPDATE usuarios SET rol = %s, activo = %s, intentos_fallidos = 0, "
                      "bloqueado_hasta = NULL WHERE id = %s", (rol, activo, uid))
    if clave:
        if len(clave) < 10:
            return RedirectResponse("/admin/usuarios?aviso=La+clave+debe+tener+10+o+más+caracteres",
                                    status_code=303)
        await db.ejecutar("UPDATE usuarios SET hash = %s WHERE id = %s", (auth.hash_clave(clave), uid))
    await _asignar_marquesinas(uid, f.getlist("marquesinas") if rol == "caficultor" else [])
    return RedirectResponse("/admin/usuarios?aviso=Usuario+actualizado", status_code=303)


@app.post("/admin/usuarios/{uid}/eliminar")
async def eliminar_usuario(uid: int, request: Request, csrf: str = Form(""),
                           u: dict = Depends(requiere_rol("admin"))):
    auth.validar_csrf(request, csrf)
    if uid == u["id"]:
        return RedirectResponse("/admin/usuarios?aviso=No+puede+eliminarse+a+sí+mismo", status_code=303)
    await db.ejecutar("DELETE FROM usuarios WHERE id = %s", (uid,))
    return RedirectResponse("/admin/usuarios?aviso=Usuario+eliminado", status_code=303)


CAMPOS_UMBRAL = ("temp_max", "temp_min", "hr_max", "lux_dia", "co_max", "offline_min", "antirebote_min")


@app.get("/admin/umbrales", response_class=HTMLResponse)
async def umbrales(request: Request, u: dict = Depends(requiere_rol("admin")), aviso: str = ""):
    filas = await db.filas("SELECT * FROM umbrales ORDER BY marquesina <> '*', marquesina")
    todas = await db.filas("SELECT id, nombre FROM marquesinas ORDER BY id")
    return pagina(request, "admin_umbrales.html", u, filas=filas, todas=todas, aviso=aviso, tz=TZ_COLOMBIA)


@app.post("/admin/umbrales")
async def guardar_umbral(request: Request, u: dict = Depends(requiere_rol("admin"))):
    f = await request.form()
    auth.validar_csrf(request, f.get("csrf", ""))
    marquesina = f.get("marquesina", "")
    if marquesina != "*" and not await db.fila("SELECT 1 FROM marquesinas WHERE id = %s", (marquesina,)):
        raise HTTPException(400, "Marquesina inválida")
    if f.get("accion") == "eliminar" and marquesina != "*":
        await db.ejecutar("DELETE FROM umbrales WHERE marquesina = %s", (marquesina,))
        return RedirectResponse("/admin/umbrales?aviso=Se+usarán+los+valores+por+defecto", status_code=303)
    valores = {}
    try:
        for c in CAMPOS_UMBRAL:
            v = f.get(c, "").strip().replace(",", ".")
            valores[c] = (float(v) if c not in ("lux_dia", "offline_min", "antirebote_min") else int(float(v))) if v else None
    except ValueError:
        return RedirectResponse("/admin/umbrales?aviso=Valores+numéricos+inválidos", status_code=303)
    for c in ("temp_max", "hr_max", "lux_dia", "co_max", "offline_min", "antirebote_min"):
        if valores[c] is None:
            return RedirectResponse(f"/admin/umbrales?aviso=Falta+{c}", status_code=303)
    await db.ejecutar(
        f"""INSERT INTO umbrales (marquesina, {', '.join(CAMPOS_UMBRAL)}, hr_solo_dia, actualizado, actualizado_por)
            VALUES (%s, {', '.join(['%s'] * len(CAMPOS_UMBRAL))}, %s, now(), %s)
            ON CONFLICT (marquesina) DO UPDATE SET
            {', '.join(f'{c} = EXCLUDED.{c}' for c in CAMPOS_UMBRAL)},
            hr_solo_dia = EXCLUDED.hr_solo_dia, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por""",
        (marquesina, *[valores[c] for c in CAMPOS_UMBRAL], f.get("hr_solo_dia") == "on", u["usuario"]))
    return RedirectResponse("/admin/umbrales?aviso=Umbrales+guardados+(Node-RED+los+aplica+en+menos+de+1+min)",
                            status_code=303)


# ============================================================================ Dataset para ML
@app.get("/admin/dataset", response_class=HTMLResponse)
async def dataset(request: Request, u: dict = Depends(requiere_rol("admin"))):
    rango = await db.fila("SELECT min(ts) AS desde, max(ts) AS hasta, count(*) AS filas FROM telemetria")
    por_m = await db.filas("SELECT marquesina, count(*) AS filas FROM telemetria GROUP BY 1 ORDER BY 1")
    todas = await db.filas("SELECT id, nombre FROM marquesinas ORDER BY id")
    return pagina(request, "admin_dataset.html", u, rango=rango, por_m=por_m, todas=todas, tz=TZ_COLOMBIA)


COLUMNAS_DATASET = ["ts_utc", "ts_local", "marquesina", "seq", "temp", "hr", "lux", "co", "rssi",
                    "motivo", "latencia_ms", "fuera_temp_max", "fuera_hr_max", "fuera_co_max",
                    "alerta_temp_alta", "alerta_hr_alta", "alerta_co_alto", "alerta_cualquiera",
                    "anomalia", "anomalia_variables"]

SQL_DATASET = """
SELECT t.ts, t.marquesina, t.seq, t.temp, t.hr, t.lux, t.co, t.rssi, t.motivo, t.latencia_ms,
       t.temp > COALESCE(um.temp_max, ud.temp_max)                               AS fuera_temp_max,
       t.hr   > COALESCE(um.hr_max, ud.hr_max)
         AND (NOT COALESCE(um.hr_solo_dia, ud.hr_solo_dia) OR t.lux >= COALESCE(um.lux_dia, ud.lux_dia)) AS fuera_hr_max,
       t.co   > COALESCE(um.co_max, ud.co_max)                                   AS fuera_co_max,
       COALESCE(a.temp_alta, false), COALESCE(a.hr_alta, false), COALESCE(a.co_alto, false),
       COALESCE(a.cualquiera, false), an.variables IS NOT NULL, an.variables
FROM telemetria t
CROSS JOIN (SELECT * FROM umbrales WHERE marquesina = '*') ud
LEFT JOIN umbrales um ON um.marquesina = t.marquesina
LEFT JOIN LATERAL (
    SELECT bool_or(tipo = 'temp_alta') AS temp_alta, bool_or(tipo = 'hr_alta') AS hr_alta,
           bool_or(tipo = 'co_alto') AS co_alto, bool_or(true) AS cualquiera
    FROM alertas al WHERE al.marquesina = t.marquesina
      AND al.ts >= t.ts AND al.ts < t.ts + interval '60 seconds'
      AND al.tipo IN ('temp_alta', 'hr_alta', 'co_alto')) a ON true
LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT variable, '|') AS variables FROM anomalias x
    WHERE x.marquesina = t.marquesina AND x.ts = t.ts) an ON true
WHERE t.ts >= %s AND t.ts < %s AND t.marquesina = ANY(%s)
ORDER BY t.ts, t.marquesina
"""


def _fecha(valor: str, defecto: datetime) -> datetime:
    if not valor:
        return defecto
    try:
        return datetime.fromisoformat(valor).replace(tzinfo=TZ_COLOMBIA)
    except ValueError:
        raise HTTPException(400, "Fecha inválida")


@app.get("/admin/dataset.csv")
async def descargar_dataset(request: Request, desde: str = "", hasta: str = "",
                            u: dict = Depends(requiere_rol("admin"))):
    ahora = datetime.now(TZ_COLOMBIA)
    t0, t1 = _fecha(desde, ahora - timedelta(days=30)), _fecha(hasta, ahora + timedelta(minutes=1))
    pedidas = request.query_params.getlist("marquesinas")
    todas = [r["id"] for r in await db.filas("SELECT id FROM marquesinas")]
    marquesinas = [m for m in pedidas if m in todas] or todas

    async def generar():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(COLUMNAS_DATASET)
        yield buf.getvalue()
        async with db.pool.connection() as conn:
            async with conn.cursor(name="dataset", row_factory=tuple_row) as cur:
                await cur.execute(SQL_DATASET, (t0, t1, marquesinas))
                while lote := await cur.fetchmany(2000):
                    buf.seek(0)
                    buf.truncate()
                    for r in lote:
                        ts = r[0]
                        w.writerow([ts.isoformat(), ts.astimezone(TZ_COLOMBIA).isoformat(), *r[1:10],
                                    *[int(bool(x)) for x in r[10:18]], r[18] or ""])
                    yield buf.getvalue()

    nombre = f"dataset_secado_cafe_{t0:%Y%m%d}_{t1:%Y%m%d}.csv"
    return StreamingResponse(generar(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{nombre}"'})


# ============================================================================ API JSON
@app.get("/api/resumen")
async def api_resumen(u: dict = Depends(usuario_actual)):
    visibles = await auth.marquesinas_visibles(u)
    filas = await db.filas(
        """SELECT m.id, m.nombre, m.finca, m.asociado, e.estado, e.desde, e.ultimo_dato, e.info,
                  l.ts, l.temp, l.hr, l.lux, l.co, l.rssi, l.latencia_ms,
                  (SELECT count(*) FROM alertas a WHERE a.marquesina = m.id
                     AND a.ts > now() - interval '24 hours') AS alertas_24h,
                  (SELECT count(*) FROM alertas a WHERE a.marquesina = m.id AND NOT a.reconocida
                     AND a.ts > now() - interval '7 days') AS alertas_abiertas
           FROM marquesinas m
           LEFT JOIN estado e ON e.marquesina = m.id
           LEFT JOIN LATERAL (SELECT * FROM telemetria t WHERE t.marquesina = m.id
                              ORDER BY ts DESC LIMIT 1) l ON true
           WHERE m.id = ANY(%s) ORDER BY m.id""", (visibles,))
    umbral = await db.fila("SELECT * FROM umbrales WHERE marquesina = '*'")
    resp = {"ahora": datetime.now(timezone.utc).isoformat(), "marquesinas": filas,
            "umbrales": {k: umbral[k] for k in ("temp_max", "hr_max", "co_max", "lux_dia")}}
    if u["rol"] != "caficultor":
        resp["latencia"] = await db.fila(
            """SELECT count(*) AS mensajes,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY latencia_ms) AS p50,
                      percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms) AS p95
               FROM telemetria WHERE ts > now() - interval '24 hours' AND latencia_ms >= 0""")
    return JSONResponse(_json(resp))


# SLI/SLO (ver monitoreo/sli.sql). SLI-1: frescura; SLI-2: disponibilidad de datos por marquesina.
SLO_LATENCIA = 95.0     # % de lecturas que llegan a la base en menos de 2 s
SLO_DISPONIB = 99.0     # % de ventanas de 10 min con al menos una lectura
SQL_SLI_LATENCIA = """
SELECT count(*) AS mensajes, 100.0 * count(*) FILTER (WHERE latencia_ms < 2000) / NULLIF(count(*), 0) AS sli,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latencia_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms) AS p95
FROM telemetria WHERE ts > now() - make_interval(hours => %s) AND latencia_ms >= 0"""
SQL_SLI_DISPONIB = """
WITH ventanas AS (
  SELECT generate_series(time_bucket('10 minutes', GREATEST(now() - make_interval(hours => %s),
                                                            (SELECT min(ts) FROM telemetria))),
                         time_bucket('10 minutes', now()) - interval '10 minutes', interval '10 minutes') AS b),
con_datos AS (SELECT DISTINCT marquesina, time_bucket('10 minutes', ts) AS b FROM telemetria
              WHERE ts > now() - make_interval(hours => %s) - interval '10 minutes')
SELECT m.id AS marquesina, count(*) AS ventanas, count(c.b) AS con_datos,
       100.0 * count(c.b) / NULLIF(count(*), 0) AS sli
FROM marquesinas m CROSS JOIN ventanas v LEFT JOIN con_datos c ON c.marquesina = m.id AND c.b = v.b
GROUP BY m.id ORDER BY m.id"""


@app.get("/api/sli")
async def api_sli(horas: int = 24, u: dict = Depends(requiere_rol("admin", "tecnico"))):
    horas = max(1, min(horas, 24 * 30))
    lat = await db.fila(SQL_SLI_LATENCIA, (horas,))
    disp = await db.filas(SQL_SLI_DISPONIB, (horas, horas))
    presupuesto = lambda sli, slo: None if sli is None else round(100 * (float(sli) - slo) / (100 - slo), 1)
    return JSONResponse(_json({
        "horas": horas,
        "latencia": {**lat, "slo": SLO_LATENCIA, "presupuesto_restante_pct": presupuesto(lat["sli"], SLO_LATENCIA)},
        "disponibilidad": [{**d, "slo": SLO_DISPONIB, "presupuesto_restante_pct": presupuesto(d["sli"], SLO_DISPONIB)}
                           for d in disp]}))


def _json(obj):
    """Serializa datetimes y números de PostgreSQL para JSONResponse."""
    if isinstance(obj, dict):
        return {k: _json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json(v) for v in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    if hasattr(obj, "__float__") and not isinstance(obj, (int, float, bool)):
        return float(obj)
    return obj


# Resolución automática para que una serie larga no envíe millones de puntos.
RESOLUCIONES = [(6, None), (48, "5 minutes"), (24 * 8, "30 minutes"), (24 * 31, "2 hours"), (10**6, "1 day")]


@app.get("/api/serie/{mid}")
async def api_serie(mid: str, horas: int = 24, u: dict = Depends(usuario_actual)):
    await auth.exigir_acceso(u, mid)
    horas = max(1, min(horas, 24 * 400))
    bucket = next(b for h, b in RESOLUCIONES if horas <= h)
    if bucket is None:
        puntos = await db.filas(
            """SELECT ts AS t, temp, hr, lux, co FROM telemetria
               WHERE marquesina = %s AND ts > now() - make_interval(hours => %s) ORDER BY ts""", (mid, horas))
    else:
        puntos = await db.filas(
            """SELECT time_bucket(%s::interval, ts) AS t,
                      avg(temp) AS temp, min(temp) AS temp_min, max(temp) AS temp_max,
                      avg(hr) AS hr, min(hr) AS hr_min, max(hr) AS hr_max,
                      avg(lux) AS lux, avg(co) AS co, max(co) AS co_max
               FROM telemetria WHERE marquesina = %s AND ts > now() - make_interval(hours => %s)
               GROUP BY 1 ORDER BY 1""", (bucket, mid, horas))
    alertas = await db.filas(
        """SELECT ts AS t, tipo, valor FROM alertas WHERE marquesina = %s
           AND ts > now() - make_interval(hours => %s) ORDER BY ts""", (mid, horas))
    anomalias = await db.filas(
        """SELECT ts AS t, variable, valor, puntaje FROM anomalias WHERE marquesina = %s
           AND ts > now() - make_interval(hours => %s) ORDER BY ts""", (mid, horas))
    return JSONResponse(_json({"resolucion": bucket or "cruda", "puntos": puntos, "alertas": alertas,
                               "anomalias": anomalias}))

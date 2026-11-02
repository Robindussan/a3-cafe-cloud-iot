"""Login, sesión y perfiles (admin, tecnico, caficultor).

- Claves con bcrypt (costo 12); comparación también para usuarios inexistentes para no
  revelar por tiempo cuáles existen.
- Bloqueo de 15 min tras 5 intentos fallidos.
- La sesión vive en una cookie firmada (Starlette SessionMiddleware: HttpOnly, Secure,
  SameSite=Lax) y caduca a las 8 h. Los formularios POST llevan un token CSRF de la sesión.
- La autorización se revisa en el servidor en cada ruta: el caficultor solo ve sus marquesinas.
"""
import secrets
import time

import bcrypt
from fastapi import Depends, HTTPException, Request

from . import db

ROLES = ("admin", "tecnico", "caficultor")
NOMBRES_ROL = {"admin": "Administrador", "tecnico": "Técnico", "caficultor": "Caficultor"}
SESION_S = 8 * 3600
MAX_INTENTOS = 5
BLOQUEO_MIN = 15
_HASH_FICTICIO = bcrypt.hashpw(b"no-existe", bcrypt.gensalt(12))


class NoAutenticado(Exception):
    pass


def hash_clave(clave: str) -> str:
    return bcrypt.hashpw(clave.encode(), bcrypt.gensalt(12)).decode()


def _verificar(clave: str, hash_guardado: bytes) -> bool:
    try:
        return bcrypt.checkpw(clave.encode(), hash_guardado)
    except ValueError:
        return False


async def autenticar(usuario: str, clave: str):
    """Devuelve (datos_de_sesión, None) o (None, mensaje_de_error)."""
    u = await db.fila("SELECT * FROM usuarios WHERE usuario = %s", (usuario.strip().lower(),))
    if not u:
        _verificar(clave, _HASH_FICTICIO)
        return None, "Usuario o contraseña incorrectos."
    if not u["activo"]:
        return None, "La cuenta está desactivada. Contacte al administrador."
    bloqueo = await db.fila("SELECT bloqueado_hasta > now() AS bloqueado FROM usuarios WHERE id = %s", (u["id"],))
    if bloqueo["bloqueado"]:
        return None, f"Cuenta bloqueada por intentos fallidos. Intente en {BLOQUEO_MIN} minutos."
    if not _verificar(clave, u["hash"].encode()):
        await db.ejecutar(
            """UPDATE usuarios SET intentos_fallidos = intentos_fallidos + 1,
                   bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= %s
                                     THEN now() + make_interval(mins => %s) END
               WHERE id = %s""", (MAX_INTENTOS, BLOQUEO_MIN, u["id"]))
        return None, "Usuario o contraseña incorrectos."
    await db.ejecutar("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, "
                      "ultimo_ingreso = now() WHERE id = %s", (u["id"],))
    marquesinas = [r["marquesina"] for r in await db.filas(
        "SELECT marquesina FROM usuario_marquesina WHERE usuario_id = %s ORDER BY 1", (u["id"],))]
    return {"id": u["id"], "usuario": u["usuario"], "nombre": u["nombre"], "rol": u["rol"],
            "marquesinas": marquesinas, "t": time.time()}, None


def token_csrf(request: Request) -> str:
    if "csrf" not in request.session:
        request.session["csrf"] = secrets.token_urlsafe(32)
    return request.session["csrf"]


def validar_csrf(request: Request, token: str):
    if not token or not secrets.compare_digest(token, request.session.get("csrf", "")):
        raise HTTPException(400, "Token CSRF inválido. Recargue la página.")


async def usuario_actual(request: Request) -> dict:
    u = request.session.get("u")
    if not u or time.time() - u.get("t", 0) > SESION_S:
        request.session.clear()
        raise NoAutenticado()
    return u


def requiere_rol(*roles):
    async def dependencia(u: dict = Depends(usuario_actual)):
        if u["rol"] not in roles:
            raise HTTPException(403, "Su perfil no tiene acceso a esta sección.")
        return u
    return dependencia


async def marquesinas_visibles(u: dict) -> list[str]:
    if u["rol"] == "caficultor":
        return list(u["marquesinas"])
    return [r["id"] for r in await db.filas("SELECT id FROM marquesinas ORDER BY id")]


async def exigir_acceso(u: dict, marquesina: str):
    if marquesina not in await marquesinas_visibles(u):
        raise HTTPException(404, "Marquesina no encontrada.")

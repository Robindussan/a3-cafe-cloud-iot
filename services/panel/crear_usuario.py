"""Crea o actualiza un usuario del panel desde la terminal (útil para el primer administrador).

    docker exec -it panel python crear_usuario.py <usuario> "<Nombre>" <rol> [marquesina ...]

La clave se pide por la entrada estándar (o se toma de la variable CLAVE) para que no quede
en el historial de la terminal.
"""
import asyncio
import getpass
import os
import sys

from app import auth, db


async def main(usuario, nombre, rol, marquesinas):
    if rol not in auth.ROLES:
        sys.exit(f"rol inválido: {rol} (use {', '.join(auth.ROLES)})")
    clave = os.environ.get("CLAVE") or getpass.getpass("Contraseña (10+ caracteres): ")
    if len(clave) < 10:
        sys.exit("la contraseña debe tener al menos 10 caracteres")
    await db.pool.open()
    fila = await db.fila(
        """INSERT INTO usuarios (usuario, nombre, rol, hash) VALUES (%s, %s, %s, %s)
           ON CONFLICT (usuario) DO UPDATE SET nombre = EXCLUDED.nombre, rol = EXCLUDED.rol,
             hash = EXCLUDED.hash, activo = true, intentos_fallidos = 0, bloqueado_hasta = NULL
           RETURNING id""", (usuario.lower(), nombre, rol, auth.hash_clave(clave)))
    await db.ejecutar("DELETE FROM usuario_marquesina WHERE usuario_id = %s", (fila["id"],))
    for m in marquesinas:
        await db.ejecutar("INSERT INTO usuario_marquesina VALUES (%s, %s)", (fila["id"], m))
    await db.pool.close()
    print(f"usuario {usuario} ({rol}) listo" + (f", marquesinas {', '.join(marquesinas)}" if marquesinas else ""))


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]))

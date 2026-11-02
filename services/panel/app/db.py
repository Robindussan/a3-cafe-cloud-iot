"""Acceso a TimescaleDB con el rol app_panel (pool asíncrono de psycopg 3)."""
import os

from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

DSN = make_conninfo(
    host=os.environ.get("PG_HOST", "timescaledb"),
    dbname=os.environ.get("PG_DB", "iot_db"),
    user=os.environ["PG_USER"],
    password=os.environ["PG_PASS"],
    application_name="panel-a3",
)

pool = AsyncConnectionPool(DSN, min_size=1, max_size=6, open=False,
                           kwargs={"row_factory": dict_row})


async def filas(sql, params=None):
    async with pool.connection() as conn:
        cur = await conn.execute(sql, params)
        return await cur.fetchall()


async def fila(sql, params=None):
    async with pool.connection() as conn:
        cur = await conn.execute(sql, params)
        return await cur.fetchone()


async def ejecutar(sql, params=None):
    async with pool.connection() as conn:
        await conn.execute(sql, params)

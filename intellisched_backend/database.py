"""The one place that turns a MongoDB URI into a database handle.

The live database (intellisched_db) is refused unless a person sets ALLOW_LIVE_DB=1. Tests pass a
fake client factory, so nothing connects anywhere.
"""
import os
import re
from typing import Any, Callable, Mapping, Optional, Tuple

from pymongo import MongoClient

LIVE_DB_NAME = "intellisched_db"

_DB_PATH = re.compile(r"^mongodb(?:\+srv)?://[^/]+/([^?]*)")


class LiveDatabaseRefused(RuntimeError):
    pass


def database_name(uri: str) -> str:
    """Database named in the URI path. A URI that names none is treated as the live database,
    because the service used intellisched_db unconditionally before the name was read from the URI."""
    match = _DB_PATH.match((uri or "").strip())
    return match.group(1) if match and match.group(1) else LIVE_DB_NAME


def assert_database_allowed(db_name: str, env: Optional[Mapping[str, str]] = None) -> None:
    env = os.environ if env is None else env
    if db_name == LIVE_DB_NAME and env.get("ALLOW_LIVE_DB") != "1":
        raise LiveDatabaseRefused(
            f'Refusing to connect to the live database "{LIVE_DB_NAME}". Development and tests use a '
            'database whose name ends in "_test". To run against live data, a person must set '
            "ALLOW_LIVE_DB=1 in the service's .env."
        )


def get_database(uri: str, client_factory: Callable[..., Any] = MongoClient,
                 env: Optional[Mapping[str, str]] = None) -> Tuple[Any, Any]:
    """Returns (client, database). Raises LiveDatabaseRefused before any client is created."""
    name = database_name(uri)
    assert_database_allowed(name, env)
    client = client_factory(uri, serverSelectionTimeoutMS=5000)
    return client, client[name]

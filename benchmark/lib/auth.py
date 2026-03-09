"""Auth helper to get admin JWT for staging."""

import os
import requests
from dotenv import load_dotenv

load_dotenv()

_cached_token: str | None = None


def get_staging_token() -> str:
    """Login to staging and return admin JWT token."""
    global _cached_token
    if _cached_token:
        return _cached_token

    base_url = os.environ["AGENTWEB_STAGING_URL"]
    email = os.environ["AGENTWEB_EMAIL"]
    password = os.environ["AGENTWEB_PASSWORD"]

    resp = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    resp.raise_for_status()
    _cached_token = resp.json()["token"]
    return _cached_token


def get_staging_url() -> str:
    return os.environ["AGENTWEB_STAGING_URL"]

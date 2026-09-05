"""Central configuration for the NVIDIA Kimi MCP server.

All values can be overridden via environment variables (see .env.example).
Nothing here is mutable at runtime except through explicit calls.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv is optional
    pass


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(slots=True)
class Settings:
    """Runtime settings loaded from the process environment."""

    # --- target -----------------------------------------------------------
    model_id: str = os.getenv("MODEL_ID", "moonshotai/kimi-k3")

    @property
    def playground_url(self) -> str:
        return os.getenv(
            "PLAYGROUND_URL",
            f"https://build.nvidia.com/{self.model_id}/playground",
        )

    # --- browser ----------------------------------------------------------
    headless: bool = _bool("HEADLESS", True)
    slow_mo_ms: int = _int("SLOW_MO_MS", 0)
    viewport_width: int = _int("VIEWPORT_WIDTH", 1600)
    viewport_height: int = _int("VIEWPORT_HEIGHT", 950)
    nav_timeout_ms: int = _int("NAV_TIMEOUT_MS", 60_000)
    action_timeout_ms: int = _int("ACTION_TIMEOUT_MS", 15_000)
    browser_channel: str = os.getenv("BROWSER_CHANNEL", "")  # e.g. "chrome"

    # Path to a Playwright storage-state JSON (cookies/localStorage) to reuse
    # an authenticated session, and where to persist it back.
    storage_state: str = os.getenv("STORAGE_STATE", "")

    # --- behaviour --------------------------------------------------------
    # Extra buffer after the playground UI appears so React hydration settles.
    hydration_wait_ms: int = _int("HYDRATION_WAIT_MS", 4_000)
    # How long to wait for an inference response by default.
    response_timeout_s: float = float(os.getenv("RESPONSE_TIMEOUT_S", "180"))
    # Poll period while waiting for a response to stabilise.
    poll_interval_s: float = float(os.getenv("POLL_INTERVAL_S", "1.5"))
    # How long text must remain unchanged to consider DOM output stable.
    stability_window_s: float = float(os.getenv("STABILITY_WINDOW_S", "3"))
    # Max automatic restart attempts after a browser crash.
    max_restarts: int = _int("MAX_RESTARTS", 5)

    user_agent: str = os.getenv(
        "USER_AGENT",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    )

    log_level: str = os.getenv("LOG_LEVEL", "INFO")


settings = Settings()

# Host substring that serves the real inference API the playground calls.
INFERENCE_API_HOST_HINT = "buildapi.ngc.nvidia.com"
# Substring of the JSON queue-probe endpoint (polled while waiting).
QUEUE_ENDPOINT_HINT = "/predict/queues/"

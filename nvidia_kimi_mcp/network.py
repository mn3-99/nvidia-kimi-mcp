"""Network interception layer — the reliable backbone of the MCP server.

The playground talks to NVIDIA's inference gateway directly from the browser:

    POST https://buildapi.ngc.nvidia.com/v2/predict/models/<id>/<model>
    Content-Type: application/json
    Response: text/event-stream  (OpenAI-style chat.completion.chunk SSE)

Every SSE chunk carries continuous usage statistics (``stream_options:
{include_usage: true, continuous_usage_stats: true}``), the assistant's
``content`` deltas and the reasoning ``reasoning_content`` deltas (Kimi K3
thinks out loud before answering).

Reading the wire gives us *byte-exact* responses, token counts, prompt
payloads (including the parameters as actually applied) and finish reasons —
independent of whatever the DOM does.  This module owns that channel.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from playwright.async_api import Page, Response

from .config import INFERENCE_API_HOST_HINT, QUEUE_ENDPOINT_HINT

logger = logging.getLogger("nvidia_kimi_mcp.network")


# ---------------------------------------------------------------------------
# SSE parsing
# ---------------------------------------------------------------------------
@dataclass
class Usage:
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
        }


@dataclass
class ParsedCompletion:
    """Aggregated result of one inference round-trip."""

    content: str = ""
    reasoning: str = ""
    finish_reason: Optional[str] = None
    usage: Usage = field(default_factory=Usage)
    model: Optional[str] = None
    raw_chunks: int = 0
    error: Optional[str] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "reasoning": self.reasoning,
            "finish_reason": self.finish_reason,
            "usage": self.usage.as_dict(),
            "model": self.model,
            "chunks": self.raw_chunks,
            "error": self.error,
        }


def _merge_chunk(parsed: ParsedCompletion, chunk: dict[str, Any]) -> None:
    """Merge one OpenAI-style chunk into the aggregate."""
    parsed.raw_chunks += 1
    if not parsed.model:
        parsed.model = chunk.get("model")
    usage = chunk.get("usage") or {}
    if usage:
        # continuous usage stats: the last chunk always has the totals.
        parsed.usage.prompt_tokens = usage.get("prompt_tokens", parsed.usage.prompt_tokens)
        parsed.usage.completion_tokens = usage.get(
            "completion_tokens", parsed.usage.completion_tokens
        )
        parsed.usage.total_tokens = usage.get("total_tokens", parsed.usage.total_tokens)
    for choice in chunk.get("choices") or []:
        delta = choice.get("delta") or choice.get("message") or {}
        if isinstance(delta.get("content"), str):
            parsed.content += delta["content"]
        if isinstance(delta.get("reasoning_content"), str):
            parsed.reasoning += delta["reasoning_content"]
        if choice.get("finish_reason"):
            parsed.finish_reason = choice["finish_reason"]


def parse_sse_stream(body: str) -> ParsedCompletion:
    """Parse a complete SSE (``data: ...``) stream body into a completion."""
    parsed = ParsedCompletion()
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            _merge_chunk(parsed, json.loads(data))
        except json.JSONDecodeError:
            continue
    return parsed


def parse_completion_body(body: str, content_type: str = "") -> ParsedCompletion:
    """Parse either an SSE stream or a plain JSON chat completion."""
    if "event-stream" in content_type or body.lstrip().startswith("data:"):
        return parse_sse_stream(body)
    parsed = ParsedCompletion()
    try:
        _merge_chunk(parsed, json.loads(body))
    except json.JSONDecodeError as exc:
        parsed.error = f"unparseable response body: {exc}"
    return parsed


# ---------------------------------------------------------------------------
# Live capture
# ---------------------------------------------------------------------------
@dataclass
class InferenceCapture:
    """Tracks a single in-flight (or finished) inference request."""

    started_at: float
    request_payload: Optional[dict[str, Any]] = None
    response_body: str = ""
    content_type: str = ""
    status: Optional[int] = None
    finished: bool = False
    parsed: Optional[ParsedCompletion] = None
    done_event: asyncio.Event = field(default_factory=asyncio.Event)

    def finish(self) -> None:
        self.finished = True
        self.parsed = parse_completion_body(self.response_body, self.content_type)
        self.parsed.elapsed_s = round(time.monotonic() - self.started_at, 2)  # type: ignore[attr-defined]
        self.done_event.set()

    def as_dict(self) -> dict[str, Any]:
        d = self.parsed.as_dict() if self.parsed else {}
        d["status"] = self.status
        d["elapsed_s"] = getattr(self.parsed, "elapsed_s", None) if self.parsed else None
        d["request"] = self.request_payload
        return d


class NetworkTap:
    """Attach to a Playwright page and tap the inference channel.

    Usage::

        tap = NetworkTap()
        tap.attach(page)
        ...                      # user clicks send
        cap = await tap.wait_for_next_completion(timeout=180)
    """

    def __init__(self) -> None:
        self._current: Optional[InferenceCapture] = None
        self.history: list[InferenceCapture] = []
        self.queue_depth: Optional[int] = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ API
    def attach(self, page: Page) -> None:
        page.on("response", self._on_response_sync)

    def arm(self) -> None:
        """Start watching for the *next* inference request."""
        self._current = None

    async def wait_request_payload(self, timeout: float) -> Optional[dict[str, Any]]:
        """Wait until the inference POST has been observed; return its payload."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._current and self._current.request_payload is not None:
                return self._current.request_payload
            await asyncio.sleep(0.2)
        return None

    async def wait_completion(self, timeout: float) -> Optional[InferenceCapture]:
        """Wait for the current inference round-trip to finish."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            cap = self._current
            if cap is not None:
                try:
                    await asyncio.wait_for(cap.done_event.wait(), timeout=max(0.1, deadline - time.monotonic()))
                    return cap
                except asyncio.TimeoutError:
                    break
            await asyncio.sleep(0.25)
        return self._current if (self._current and self._current.finished) else None

    @property
    def last(self) -> Optional[InferenceCapture]:
        if self._current and self._current.finished:
            return self._current
        return self.history[-1] if self.history else None

    # -------------------------------------------------------------- internals
    def _on_response_sync(self, resp: Response) -> None:
        try:
            url = resp.url
        except Exception:
            return
        if INFERENCE_API_HOST_HINT not in url:
            return
        if QUEUE_ENDPOINT_HINT in url:
            asyncio.ensure_future(self._read_queue(resp))
            return
        if "/predict/" not in url:
            return
        asyncio.ensure_future(self._read_completion(resp))

    async def _read_queue(self, resp: Response) -> None:
        try:
            data = json.loads(await resp.text())
            queues = data.get("queues") or []
            if queues:
                self.queue_depth = queues[0].get("queueDepth", self.queue_depth)
        except Exception:
            pass

    async def _read_completion(self, resp: Response) -> None:
        async with self._lock:
            cap = InferenceCapture(started_at=time.monotonic())
            try:
                cap.status = resp.status
                cap.content_type = resp.headers.get("content-type", "")
                try:
                    raw = resp.request.post_data
                    if raw:
                        cap.request_payload = json.loads(raw)
                except Exception:
                    cap.request_payload = None
                try:
                    cap.response_body = await resp.text()
                except Exception as exc:  # body may vanish on cancel
                    cap.response_body = ""
                    cap.parsed = ParsedCompletion(error=f"body read failed: {exc}")
                cap.finish()
                logger.info(
                    "inference done: status=%s bytes=%d chunks=%s",
                    cap.status,
                    len(cap.response_body),
                    cap.parsed.raw_chunks if cap.parsed else 0,
                )
            except Exception as exc:  # pragma: no cover - defensive
                cap.parsed = ParsedCompletion(error=str(exc))
                cap.finished = True
                cap.done_event.set()
            self._current = cap
            self.history.append(cap)
            # cap history memory
            if len(self.history) > 50:
                self.history = self.history[-25:]

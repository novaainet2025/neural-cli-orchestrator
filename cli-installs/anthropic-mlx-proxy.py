#!/usr/bin/env python3
"""
Anthropic-to-MLX Proxy  (anthropic-mlx-proxy.py)
================================================
Converts Anthropic API ↔ OpenAI-compatible format for MLX server (Apple Silicon)

Architecture:
  Claude Code
    → ANTHROPIC_BASE_URL=http://localhost:4100
      → This proxy  (port 4100)
        → MLX server (port 8000, OpenAI-compatible; model path from pm2 mlx-server)

Usage:
  python3 anthropic-mlx-proxy.py [port]   # default port 4100
  then:
  ANTHROPIC_BASE_URL=http://localhost:4100 ANTHROPIC_API_KEY=dummy claude

Endpoints proxied:
  POST /v1/messages            → /v1/chat/completions
  POST /v1/messages/count_tokens → estimated locally
  GET  /v1/models              → forwarded from MLX + reformatted
  GET  /health                 → liveness check
"""

import json
import os
import re
import uuid
import threading
import time
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.error import URLError

PROXY_PORT   = 4100
MLX_BASE     = "http://localhost:8000/v1"
# Gemma 4 26B on MLX (4K safe, 8K max)
MAX_TOKENS   = 4096
FORCE_STREAM = os.environ.get("FORCE_STREAM", "").strip().lower() in ("1", "true", "yes", "on")
REQUEST_TIMEOUT = 900

# ── GPU 직렬화: Metal 크래시 방지 (동시 GPU 요청 1개로 제한) ──────────────────
_gpu_semaphore = threading.Semaphore(1)
_gpu_lock_timeout = REQUEST_TIMEOUT  # 최대 대기 시간(초)

# Gemma/MLX 텍스트 내 도구 호출 — 시작 패턴 (JSON 은 균형 잡힌 {…} 로 추출)
GEMMA_TOOL_HEAD = re.compile(
    r"<\|?tool_call\|?>\s*call:([\w\-\.:]+)\s*\{",
    re.IGNORECASE | re.DOTALL,
)

# Lone UTF-16 surrogates break strict JSON parsers (Anthropic API, etc.)
_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")


def _sanitize_str(value: str) -> str:
    return _SURROGATE_RE.sub("", value)


def _sanitize_obj(value):
    if isinstance(value, str):
        return _sanitize_str(value)
    if isinstance(value, list):
        return [_sanitize_obj(item) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize_obj(item) for key, item in value.items()}
    return value


def _parse_json_body(raw: bytes) -> dict:
    text = raw.decode("utf-8", errors="replace")
    text = _SURROGATE_RE.sub("", text)
    return _sanitize_obj(json.loads(text))


def _balanced_brace_slice(s: str, open_idx: int):
    """s[open_idx] == '{'. Returns (json_slice, idx_after_closing_brace) or None."""
    if open_idx >= len(s) or s[open_idx] != "{":
        return None
    depth = 0
    for j in range(open_idx, len(s)):
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0:
                return s[open_idx : j + 1], j + 1
    return None


def _find_gemma_tool_end(text: str, json_end: int):
    """Skip whitespace; optional closing </tool_call> or <|…tool_call…|>. Returns end index."""
    rest = text[json_end:]
    m = re.match(
        r"\s*(?:</tool_call>|<\|/\s*tool_call\s*\|>|<\|tool_call\|>|<\|/\s*tool_call\|?>)?",
        rest,
        re.IGNORECASE,
    )
    return json_end + (m.end() if m else 0)


def find_next_gemma_tool(text: str, start: int = 0):
    """
    Returns (abs_start, abs_end, tool_name, json_str) for first complete Gemma tool call, or None.
    Handles nested JSON in {…} (non-greedy regex could not).
    """
    m = GEMMA_TOOL_HEAD.search(text, start)
    if not m:
        return None
    abs_start = m.start()
    name = m.group(1)
    brace_open = m.end() - 1
    if brace_open < 0 or text[brace_open] != "{":
        return None
    got = _balanced_brace_slice(text, brace_open)
    if not got:
        return None
    json_str, after_brace = got
    abs_end = _find_gemma_tool_end(text, after_brace)
    return (abs_start, abs_end, name, json_str)


def parse_tool_json_robust(raw: str) -> dict:
    """Parse tool arguments; tolerate minor model mistakes."""
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        pass
    # Strip accidental fences
    t = raw
    if t.startswith("```"):
        lines = t.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    try:
        return json.loads(t)
    except Exception:
        return {"_raw": raw}


def split_text_and_tools(text: str):
    """Split assistant text into ordered list of ('text', str) or ('tool', name, dict)."""
    out = []
    pos = 0
    while True:
        hit = find_next_gemma_tool(text, pos)
        if not hit:
            if pos < len(text):
                out.append(("text", text[pos:]))
            break
        abs_start, abs_end, name, json_str = hit
        if abs_start > pos:
            out.append(("text", text[pos:abs_start]))
        out.append(("tool", name, parse_tool_json_robust(json_str)))
        pos = abs_end
    return out


def take_safe_text_prefix(buf: str) -> tuple[str, str]:
    """
    Emit text that cannot be the start of an incomplete Gemma tool tag.
    Returns (safe_prefix, rest_keep_in_buffer).
    """
    if not buf:
        return "", ""
    best = -1
    for mk in ("<|tool_call", "<tool_call"):
        p = buf.find(mk)
        if p != -1 and (best == -1 or p < best):
            best = p
    if best == -1:
        return buf, ""
    if best == 0:
        return "", buf
    return buf[:best], buf[best:]


# Claude Code가 기대하는 도구 이름(대소문자)에 맞춤
_CC_TOOL_ALIASES = {
    "bash": "Bash",
    "read": "Read",
    "write": "Write",
    "glob": "Glob",
    "grep": "Grep",
    "edit": "Edit",
    "multiedit": "MultiEdit",
    "notebookedit": "NotebookEdit",
    "task": "Task",
    "todowrite": "TodoWrite",
    "webfetch": "WebFetch",
    "websearch": "WebSearch",
    "listdir": "ListDir",
    "run_terminal_cmd": "Bash",
    "runterminalcmd": "Bash",
}


def normalize_tool_name(name: str) -> str:
    if not name or not isinstance(name, str):
        return name or ""
    s = name.strip()
    tail = s.split(".")[-1] if "." in s else s
    low = tail.lower()
    if low in _CC_TOOL_ALIASES:
        return _CC_TOOL_ALIASES[low]
    low_full = s.lower()
    if low_full in _CC_TOOL_ALIASES:
        return _CC_TOOL_ALIASES[low_full]
    if len(s) > 1 and s[0].islower() and s[1:].replace("_", "").isalnum():
        return s[0].upper() + s[1:]
    return s


# ──────────────────────────────────────────────────────────────────────────────
# Format conversion helpers
# ──────────────────────────────────────────────────────────────────────────────

def anthropic_tools_to_openai(tools):
    """Anthropic tools → OpenAI tools"""
    if not tools:
        return None
    result = []
    for t in tools:
        result.append({
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("input_schema", {"type": "object", "properties": {}})
            }
        })
    return result


def anthropic_messages_to_openai(messages, system=None):
    """Anthropic messages array → OpenAI messages array"""
    result = []
    if system:
        result.append({"role": "system", "content": system})

    for msg in messages:
        role    = msg["role"]
        content = msg["content"]

        if isinstance(content, str):
            result.append({"role": role, "content": content})
            continue

        # content is a list of blocks
        text_parts   = []
        tool_calls   = []
        tool_results = []

        for block in content:
            btype = block.get("type", "")
            if btype == "text":
                text_parts.append(block.get("text", ""))
            elif btype == "thinking":
                # Skip thinking blocks in history (they confuse Gemma)
                pass
            elif btype == "tool_use":
                tool_calls.append({
                    "id": block.get("id", f"call_{uuid.uuid4().hex[:8]}"),
                    "type": "function",
                    "function": {
                        "name": block["name"],
                        "arguments": json.dumps(block.get("input", {}))
                    }
                })
            elif btype == "tool_result":
                content_val = block.get("content", "")
                if isinstance(content_val, list):
                    content_val = " ".join(
                        b.get("text", "") for b in content_val
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                tool_results.append({
                    "role": "tool",
                    "tool_call_id": block.get("tool_use_id", ""),
                    "content": content_val
                })

        if role == "assistant":
            msg_obj = {"role": "assistant", "content": "\n".join(text_parts) or None}
            if tool_calls:
                msg_obj["tool_calls"] = tool_calls
            result.append(msg_obj)
        elif role == "user":
            # tool_result blocks become separate tool messages
            for tr in tool_results:
                result.append(tr)
            if text_parts:
                result.append({"role": "user", "content": "\n".join(text_parts)})
        else:
            result.append({"role": role, "content": "\n".join(text_parts)})

    return result


def openai_response_to_anthropic(openai_resp, model="mlx-gemma"):
    """OpenAI response → Anthropic messages response"""
    choice       = (openai_resp.get("choices") or [{}])[0]
    message      = choice.get("message", {})
    finish_reason = choice.get("finish_reason", "stop")

    content_blocks = []

    # Gemma thinking model outputs reasoning separate from content
    reasoning = message.get("reasoning", "")
    if reasoning:
        content_blocks.append({"type": "thinking", "thinking": reasoning})

    text = message.get("content", "") or ""
    tcs = message.get("tool_calls") or []

    # OpenAI-style tool_calls (MLX native) — 우선 처리해 텍스트 내 태그와 중복 방지
    if tcs:
        for tc in tcs:
            fn = tc.get("function", {})
            nm = fn.get("name", "") or ""
            args_raw = fn.get("arguments", "{}")
            if isinstance(args_raw, str):
                input_data = parse_tool_json_robust(args_raw)
            elif isinstance(args_raw, dict):
                input_data = args_raw
            else:
                input_data = {}
            content_blocks.append({
                "type": "tool_use",
                "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:8]}"),
                "name": normalize_tool_name(nm),
                "input": input_data,
            })
        if text.strip():
            tail = text
            while True:
                hit = find_next_gemma_tool(tail, 0)
                if not hit:
                    break
                tail = tail[hit[1] :].lstrip()
            if tail.strip():
                content_blocks.append({"type": "text", "text": tail})
    elif text.strip():
        for item in split_text_and_tools(text):
            if item[0] == "text":
                chunk = item[1]
                if chunk and chunk.strip():
                    content_blocks.append({"type": "text", "text": chunk})
            else:
                _, tname, inp = item
                content_blocks.append({
                    "type": "tool_use",
                    "id": f"toolu_{uuid.uuid4().hex[:8]}",
                    "name": normalize_tool_name(tname),
                    "input": inp if isinstance(inp, dict) else {},
                })

    stop_reason = "end_turn"
    if finish_reason == "tool_calls":
        stop_reason = "tool_use"
    elif finish_reason == "length":
        stop_reason = "max_tokens"

    usage = openai_resp.get("usage", {})
    return {
        "id":            f"msg_{uuid.uuid4().hex[:24]}",
        "type":          "message",
        "role":          "assistant",
        "content":       content_blocks,
        "model":         model,
        "stop_reason":   stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens":  usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0)
        }
    }


def get_mlx_model():
    """Fetch the first loaded model from MLX server."""
    try:
        r = urlopen(f"{MLX_BASE}/models", timeout=5)
        data = json.loads(r.read())
        models = [
            m for m in data.get("data", [])
            if isinstance(m, dict) and not is_tts_model(m.get("id", ""))
        ]
        return models[0]["id"] if models else None
    except Exception:
        return None


def is_tts_model(model_id: str) -> bool:
    name = (model_id or "").lower()
    return any(token in name for token in ("tts", "text-to-speech", "audio"))


def filter_text_models(models):
    return [m for m in models if isinstance(m, dict) and not is_tts_model(m.get("id", ""))]


# ──────────────────────────────────────────────────────────────────────────────
# HTTP handler
# ──────────────────────────────────────────────────────────────────────────────

class ProxyHandler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # Suppress default access logs

    # ── helpers ───────────────────────────────────────────────────────────────

    def _send_json(self, status, body_dict):
        body = json.dumps(body_dict, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, etype, message):
        self._send_json(status, {"type": "error", "error": {"type": etype, "message": message}})

    def _read_body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b"{}"

    # ── GET ───────────────────────────────────────────────────────────────────

    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ("/health", "/v1/health"):
            self._send_json(200, {"status": "ok", "proxy": "anthropic-mlx", "mlx_base": MLX_BASE})
            return

        if path == "/v1/models":
            try:
                r = urlopen(f"{MLX_BASE}/models", timeout=5)
                data = json.loads(r.read())
                filtered = filter_text_models(data.get("data", []))
                models = [
                    {"id": m["id"], "type": "model",
                     "display_name": m["id"].split("/")[-1],
                     "created_at": "2026-01-01T00:00:00Z"}
                    for m in filtered
                ]
                self._send_json(200, {"data": models})
            except Exception as e:
                self._error(503, "service_unavailable_error", f"MLX not available: {e}")
            return

        self._error(404, "not_found_error", f"GET {path} not found")

    # ── POST ──────────────────────────────────────────────────────────────────

    def do_POST(self):
        path = self.path.split("?")[0]

        try:
            raw = self._read_body()
            body = _parse_json_body(raw)
        except Exception:
            self._error(400, "invalid_request_error", "Invalid JSON body")
            return

        if path == "/v1/messages":
            self._handle_messages(body)
        elif path == "/v1/messages/count_tokens":
            self._handle_count_tokens(body)
        elif path in ("/health", "/v1/health"):
            self._send_json(200, {"status": "ok"})
        else:
            self._error(404, "not_found_error", f"POST {path} not found")

    # ── /v1/messages/count_tokens ─────────────────────────────────────────────

    def _handle_count_tokens(self, req):
        text = req.get("system", "")
        if isinstance(text, list):
            text = " ".join(b.get("text", "") for b in text if isinstance(b, dict))
        for m in req.get("messages", []):
            c = m.get("content", "")
            if isinstance(c, str):
                text += c
            elif isinstance(c, list):
                for b in c:
                    if isinstance(b, dict):
                        text += b.get("text", "")
        self._send_json(200, {"input_tokens": max(1, len(text) // 4)})

    # ── /v1/messages ──────────────────────────────────────────────────────────

    def _handle_messages(self, req):
        # ── MLX 헬스 프리체크 (재시도 1회, 3초 대기) ─────────────────────────────
        mlx_model = get_mlx_model()
        if mlx_model is None:
            time.sleep(3)
            mlx_model = get_mlx_model()
        if mlx_model is None:
            self._error(503, "service_unavailable_error",
                        "MLX server not running. Start with: pm2 start mlx-server  "
                        "or /nco-mlx start")
            return

        # Parse system prompt
        system = req.get("system", "")
        if isinstance(system, list):
            system = " ".join(b.get("text", "") for b in system
                              if isinstance(b, dict) and b.get("type") == "text")

        messages  = anthropic_messages_to_openai(req.get("messages", []), system)
        tools     = anthropic_tools_to_openai(req.get("tools"))
        max_tok   = min(int(req.get("max_tokens", MAX_TOKENS)), MAX_TOKENS)
        streaming = FORCE_STREAM or req.get("stream", False)

        openai_req = {
            "model":       mlx_model,
            "messages":    messages,
            "max_tokens":  max_tok,
            "temperature": float(req.get("temperature", 0.7)),
            "stream":      streaming
        }
        if tools:
            openai_req["tools"]       = tools
            openai_req["tool_choice"] = "auto"
        if req.get("stop_sequences"):
            openai_req["stop"] = req["stop_sequences"]

        mlx_http_req = Request(
            f"{MLX_BASE}/chat/completions",
            data=json.dumps(openai_req).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )

        # ── GPU 세마포어: Metal 크래시 방지 (동시 추론 1개로 직렬화) ──────────────
        acquired = _gpu_semaphore.acquire(timeout=_gpu_lock_timeout)
        if not acquired:
            self._error(503, "service_unavailable_error",
                        "MLX GPU busy (timeout waiting for semaphore). Try again.")
            return

        try:
            if streaming:
                self._stream(mlx_http_req, mlx_model)
            else:
                self._non_stream(mlx_http_req, mlx_model)
        except URLError as e:
            self._error(503, "service_unavailable_error", f"MLX error: {e}")
        except Exception as e:
            self._error(500, "api_error", f"Proxy internal error: {e}")
        finally:
            _gpu_semaphore.release()

    # ── non-streaming ─────────────────────────────────────────────────────────

    def _non_stream(self, mlx_req, model):
        with urlopen(mlx_req, timeout=REQUEST_TIMEOUT) as resp:
            openai_resp = json.loads(resp.read())
        self._send_json(200, openai_response_to_anthropic(openai_resp, model))

    # ── streaming ─────────────────────────────────────────────────────────────

    def _stream(self, mlx_req, model):
        msg_id = f"msg_{uuid.uuid4().hex[:24]}"

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def sse(event, data):
            try:
                line = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                self.wfile.write(line.encode())
                self.wfile.flush()
            except Exception:
                pass

        # ── Anthropic SSE prologue ──
        sse("message_start", {
            "type": "message_start",
            "message": {
                "id": msg_id, "type": "message", "role": "assistant",
                "content": [], "model": model,
                "stop_reason": None, "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0}
            }
        })
        sse("content_block_start", {
            "type": "content_block_start", "index": 0,
            "content_block": {"type": "text", "text": ""}
        })

        stop_reason = "end_turn"
        output_tokens = 0
        # 블록 0 = 텍스트(프롤로그). tool_use 전에 반드시 content_block_stop 필요 (Claude Code 파서)
        st = {"next_idx": 1, "text_idx": 0, "text_open": True}
        current_tool_id = None
        current_tool_name = None
        current_tool_block_idx = None
        pending_text = ""

        def close_text_block():
            if st["text_open"]:
                sse("content_block_stop", {"type": "content_block_stop", "index": st["text_idx"]})
                st["text_open"] = False

        def open_fresh_text_block():
            """도구 뒤에 이어지는 텍스트용 새 블록."""
            close_text_block()
            idx = st["next_idx"]
            st["next_idx"] += 1
            st["text_idx"] = idx
            sse("content_block_start", {
                "type": "content_block_start",
                "index": idx,
                "content_block": {"type": "text", "text": ""},
            })
            st["text_open"] = True

        def emit_text_delta(txt: str):
            if not txt:
                return
            sse("content_block_delta", {
                "type": "content_block_delta",
                "index": st["text_idx"],
                "delta": {"type": "text_delta", "text": txt},
            })

        def emit_gemma_tool_use(t_name: str, json_str: str):
            nonlocal stop_reason
            close_text_block()
            t_name = normalize_tool_name(t_name)
            tool_idx = st["next_idx"]
            st["next_idx"] += 1
            t_id = f"toolu_{uuid.uuid4().hex[:8]}"
            sse("content_block_start", {
                "type": "content_block_start",
                "index": tool_idx,
                "content_block": {
                    "type": "tool_use",
                    "id": t_id,
                    "name": t_name,
                    "input": {},
                },
            })
            sse("content_block_delta", {
                "type": "content_block_delta",
                "index": tool_idx,
                "delta": {"type": "input_json_delta", "partial_json": json_str},
            })
            sse("content_block_stop", {"type": "content_block_stop", "index": tool_idx})
            stop_reason = "tool_use"

        def flush_gemma_from_pending():
            nonlocal pending_text
            while True:
                hit = find_next_gemma_tool(pending_text, 0)
                if not hit:
                    break
                abs_start, abs_end, t_name, json_str = hit
                pre = pending_text[:abs_start]
                if pre:
                    emit_text_delta(pre)
                emit_gemma_tool_use(t_name, json_str)
                pending_text = pending_text[abs_end:]

            safe, keep = take_safe_text_prefix(pending_text)
            pending_text = keep
            if safe:
                if not st["text_open"]:
                    open_fresh_text_block()
                emit_text_delta(safe)

        try:
            with urlopen(mlx_req, timeout=REQUEST_TIMEOUT) as resp:
                for raw_line in resp:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:]
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except Exception:
                        continue

                    choice = (chunk.get("choices") or [{}])[0]
                    delta = choice.get("delta", {})
                    fr = choice.get("finish_reason")

                    # 1. OpenAI-style tool_calls — 텍스트 블록을 먼저 닫음
                    if "tool_calls" in delta:
                        for tc in delta["tool_calls"]:
                            if "id" in tc:
                                close_text_block()
                                current_tool_id = tc["id"]
                                current_tool_block_idx = st["next_idx"]
                                st["next_idx"] += 1
                                fn = tc.get("function", {})
                                current_tool_name = normalize_tool_name(fn.get("name", "") or "")
                                sse("content_block_start", {
                                    "type": "content_block_start",
                                    "index": current_tool_block_idx,
                                    "content_block": {
                                        "type": "tool_use",
                                        "id": current_tool_id,
                                        "name": current_tool_name,
                                        "input": {},
                                    },
                                })
                            if "function" in tc and "arguments" in tc["function"]:
                                arg_delta = tc["function"]["arguments"]
                                idx = current_tool_block_idx
                                if idx is not None:
                                    sse("content_block_delta", {
                                        "type": "content_block_delta",
                                        "index": idx,
                                        "delta": {
                                            "type": "input_json_delta",
                                            "partial_json": arg_delta,
                                        },
                                    })

                    # 2. 본문 텍스트 (Gemma 태그)
                    content_delta = delta.get("content", "") or ""
                    if content_delta:
                        pending_text += content_delta
                        flush_gemma_from_pending()

                    if fr == "tool_calls":
                        stop_reason = "tool_use"
                    elif fr == "length":
                        stop_reason = "max_tokens"

                    usage = chunk.get("usage") or {}
                    if usage.get("completion_tokens"):
                        output_tokens = usage["completion_tokens"]

            if current_tool_block_idx is not None:
                sse("content_block_stop", {"type": "content_block_stop", "index": current_tool_block_idx})
                current_tool_block_idx = None

            if pending_text:
                if not st["text_open"]:
                    open_fresh_text_block()
                emit_text_delta(pending_text)
                pending_text = ""

        except Exception as e:
            if not st["text_open"]:
                open_fresh_text_block()
            emit_text_delta(f"\n[proxy error: {e}]")

        close_text_block()
        sse("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": output_tokens}
        })
        sse("message_stop", {"type": "message_stop"})
        try:
            self.wfile.flush()
        except Exception:
            pass


# ──────────────────────────────────────────────────────────────────────────────
# Threaded server
# ──────────────────────────────────────────────────────────────────────────────

class ThreadedHTTPServer(HTTPServer):
    def process_request(self, request, client_address):
        t = threading.Thread(target=self._handle, args=(request, client_address), daemon=True)
        t.start()

    def _handle(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            pass
        finally:
            self.shutdown_request(request)


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PROXY_PORT
    server = ThreadedHTTPServer(("127.0.0.1", port), ProxyHandler)
    print(f"[anthropic-mlx-proxy] Listening on http://localhost:{port}")
    print(f"[anthropic-mlx-proxy] Forwarding → {MLX_BASE}")
    print(f"[anthropic-mlx-proxy] Use:")
    print(f"  ANTHROPIC_BASE_URL=http://localhost:{port} ANTHROPIC_API_KEY=dummy claude")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[anthropic-mlx-proxy] Stopped.")
        server.shutdown()

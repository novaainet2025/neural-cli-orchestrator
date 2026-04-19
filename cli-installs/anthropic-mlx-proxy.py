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

# ── GPU 직렬화: Metal 크래시 방지 (동시 GPU 요청 1개로 제한) ──────────────────
_gpu_semaphore = threading.Semaphore(1)
_gpu_lock_timeout = 180  # 최대 대기 시간(초)


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

    text = message.get("content", "")
    if text:
        content_blocks.append({"type": "text", "text": text})

    for tc in message.get("tool_calls", []):
        fn = tc.get("function", {})
        try:
            input_data = json.loads(fn.get("arguments", "{}"))
        except Exception:
            input_data = {}
        content_blocks.append({
            "type": "tool_use",
            "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:8]}"),
            "name": fn.get("name", ""),
            "input": input_data
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
        return data["data"][0]["id"]
    except Exception:
        return None


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
                models = [
                    {"id": m["id"], "type": "model",
                     "display_name": m["id"].split("/")[-1],
                     "created_at": "2026-01-01T00:00:00Z"}
                    for m in data.get("data", [])
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
            raw  = self._read_body()
            body = json.loads(raw)
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
        streaming = req.get("stream", False)

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
        with urlopen(mlx_req, timeout=120) as resp:
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
        sse("ping", {"type": "ping"})

        stop_reason   = "end_turn"
        output_tokens = 0
        # Accumulate reasoning but don't stream it (confuses Claude Code)
        # We stream content deltas only

        try:
            with urlopen(mlx_req, timeout=180) as resp:
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
                    delta  = choice.get("delta", {})
                    fr     = choice.get("finish_reason")

                    content_delta = delta.get("content", "")
                    if content_delta:
                        sse("content_block_delta", {
                            "type": "content_block_delta", "index": 0,
                            "delta": {"type": "text_delta", "text": content_delta}
                        })

                    if fr == "tool_calls":
                        stop_reason = "tool_use"
                    elif fr == "length":
                        stop_reason = "max_tokens"

                    usage = chunk.get("usage") or {}
                    if usage.get("completion_tokens"):
                        output_tokens = usage["completion_tokens"]

        except Exception as e:
            sse("content_block_delta", {
                "type": "content_block_delta", "index": 0,
                "delta": {"type": "text_delta", "text": f"\n[proxy error: {e}]"}
            })

        sse("content_block_stop",  {"type": "content_block_stop", "index": 0})
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

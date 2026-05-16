#!/usr/bin/env python3
"""CLI-only Volcengine Bigmodel ASR recorder/transcriber.

Commands:
  uv run main.py start              # start recording mic to recordings/*.wav
  uv run main.py stop               # stop recording, upload, transcribe, print text
  uv run main.py status             # show current recording state
  uv run main.py transcribe FILE    # upload/transcribe an existing audio file

Required for transcription:
  VOLC_API_KEY=your_new_console_api_key  # optional while DEFAULT_VOLC_API_KEY is set

Optional:
  AUDIO_FILE=/home/terence/Downloads/untitled.mp3  # default for no-arg transcribe
  AUDIO_URL=https://.../file.mp3                   # skip uploading if provided
  VOLC_RESOURCE_ID=volc.seedasr.auc
  ASR_LANGUAGE=zh-CN                               # omit/empty for default detection
  ASR_METHOD=stream                                # stream | async
  ASR_POLL_INTERVAL=0.25                           # seconds between async result polls
  VOLC_STREAM_RESOURCE_ID=volc.seedasr.sauc.duration
  VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
  STREAM_SEGMENT_MS=5000                           # post-recording batch chunk size
  UPLOAD_BACKEND=auto                              # auto | temp | tos
  VOLCENGINE_ACCESS_KEY_ID=AKLT...                 # for TOS upload backend
  VOLCENGINE_SECRET_ACCESS_KEY=...                 # for TOS upload backend
  VOLCENGINE_TOS_BUCKET=...                        # for TOS upload backend
  VOLCENGINE_TOS_REGION=cn-beijing                 # for TOS upload backend
  RECORDING_FINALIZE_DELAY=0.1                     # wait after recorder exits before reading WAV
  RECORDINGS_DIR=recordings
  RECORDER_STATE=.recording.json
  RECORDER_TARGET=alsa_input.usb-Jieli_Technology_UACDemoV1.0-00.mono-fallback
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import hmac
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import requests
from dotenv import load_dotenv
from websocket import create_connection

SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"
QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"
# No default key in publishable builds. Put VOLC_API_KEY in .env or environment.
DEFAULT_VOLC_API_KEY = ""
# Hardcoded for local testing. Set RECORDER_TARGET="" to let PipeWire auto-pick.
DEFAULT_RECORDER_TARGET = "alsa_input.usb-Jieli_Technology_UACDemoV1.0-00.mono-fallback"
PROCESSING_CODES = {"20000001", "20000002"}
SUPPORTED_FORMATS = {"mp3", "wav", "ogg", "raw"}

MSG_TYPE_CLIENT_FULL_REQUEST = 0b0001
MSG_TYPE_CLIENT_AUDIO_ONLY_REQUEST = 0b0010
MSG_TYPE_SERVER_FULL_RESPONSE = 0b1001
MSG_TYPE_SERVER_ERROR_RESPONSE = 0b1111
FLAG_POS_SEQUENCE = 0b0001
FLAG_NEG_WITH_SEQUENCE = 0b0011
SERIALIZATION_NONE = 0b0000
SERIALIZATION_JSON = 0b0001
COMPRESSION_GZIP = 0b0001


class AsrError(RuntimeError):
    pass


def get_api_key() -> str:
    api_key = os.getenv("VOLC_API_KEY") or DEFAULT_VOLC_API_KEY
    if not api_key:
        raise AsrError("Missing VOLC_API_KEY. Put it in .env or export it.")
    return api_key


def status(resp: requests.Response) -> tuple[str | None, str | None]:
    return resp.headers.get("X-Api-Status-Code"), resp.headers.get("X-Api-Message")


def audio_format_from_path(path: Path) -> str:
    fmt = path.suffix.lower().lstrip(".")
    if fmt not in SUPPORTED_FORMATS:
        raise AsrError(f"Unsupported audio format .{fmt}; supported: {', '.join(sorted(SUPPORTED_FORMATS))}")
    return fmt


def content_type_for(path: Path) -> str:
    if path.suffix.lower() == ".wav":
        return "audio/wav"
    if path.suffix.lower() == ".mp3":
        return "audio/mpeg"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def tos_credentials() -> tuple[str, str, str, str]:
    ak = os.getenv("VOLCENGINE_ACCESS_KEY_ID") or os.getenv("VOLC_ACCESS_KEY_ID") or os.getenv("VOLC_ACCESSKEY") or ""
    sk = os.getenv("VOLCENGINE_SECRET_ACCESS_KEY") or os.getenv("VOLC_SECRET_ACCESS_KEY") or os.getenv("VOLC_SECRETKEY") or ""
    bucket = os.getenv("VOLCENGINE_TOS_BUCKET") or os.getenv("VOLC_TOS_BUCKET") or ""
    region = os.getenv("VOLCENGINE_TOS_REGION") or os.getenv("VOLC_TOS_REGION") or "cn-beijing"
    return ak.strip(), sk.strip(), bucket.strip(), region.strip()


def has_tos_config() -> bool:
    ak, sk, bucket, _region = tos_credentials()
    return bool(ak and sk and bucket)


def tos_sign_v4(method: str, url: str, ak: str, sk: str, region: str, *, expires: int = 3600) -> str:
    """Generate a Volcengine TOS V4 presigned URL using query-string auth."""
    parsed = urlparse(url)
    now = datetime.now(timezone.utc)
    date_stamp = now.strftime("%Y%m%d")
    tos_date = now.strftime("%Y%m%dT%H%M%SZ")
    credential_scope = f"{date_stamp}/{region}/tos/request"
    signed_headers = "host"
    canonical_headers = f"host:{parsed.hostname}\n"

    query_params = {
        "X-Tos-Algorithm": "TOS4-HMAC-SHA256",
        "X-Tos-Credential": f"{ak}/{credential_scope}",
        "X-Tos-Date": tos_date,
        "X-Tos-Expires": str(expires),
        "X-Tos-SignedHeaders": signed_headers,
    }
    canonical_qs = "&".join(
        f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in sorted(query_params.items())
    )
    canonical_request = "\n".join(
        [
            method,
            quote(parsed.path, safe="/"),
            canonical_qs,
            canonical_headers,
            signed_headers,
            "UNSIGNED-PAYLOAD",
        ]
    )
    string_to_sign = "\n".join(
        [
            "TOS4-HMAC-SHA256",
            tos_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )

    def sign(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    signing_key = sign(sign(sign(sign(sk.encode("utf-8"), date_stamp), region), "tos"), "request")
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{parsed.scheme}://{parsed.hostname}{parsed.path}?{canonical_qs}&X-Tos-Signature={signature}"


def upload_to_tos(path: Path, audio_format: str) -> str:
    ak, sk, bucket, region = tos_credentials()
    missing = []
    if not ak:
        missing.append("VOLCENGINE_ACCESS_KEY_ID")
    if not sk:
        missing.append("VOLCENGINE_SECRET_ACCESS_KEY")
    if not bucket:
        missing.append("VOLCENGINE_TOS_BUCKET")
    if missing:
        raise AsrError("Missing TOS config: " + ", ".join(missing))
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$", bucket):
        raise AsrError(f"Invalid TOS bucket name: {bucket}")
    if not re.match(r"^[a-z0-9-]+$", region):
        raise AsrError(f"Invalid TOS region: {region}")

    object_key = f"pi-voice-asr/{uuid.uuid4()}.{audio_format}"
    raw_url = f"https://{bucket}.tos-{region}.volces.com/{object_key}"
    put_url = tos_sign_v4("PUT", raw_url, ak, sk, region, expires=300)
    get_url = tos_sign_v4("GET", raw_url, ak, sk, region, expires=3600)

    with path.open("rb") as f:
        r = requests.put(put_url, data=f, headers={"Content-Type": content_type_for(path)}, timeout=120)
    if r.status_code not in {200, 201}:
        raise AsrError(f"TOS upload failed ({r.status_code}): {r.text[:300]}")
    return get_url


def upload_to_temp_host(path: Path) -> str:
    """Upload file to a temporary public host and return a direct URL."""
    errors: list[str] = []
    ctype = content_type_for(path)

    # uguu returns a direct downloadable URL that Volcengine can fetch.
    try:
        with path.open("rb") as f:
            r = requests.post(
                "https://uguu.se/upload",
                files={"files[]": (path.name, f, ctype)},
                timeout=120,
            )
        r.raise_for_status()
        data = r.json()
        url = data["files"][0]["url"]
        if url.startswith("http"):
            return url
        errors.append(f"uguu unexpected url: {url!r}")
    except Exception as e:
        errors.append(f"uguu: {e}")

    # fallback: litterbox.catbox.moe temporary direct URL
    try:
        with path.open("rb") as f:
            r = requests.post(
                "https://litterbox.catbox.moe/resources/internals/api.php",
                data={"reqtype": "fileupload", "time": "1h"},
                files={"fileToUpload": (path.name, f, ctype)},
                timeout=120,
            )
        r.raise_for_status()
        url = r.text.strip()
        if url.startswith("http"):
            return url
        errors.append(f"litterbox unexpected response: {url!r}")
    except Exception as e:
        errors.append(f"litterbox: {e}")

    raise AsrError("Upload failed: " + " | ".join(errors))


def upload_audio(path: Path, audio_format: str) -> tuple[str, str]:
    """Upload audio and return (url, backend_used)."""
    backend = os.getenv("UPLOAD_BACKEND", "auto").strip().lower()
    if backend not in {"auto", "temp", "tos"}:
        raise AsrError("UPLOAD_BACKEND must be auto, temp, or tos")

    if backend == "tos" or (backend == "auto" and has_tos_config()):
        return upload_to_tos(path, audio_format), "tos"

    if backend == "auto":
        print("TOS config not found; using temporary public host. Set VOLCENGINE_* TOS vars for faster/private upload.", flush=True)
    return upload_to_temp_host(path), "temp"


def transcribe_url(audio_url: str, audio_format: str, api_key: str, *, print_json: bool = False) -> str:
    t0 = time.perf_counter()
    task_id = str(uuid.uuid4())
    resource_id = os.getenv("VOLC_RESOURCE_ID", "volc.seedasr.auc")

    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Request-Id": task_id,
    }
    submit_headers = {**headers, "X-Api-Sequence": "-1"}

    audio: dict[str, Any] = {"format": audio_format, "url": audio_url}
    language = os.getenv("ASR_LANGUAGE", "").strip()
    if language:
        audio["language"] = language

    body = {
        "user": {"uid": "uv-test"},
        "audio": audio,
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "show_utterances": True,
        },
    }

    print(f"Submitting task {task_id} ...", flush=True)
    t_submit = time.perf_counter()
    r = requests.post(SUBMIT_URL, headers=submit_headers, data=json.dumps(body), timeout=60)
    submit_secs = time.perf_counter() - t_submit
    code, msg = status(r)
    print(
        f"submit http={r.status_code} status={code} message={msg} "
        f"logid={r.headers.get('X-Tt-Logid')} time={submit_secs:.2f}s",
        flush=True,
    )
    if code != "20000000":
        raise AsrError(r.text or f"Submit failed: {code} {msg}")

    poll_interval = float(os.getenv("ASR_POLL_INTERVAL", "0.25"))
    max_polls = int(os.getenv("ASR_MAX_POLLS", str(max(1, int(120 / poll_interval)))))
    print(f"Polling result every {poll_interval:.2f}s ...", flush=True)
    t_poll = time.perf_counter()
    for _ in range(max_polls):
        time.sleep(poll_interval)
        q = requests.post(QUERY_URL, headers=headers, json={}, timeout=60)
        code, msg = status(q)
        print(f"query status={code} message={msg}", flush=True)

        if code in PROCESSING_CODES:
            continue

        data: dict[str, Any] = {}
        try:
            data = q.json()
        except ValueError:
            pass

        # Volcengine may return a non-20000000 header for silent / no-speech
        # recordings while still returning a JSON body with result.text == "".
        # For voice input UX, treat that as a successful empty transcript instead
        # of surfacing a scary extension error.
        if code != "20000000":
            text = data.get("result", {}).get("text") if isinstance(data, dict) else None
            if code == "20000003" or text == "":
                print(f"No speech recognized: status={code} message={msg}", flush=True)
            else:
                raise AsrError(q.text or f"Query failed: {code} {msg}")

        poll_secs = time.perf_counter() - t_poll
        total_secs = time.perf_counter() - t0
        print(f"Timing: submit={submit_secs:.2f}s poll_wait={poll_secs:.2f}s asr_total={total_secs:.2f}s")
        if print_json:
            print("\n=== Full JSON ===")
            print(json.dumps(data, ensure_ascii=False, indent=2))
        return data.get("result", {}).get("text", "")

    raise AsrError("Timed out waiting for ASR result")


def ws_header(message_type: int, flags: int, serialization: int, compression: int) -> bytes:
    return bytes(
        [
            (0b0001 << 4) | 0b0001,
            (message_type << 4) | flags,
            (serialization << 4) | compression,
            0,
        ]
    )


def ws_full_client_request(sequence: int, payload: dict[str, Any]) -> bytes:
    body = gzip.compress(json.dumps(payload).encode("utf-8"))
    return b"".join(
        [
            ws_header(MSG_TYPE_CLIENT_FULL_REQUEST, FLAG_POS_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_GZIP),
            sequence.to_bytes(4, "big", signed=True),
            len(body).to_bytes(4, "big", signed=False),
            body,
        ]
    )


def ws_audio_request(sequence: int, audio: bytes, *, is_last: bool) -> bytes:
    actual_sequence = -sequence if is_last else sequence
    flags = FLAG_NEG_WITH_SEQUENCE if is_last else FLAG_POS_SEQUENCE
    body = gzip.compress(audio)
    return b"".join(
        [
            ws_header(MSG_TYPE_CLIENT_AUDIO_ONLY_REQUEST, flags, SERIALIZATION_NONE, COMPRESSION_GZIP),
            actual_sequence.to_bytes(4, "big", signed=True),
            len(body).to_bytes(4, "big", signed=False),
            body,
        ]
    )


def ws_decode_payload(serialization: int, compression: int, payload: bytes) -> Any:
    decoded = gzip.decompress(payload) if compression == COMPRESSION_GZIP and payload else payload
    if serialization == SERIALIZATION_JSON and decoded:
        return json.loads(decoded.decode("utf-8"))
    return decoded


def ws_parse_frame(frame: bytes) -> dict[str, Any]:
    msg = frame if isinstance(frame, bytes) else bytes(frame)
    if len(msg) < 4:
        raise AsrError("Invalid WebSocket frame: header too short")

    header_size = msg[0] & 0x0F
    message_type = msg[1] >> 4
    flags = msg[1] & 0x0F
    serialization = msg[2] >> 4
    compression = msg[2] & 0x0F
    offset = header_size * 4

    sequence = None
    is_last = bool(flags & 0b0010)
    if flags & 0b0001:
        sequence = int.from_bytes(msg[offset : offset + 4], "big", signed=True)
        offset += 4

    if message_type == MSG_TYPE_SERVER_FULL_RESPONSE:
        payload_size = int.from_bytes(msg[offset : offset + 4], "big", signed=False)
        offset += 4
        payload = msg[offset : offset + payload_size]
        return {
            "message_type": message_type,
            "sequence": sequence,
            "is_last": is_last,
            "payload": ws_decode_payload(serialization, compression, payload),
        }

    if message_type == MSG_TYPE_SERVER_ERROR_RESPONSE:
        error_code = int.from_bytes(msg[offset : offset + 4], "big", signed=True)
        offset += 4
        payload_size = int.from_bytes(msg[offset : offset + 4], "big", signed=False)
        offset += 4
        payload = msg[offset : offset + payload_size]
        try:
            detail = ws_decode_payload(serialization, compression, payload)
        except Exception:
            detail = payload.decode("utf-8", errors="replace")
        raise AsrError(f"Streaming ASR error {error_code}: {detail}")

    return {"message_type": message_type, "sequence": sequence, "is_last": is_last, "payload": None}


def load_pcm16k_mono(path: Path) -> tuple[bytes, float]:
    """Return raw pcm_s16le/16kHz/mono bytes and duration seconds."""
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            rate = wav.getframerate()
            compression = wav.getcomptype()
            frames = wav.getnframes()
            if channels == 1 and sample_width == 2 and rate == 16000 and compression == "NONE":
                return wav.readframes(frames), frames / rate

    if not shutil.which("ffmpeg"):
        raise AsrError("ffmpeg is required to stream non-16k-mono-PCM WAV audio")

    proc = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise AsrError(f"ffmpeg transcode failed: {proc.stderr.decode(errors='replace')}")
    return proc.stdout, len(proc.stdout) / (16000 * 2)


def transcribe_stream_file(path: Path, api_key: str, *, print_json: bool = False) -> str:
    if not path.exists():
        raise AsrError(f"Audio file not found: {path}")

    t0 = time.perf_counter()
    pcm, duration = load_pcm16k_mono(path)
    transcode_secs = time.perf_counter() - t0

    ws_url = os.getenv("VOLC_WS_URL", "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream")
    resource_id = os.getenv("VOLC_STREAM_RESOURCE_ID", "volc.seedasr.sauc.duration")
    connect_id = str(uuid.uuid4())
    headers = [
        f"X-Api-Key: {api_key}",
        f"X-Api-Resource-Id: {resource_id}",
        f"X-Api-Connect-Id: {connect_id}",
        f"X-Api-Request-Id: {connect_id}",
    ]

    print(f"Streaming {path} ({duration:.2f}s audio) to {ws_url} ...", flush=True)
    t_open = time.perf_counter()
    ws = create_connection(ws_url, header=headers, timeout=60)
    open_secs = time.perf_counter() - t_open

    language = os.getenv("ASR_LANGUAGE", "").strip()
    audio_payload: dict[str, Any] = {"format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1}
    if language and "bigmodel_nostream" in ws_url:
        audio_payload["language"] = language

    request_payload = {
        "user": {"uid": "uv-test"},
        "audio": audio_payload,
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "enable_ddc": False,
            "show_utterances": print_json,
            "result_type": "full",
        },
    }

    segment_ms = int(os.getenv("STREAM_SEGMENT_MS", "5000"))
    send_interval_ms = int(os.getenv("STREAM_SEND_INTERVAL_MS", "0"))
    segment_size = max(1, int(16000 * 2 * segment_ms / 1000))
    seq = 1
    packets = 0
    t_send = time.perf_counter()
    try:
        ws.send_binary(ws_full_client_request(seq, request_payload))
        seq += 1
        if not pcm:
            ws.send_binary(ws_audio_request(seq, b"", is_last=True))
            packets = 1
        else:
            for offset in range(0, len(pcm), segment_size):
                chunk = pcm[offset : offset + segment_size]
                is_last = offset + segment_size >= len(pcm)
                ws.send_binary(ws_audio_request(seq, chunk, is_last=is_last))
                packets += 1
                if not is_last:
                    seq += 1
                    if send_interval_ms > 0:
                        time.sleep(send_interval_ms / 1000)
        send_secs = time.perf_counter() - t_send

        final_text = ""
        final_payload: Any = None
        t_wait = time.perf_counter()
        while True:
            frame = ws.recv()
            parsed = ws_parse_frame(frame)
            payload = parsed.get("payload")
            if isinstance(payload, dict):
                final_payload = payload
                text = payload.get("result", {}).get("text")
                if isinstance(text, str) and text:
                    final_text = text
            if parsed.get("is_last"):
                break
        wait_secs = time.perf_counter() - t_wait
    finally:
        try:
            ws.close()
        except Exception:
            pass

    total_secs = time.perf_counter() - t0
    print(
        f"Timing: transcode={transcode_secs:.2f}s ws_open={open_secs:.2f}s "
        f"send={send_secs:.2f}s wait={wait_secs:.2f}s stream_total={total_secs:.2f}s packets={packets}",
        flush=True,
    )
    if print_json and final_payload is not None:
        print("\n=== Full JSON ===")
        print(json.dumps(final_payload, ensure_ascii=False, indent=2))
    print("\n=== Transcript ===")
    print(final_text)
    return final_text


def transcribe_file(path: Path, api_key: str, *, print_json: bool = False, method: str | None = None) -> str:
    if not path.exists():
        raise AsrError(f"Audio file not found: {path}")

    method = (method or os.getenv("ASR_METHOD", "stream")).strip().lower()
    if method not in {"async", "stream"}:
        raise AsrError("ASR_METHOD/method must be async or stream")
    if method == "stream":
        return transcribe_stream_file(path, api_key, print_json=print_json)

    audio_format = audio_format_from_path(path)
    backend = os.getenv("UPLOAD_BACKEND", "auto").strip().lower()
    print(f"Uploading {path} via {backend} ...", flush=True)
    t_upload = time.perf_counter()
    audio_url, upload_backend = upload_audio(path, audio_format)
    upload_secs = time.perf_counter() - t_upload
    print(f"Uploaded URL: {audio_url}", flush=True)
    print(f"Upload backend: {upload_backend}", flush=True)
    print(f"Upload time: {upload_secs:.2f}s", flush=True)

    text = transcribe_url(audio_url, audio_format, api_key, print_json=print_json)
    print("\n=== Transcript ===")
    print(text)
    return text


def project_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    return path


def state_path() -> Path:
    return project_path(os.getenv("RECORDER_STATE", ".recording.json"))


def recordings_dir() -> Path:
    return project_path(os.getenv("RECORDINGS_DIR", "recordings"))


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def load_state() -> dict[str, Any] | None:
    path = state_path()
    if not path.exists():
        return None
    return json.loads(path.read_text())


def save_state(state: dict[str, Any]) -> None:
    path = state_path()
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2))


def clear_state() -> None:
    try:
        state_path().unlink()
    except FileNotFoundError:
        pass


def recorder_command(output: Path) -> list[str]:
    if shutil.which("pw-record"):
        cmd = ["pw-record", "--rate", "16000", "--channels", "1", "--format", "s16"]
        target = os.getenv("RECORDER_TARGET", DEFAULT_RECORDER_TARGET).strip()
        if target:
            cmd += ["--target", target]
        return [*cmd, str(output)]
    if shutil.which("arecord"):
        return ["arecord", "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", str(output)]
    raise AsrError("No recorder found. Install PipeWire tools (pw-record) or alsa-utils (arecord).")


def start_recording() -> int:
    existing = load_state()
    if existing and pid_alive(int(existing["pid"])):
        print(f"Already recording: pid={existing['pid']} file={existing['path']}")
        return 1
    if existing:
        clear_state()

    out_dir = recordings_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output = out_dir / f"recording-{stamp}.wav"
    log_path = out_dir / f"recording-{stamp}.log"
    cmd = recorder_command(output)

    log = log_path.open("wb")
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    finally:
        log.close()

    time.sleep(0.4)
    if proc.poll() is not None:
        msg = log_path.read_text(errors="replace") if log_path.exists() else ""
        raise AsrError(f"Recorder exited immediately with code {proc.returncode}. Log:\n{msg}")

    save_state(
        {
            "pid": proc.pid,
            "path": str(output),
            "log_path": str(log_path),
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "cmd": cmd,
        }
    )
    print(f"Recording started: pid={proc.pid}")
    print(f"Audio file: {output}")
    print("Stop and transcribe with: uv run main.py stop")
    return 0


def stop_process_group(pid: int) -> None:
    for sig, wait_secs in [(signal.SIGINT, 4.0), (signal.SIGTERM, 2.0), (signal.SIGKILL, 1.0)]:
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            return
        except PermissionError:
            os.kill(pid, sig)

        deadline = time.time() + wait_secs
        while time.time() < deadline:
            if not pid_alive(pid):
                return
            time.sleep(0.1)


def stop_recording(*, no_transcribe: bool = False, print_json: bool = False, method: str | None = None) -> int:
    state = load_state()
    if not state:
        print("Not recording: no state file found.")
        return 1

    pid = int(state["pid"])
    audio_path = Path(state["path"])
    print(f"Stopping recording: pid={pid}", flush=True)
    if pid_alive(pid):
        stop_process_group(pid)
    clear_state()
    finalize_delay = float(os.getenv("RECORDING_FINALIZE_DELAY", "0.1"))
    if finalize_delay > 0:
        time.sleep(finalize_delay)  # let the WAV header flush/finalize

    if not audio_path.exists() or audio_path.stat().st_size == 0:
        log_path = Path(state.get("log_path", ""))
        log = log_path.read_text(errors="replace") if log_path.exists() else ""
        raise AsrError(f"Recording file missing/empty: {audio_path}\nRecorder log:\n{log}")

    print(f"Saved audio: {audio_path} ({audio_path.stat().st_size} bytes)")
    if no_transcribe:
        return 0

    text = transcribe_file(audio_path, get_api_key(), print_json=print_json, method=method)
    # Last line is intentionally only the text, convenient for shell capture.
    print(f"\nRESULT_TEXT={text}")
    return 0


def show_status() -> int:
    state = load_state()
    if not state:
        print("Not recording")
        return 0
    alive = pid_alive(int(state["pid"]))
    print(json.dumps({**state, "alive": alive}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CLI recorder + Volcengine ASR test")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("start", help="start microphone recording in the background")

    stop = sub.add_parser("stop", help="stop recording, save audio, transcribe")
    stop.add_argument("--no-transcribe", action="store_true", help="only stop/save audio")
    stop.add_argument("--json", action="store_true", help="also print full ASR JSON")
    stop.add_argument("--method", choices=["stream", "async"], help="ASR method; defaults to ASR_METHOD")

    transcribe = sub.add_parser("transcribe", help="transcribe an existing local audio file or AUDIO_URL")
    transcribe.add_argument("file", nargs="?", help="audio file path; defaults to AUDIO_FILE")
    transcribe.add_argument("--json", action="store_true", help="also print full ASR JSON")
    transcribe.add_argument("--method", choices=["stream", "async"], help="ASR method; defaults to ASR_METHOD")

    stream = sub.add_parser("stream", help="transcribe local audio through streaming WebSocket ASR")
    stream.add_argument("file", nargs="?", help="audio file path; defaults to AUDIO_FILE")
    stream.add_argument("--json", action="store_true", help="also print final ASR JSON")

    sub.add_parser("status", help="show whether a recording is active")
    return parser


def main() -> int:
    load_dotenv()
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "start":
            return start_recording()
        if args.command == "stop":
            return stop_recording(no_transcribe=args.no_transcribe, print_json=args.json, method=args.method)
        if args.command == "status":
            return show_status()

        if args.command == "stream":
            api_key = get_api_key()
            file_arg = getattr(args, "file", None)
            audio_file = Path(file_arg or os.getenv("AUDIO_FILE", "/home/terence/Downloads/untitled.mp3")).expanduser()
            transcribe_stream_file(audio_file, api_key, print_json=getattr(args, "json", False))
            return 0

        # Default behavior remains: transcribe AUDIO_FILE, unless AUDIO_URL is set.
        if args.command in {"transcribe", None}:
            api_key = get_api_key()
            audio_url = os.getenv("AUDIO_URL")
            if audio_url:
                fmt = os.getenv("AUDIO_FORMAT", "mp3")
                text = transcribe_url(audio_url, fmt, api_key, print_json=getattr(args, "json", False))
                print("\n=== Transcript ===")
                print(text)
                return 0

            file_arg = getattr(args, "file", None)
            audio_file = Path(file_arg or os.getenv("AUDIO_FILE", "/home/terence/Downloads/untitled.mp3")).expanduser()
            transcribe_file(audio_file, api_key, print_json=getattr(args, "json", False), method=getattr(args, "method", None))
            return 0

        parser.print_help()
        return 2
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        return 130
    except AsrError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

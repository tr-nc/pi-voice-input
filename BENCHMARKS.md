# ASR speed benchmarks

Date: 2026-05-16

Test input: `/home/terence/Downloads/untitled.mp3` (~19.59s speech audio). Transcript sanity checked against expected Chinese text. Times are wall-clock values printed by `main.py`; API/network variance is expected.

## Recording-file async API polling

To isolate polling from upload variability, the file was uploaded once to a temporary URL and reused via `AUDIO_URL`.

| ASR_POLL_INTERVAL | submit | poll_wait | asr_total | Notes |
| --- | ---: | ---: | ---: | --- |
| 2.00s | 3.36s | 6.31s | 9.67s | old default-style polling |
| 0.50s | 4.37s | 4.37s | 8.74s | faster result pickup |
| 0.25s | 2.52s | 5.38s | 7.91s | current async default |

Temp-host upload itself was ~2.51s in a representative run, so upload + async ASR was about ~9.9s end-to-end for this sample.

## WebSocket streaming ASR (`bigmodel_nostream`)

Command pattern:

```bash
STREAM_SEGMENT_MS=<ms> uv run main.py stream /home/terence/Downloads/untitled.mp3
```

| STREAM_SEGMENT_MS | transcode | ws_open | send | wait | stream_total | packets | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 200 | 0.08s | 0.06s | 0.02s | 2.86s | 3.02s | 98 | doc-style realtime chunk size |
| 1000 | 0.08s | 0.07s | 0.02s | 1.63s | 1.80s | 20 | faster batch chunks |
| 5000 | 0.08s | 0.06s | 0.02s | 1.11s | 1.28s | 4 | current default |

Conclusion: for this post-recording workflow, WebSocket ASR with 5s chunks avoids public upload and async polling, reducing the sample from roughly ~9.9s to ~1.3–1.5s after stop.

## Pure TypeScript extension port

The publishable extension now implements the same WebSocket ASR binary protocol in TypeScript using Node + `ws`; it no longer calls `uv run main.py`. A Node `ws` smoke test against the same endpoint returned the expected transcript. The ASR path and chunking are equivalent to the Python streaming implementation, so expected latency should stay in the same ~1.3–1.5s range for the sample above.

## Recorder stop overhead

The fixed post-stop WAV-finalization delay was reduced from 0.5s to configurable `RECORDING_FINALIZE_DELAY=0.1`. A 1s test recording finalized correctly and `ffprobe` read it as a valid 1.47s WAV. This saves ~0.4s on every shortcut stop path.

## TOS upload backend

Implemented but not fully benchmarked because no TOS credentials are available in the environment. Required variables:

```bash
VOLCENGINE_ACCESS_KEY_ID
VOLCENGINE_SECRET_ACCESS_KEY
VOLCENGINE_TOS_BUCKET
VOLCENGINE_TOS_REGION=cn-beijing
```

`UPLOAD_BACKEND=tos` currently fails fast with a clear missing-config error when these are absent. Streaming ASR is faster than any upload-based path for the current post-recording voice-input use case, so TOS remains an async fallback improvement rather than the default path.

#!/usr/bin/env python3
"""Compare processors on the same recorded mono S16LE/48k input, without routing changes."""

import argparse
import array
import ctypes as C
import hashlib
import json
import math
import struct
import time
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--input", required=True, type=Path)
p.add_argument("--output", required=True, type=Path)
p.add_argument("--mode", choices=["dji", "rnnoise"], required=True)
p.add_argument(
    "--rnnoise-library",
    default="/blackbox/upgrade/osmo-srt/console/librnnoise-small.so",
)
a = p.parse_args()
if a.output.exists():
    raise SystemExit("output already exists")
data = a.input.read_bytes()
times = []
result = bytearray()
cpu = time.process_time()
start = time.perf_counter()
if a.mode == "dji":
    path = Path("/usr/lib/libapuapi.so")
    assert (
        hashlib.sha256(path.read_bytes()).hexdigest()
        == "184b31c22618ec014e71725ce5d8babdf27664d1b91e73f555957debfa4b93ff"
    ), "unknown firmware ABI"
    lib = C.CDLL(str(path))
    lib.dji_audio_nn_init.argtypes = []
    lib.dji_audio_nn_init.restype = C.c_int
    lib.dji_audio_nn_proc_v2.argtypes = [C.c_void_p, C.c_void_p, C.c_size_t, C.c_void_p]
    lib.dji_audio_nn_proc_v2.restype = C.c_int
    lib.dji_audio_nn_deinit.argtypes = []
    assert lib.dji_audio_nn_init() == 0
    block = 1024
    out = C.create_string_buffer(block * 2)
    meta = C.create_string_buffer(512)
    struct.pack_into("<ff", meta, 124, 1.0, 1.0)
    try:
        for i in range(0, len(data), block * 2):
            frame = data[i : i + block * 2].ljust(block * 2, b"\0")
            inp = C.create_string_buffer(frame)
            t = time.perf_counter()
            rc = lib.dji_audio_nn_proc_v2(out, inp, len(frame), meta)
            times.append(time.perf_counter() - t)
            assert rc == 0
            result += out.raw
    finally:
        lib.dji_audio_nn_deinit()
else:
    lib = C.CDLL(a.rnnoise_library)
    lib.rnnoise_create.argtypes = [C.c_void_p]
    lib.rnnoise_create.restype = C.c_void_p
    lib.rnnoise_process_frame.argtypes = [C.c_void_p, C.c_void_p, C.c_void_p]
    lib.rnnoise_process_frame.restype = C.c_float
    lib.rnnoise_destroy.argtypes = [C.c_void_p]
    h = lib.rnnoise_create(None)
    assert h
    block = 480
    inp = (C.c_float * block)()
    out = (C.c_float * block)()
    try:
        for i in range(0, len(data), block * 2):
            values = struct.unpack(
                "<480h", data[i : i + block * 2].ljust(block * 2, b"\0")
            )
            inp[:] = values
            t = time.perf_counter()
            lib.rnnoise_process_frame(h, out, inp)
            times.append(time.perf_counter() - t)
            result += struct.pack(
                "<480h", *[max(-32768, min(32767, round(v))) for v in out]
            )
    finally:
        lib.rnnoise_destroy(h)
a.output.write_bytes(result[: len(data)])
a.output.chmod(0o600)
ordered = sorted(times)
duration = len(data) / 96000
print(
    json.dumps(
        {
            "mode": a.mode,
            "duration_s": duration,
            "frames": len(times),
            "block_samples": block,
            "mean_ms": sum(times) / len(times) * 1000,
            "p95_ms": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))] * 1000,
            "max_ms": max(times) * 1000,
            "processor_realtime_factor": sum(times) / duration,
            "cpu_s_including_python_io": time.process_time() - cpu,
            "wall_s": time.perf_counter() - start,
            "peak_rss_kib": int(
                next(
                    line
                    for line in Path("/proc/self/status").read_text().splitlines()
                    if line.startswith("VmHWM:")
                ).split()[1]
            ),
            "input_rms_s16": math.sqrt(
                sum(v * v for v in array.array("h", data)) / (len(data) / 2)
            ),
        }
    ),
    flush=True,
)

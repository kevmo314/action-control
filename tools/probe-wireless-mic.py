#!/usr/bin/env python3
"""Read-only probe for the wireless-mic ABI on the inspected AC204 firmware.

Run as a short-lived child: python3 -I -B probe-wireless-mic.py
No pairing, setters, PCM stream opens, or transmitter recording commands.
Connection fields come from the stock PulseAudio source's disassembly.
Other capability/status fields intentionally remain uninterpreted.
"""
import ctypes as C
import hashlib
import json
import platform
import struct
from pathlib import Path

LIBRARY = Path("/usr/lib/libwirelessmicclient.so")
EXPECTED = "19b0f0fc797a2ba00fe102085196e3804f2d25e0fd6f5d40e762eeb330e5ff7f"


def main():
    if platform.machine() != "aarch64" or hashlib.sha256(LIBRARY.read_bytes()).hexdigest() != EXPECTED:
        raise RuntimeError("unverified wireless microphone ABI")
    lib = C.CDLL(str(LIBRARY))
    lib.wireless_mic_client_create.argtypes = [C.POINTER(C.c_void_p)]
    lib.wireless_mic_client_create.restype = C.c_int
    lib.wireless_mic_client_destroy.argtypes = [C.c_void_p]
    lib.wireless_mic_client_destroy.restype = C.c_int
    handle = C.c_void_p()
    result = {"library_sha256": EXPECTED, "read_only": True}
    rc = lib.wireless_mic_client_create(C.byref(handle))
    result["create_rc"] = rc
    if rc != 0 or not handle.value:
        raise RuntimeError(f"wireless microphone client unavailable: {rc}")
    try:
        for name in ("get_capability", "get_status"):
            function = getattr(lib, "wireless_mic_client_" + name)
            function.argtypes = [C.c_void_p, C.c_void_p]
            function.restype = C.c_int
            # The stock consumer reserves <1 KiB on its stack. A larger buffer
            # and canary keep this exploratory output separate from Python state.
            storage = C.create_string_buffer(4096 + 64)
            C.memset(C.addressof(storage) + 4096, 0xA5, 64)
            rc = function(handle, storage)
            if storage.raw[4096:] != b"\xA5" * 64:
                raise RuntimeError("native status exceeded probe buffer")
            entry = {"rc": rc, "guard_intact": True}
            if name == "get_status" and rc == 0:
                flags = list(struct.unpack_from("<II", storage.raw, 28))
                entry["tx_connection_flags"] = flags
                entry["any_connected_by_stock_source_check"] = 1 in flags
            result[name] = entry
    finally:
        result["destroy_rc"] = lib.wireless_mic_client_destroy(handle)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

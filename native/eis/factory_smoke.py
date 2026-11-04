"""Run on the camera with the two libraries staged in the directory below.

This creates callback tables only. It never creates a camera graph or changes
services. Load the adapter first to match the real framework's load order.
"""
import ctypes as C
import json

ROOT = "/run/action-control-eis-rotation/"
adapter = C.CDLL(ROOT + "libosmo_eis_preview_rotation.so", mode=2)
wrapped = (C.c_uint64 * 32)()
wrapped[0] = 256
adapter.ChiNodeEntry.argtypes = [C.c_void_p]
adapter.ChiNodeEntry.restype = None
adapter.ChiNodeEntry(C.byref(wrapped))

original = C.CDLL(ROOT + "original-eis-preview.so", mode=2)
stock = (C.c_uint64 * 32)()
stock[0] = 256
original.ChiNodeEntry.argtypes = [C.c_void_p]
original.ChiNodeEntry.restype = None
original.ChiNodeEntry(C.byref(stock))

changed = [index * 8 for index in range(32) if stock[index] != wrapped[index]]
assert changed == [64, 72], changed
assert all(stock[index] for index in (8, 9))
print(json.dumps({"factory_callbacks_changed": changed,
                  "unrelated_callbacks_preserved": True,
                  "adapter_loaded_first": True}))

"""Exercise the inspected native metadata helper with a fake framework only.

No camera graph, devices or services are accessed. The real native helper must
forward the expected session, frame, metadata type and tag, and return the fake
framework's mode pointer. A firmware mismatch aborts before loading the helper.
"""
import ctypes as C
import hashlib
import json
from pathlib import Path

PATH = Path("/usr/lib/libcom.qti.chinodeutils.so")
assert hashlib.sha256(PATH.read_bytes()).hexdigest() == (
    "00df8ce9ae1ca9b5f3a13396515ad9e5fa022ee9cf63b22fc84a628868ba6572")


class TagData(C.Structure):
    _fields_ = [("size", C.c_uint32), ("reserved", C.c_uint32),
                ("request", C.c_uint64), ("data", C.c_void_p),
                ("count", C.c_uint64), ("offset", C.c_uint64),
                ("negate", C.c_uint64)]


class MetadataInfo(C.Structure):
    _fields_ = [("size", C.c_uint32), ("reserved", C.c_uint32),
                ("session", C.c_void_p), ("count", C.c_uint32),
                ("reserved2", C.c_uint32), ("tags", C.POINTER(C.c_uint32)),
                ("data", C.POINTER(TagData)), ("kind", C.c_uint32),
                ("reserved3", C.c_uint32), ("camera_ids", C.POINTER(C.c_uint32))]


assert C.sizeof(TagData) == 48 and C.sizeof(MetadataInfo) == 56
mode = C.c_uint8(3)
observed = []


@C.CFUNCTYPE(C.c_int32, C.POINTER(MetadataInfo))
def fake_get(info):
    metadata = info.contents
    # Assert outside the callback: ctypes cannot propagate callback exceptions.
    observed.append((metadata.size, metadata.session, metadata.count,
                     metadata.tags[0], metadata.data[0].request,
                     metadata.kind, metadata.camera_ids[0]))
    metadata.data[0].data = C.addressof(mode)
    return 0


interface = (C.c_uint64 * 48)()
interface[0] = 384
interface[3] = C.cast(fake_get, C.c_void_p).value  # pGetMetadata at byte 24
library = C.CDLL(str(PATH), mode=2)
get = getattr(library, "_ZN12ChiNodeUtils11GetMetaDataEmj15ChiMetadataTypeP16ChiNodeInterfacePvj")
get.argtypes = [C.c_uint64, C.c_uint32, C.c_uint32, C.c_void_p, C.c_void_p, C.c_uint32]
get.restype = C.c_void_p
pointer = get(123, 0x88B7001A, 2, C.byref(interface), 0x12340, 0)
assert pointer == C.addressof(mode)
assert observed == [(56, 0x12340, 1, 0x88B7001A, 123, 2, 0)], observed
print(json.dumps({"native_metadata_abi_verified": True, "camera_graph_created": False}))

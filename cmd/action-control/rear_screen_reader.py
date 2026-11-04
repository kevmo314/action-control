#!/usr/bin/env python3
"""Read-only AC204 display evidence: EW pixels, KMS scanout, and retire times.

Does not attach a debugger, create a Wayland client, change display properties,
or restart services. Private EW offsets are gated by complete ELF fingerprints.
DRM GETFB2/PRIME handles belong to a separately opened, read-only DRM fd.
"""
import argparse
import base64
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import re
import shlex
import struct
import subprocess
import time
import uuid
import zlib

FINGERPRINTS = {
    "/usr/bin/dji_gui_on_disp0": "30eb933b1c2315984e150885124d277c13c1cef3194ba6c08cb3d4d1f6656db1",
    "/usr/bin/dji_gui_on_disp1": "e965fbc8588445f5fa922fd1df38ed7051198fe28a50c33e51c94246c00fdb27",
    "/usr/lib/libewplatform_unity.so": "576288a82c6005cbe3afe17d650349da97ee3d0573716138503a35b7303862a6",
    "/usr/lib/libewrte_gfx_soft_ttfe.11.00.so": "c56a94a131ece3bdcb1bfae77559723b6dfed8425e56a0b2e686ac694bb00916",
}
PLATFORM_AGENT = 0x367A0
EW_UPDATE_CYCLE = 0x1081D4
MAX_BUFFER_BYTES = 4 * 1024 * 1024
DRM_STATE = "/sys/kernel/debug/dri/0/state"


def drm_planes(state):
    """Parse only complete plane blocks; CRTC/connector tails are separate."""
    planes = []
    for block in re.split(r"(?m)(?=^(?:plane|crtc|connector)\[)", state):
        match = re.match(r"plane\[(\d+)\]: ([^\n]+)\n", block)
        if not match:
            continue
        crtc = re.search(r"^\tcrtc=([^\n]+)$", block, re.M)
        fb = re.search(r"^\tfb=(\d+)$", block, re.M)
        if not crtc or not fb or int(fb[1]) == 0:
            continue
        fmt = re.search(r"^\t\tformat=(\S+)", block, re.M)
        planes.append({"plane_id": int(match[1]), "crtc": crtc[1],
                       "fb_id": int(fb[1]), "format": fmt[1] if fmt else None})
    return planes


def packed_pixels(data, pitch, width=400, height=712, offset=0):
    if not (0 < width <= 2048 and 0 < height <= 2048 and width * 4 <= pitch <= 8192):
        raise ValueError("Invalid pixel geometry")
    if offset < 0 or offset + (height - 1) * pitch + width * 4 > len(data):
        raise ValueError("Short pixel buffer")
    return b"".join(data[offset + y * pitch:offset + y * pitch + width * 4]
                    for y in range(height))


class Memory:
    def __init__(self, pid):
        self.pid = pid
        self.maps = []
        for line in pathlib.Path(f"/proc/{pid}/maps").read_text().splitlines():
            fields = line.split(maxsplit=5)
            start, end = (int(n, 16) for n in fields[0].split("-"))
            self.maps.append({"start": start, "end": end, "permissions": fields[1],
                              "offset": int(fields[2], 16), "dev": fields[3],
                              "inode": int(fields[4]), "path": fields[5] if len(fields) == 6 else ""})
        self.fd = os.open(f"/proc/{pid}/mem", os.O_RDONLY | os.O_CLOEXEC)

    def close(self):
        os.close(self.fd)

    def mapping(self, address, size):
        if size <= 0 or size > MAX_BUFFER_BYTES:
            raise ValueError("Invalid memory read size")
        return next(m for m in self.maps if "r" in m["permissions"]
                    and m["start"] <= address and address + size <= m["end"])

    def base(self, path):
        return next(m["start"] for m in self.maps if m["path"] == path and m["offset"] == 0)

    def read(self, address, size):
        self.mapping(address, size)
        data = os.pread(self.fd, size, address)
        if len(data) != size:
            raise ValueError("Short process memory read")
        return data

    def u32(self, address):
        return struct.unpack("<I", self.read(address, 4))[0]

    def u64(self, address):
        return struct.unpack("<Q", self.read(address, 8))[0]


def libc_handle():
    lib = ctypes.CDLL(None, use_errno=True)
    lib.syscall.restype = ctypes.c_long
    lib.mmap.restype = ctypes.c_void_p
    lib.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int,
                        ctypes.c_int, ctypes.c_int, ctypes.c_long]
    lib.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    lib.ioctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p]
    return lib


def ioctl(lib, fd, request, argument):
    if lib.ioctl(fd, request, ctypes.byref(argument)) < 0:
        raise OSError(ctypes.get_errno(), f"readback ioctl {request:#x}")


def read_dma(lib, fd, size):
    if not 0 < size <= MAX_BUFFER_BYTES:
        raise ValueError("Unexpected DMA buffer size")
    address = lib.mmap(None, size, 1, 1, fd, 0)  # PROT_READ, MAP_SHARED
    if address == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_errno(), "Read-only DMA mapping")
    try:
        flags = ctypes.c_uint64(1)  # DMA_BUF_SYNC_READ | START
        ioctl(lib, fd, 0x40086200, flags)
        try:
            return ctypes.string_at(address, size)
        finally:
            flags.value = 5  # DMA_BUF_SYNC_READ | END
            ioctl(lib, fd, 0x40086200, flags)
    finally:
        lib.munmap(address, size)


def read_gui_pixels(lib, memory, address, size):
    mapping = memory.mapping(address, size)
    if not mapping["path"].startswith("/dmabuf:"):
        raise ValueError("GUI buffer is not a DMA mapping")
    dma_fd = None
    for path in pathlib.Path(f"/proc/{memory.pid}/fd").iterdir():
        try:
            st = path.stat()
            device = f"{os.major(st.st_dev):02x}:{os.minor(st.st_dev):02x}"
            if st.st_ino == mapping["inode"] and device == mapping["dev"]:
                dma_fd = int(path.name)
                break
        except OSError:
            continue
    if dma_fd is None:
        raise ValueError("No fd for GUI DMA mapping")
    pid_fd = lib.syscall(434, memory.pid, 0)  # pidfd_open, Linux AArch64
    if pid_fd < 0:
        raise OSError(ctypes.get_errno(), "pidfd_open")
    try:
        duplicate = lib.syscall(438, pid_fd, dma_fd, 0)  # pidfd_getfd
        if duplicate < 0:
            raise OSError(ctypes.get_errno(), "pidfd_getfd")
    finally:
        os.close(pid_fd)
    try:
        # Revalidate the duplicated fd: the target may close/reuse it concurrently.
        if os.fstat(duplicate).st_ino != mapping["inode"]:
            raise ValueError("GUI DMA fd changed during capture")
        offset = address - mapping["start"] + mapping["offset"]
        return read_dma(lib, duplicate, size + offset)[offset:]
    finally:
        os.close(duplicate)


def gui_sample(service, capture, lib):
    pid = int(subprocess.check_output(["systemctl", "show", service, "-p", "MainPID", "--value"]))
    if not pid:
        raise ValueError(f"{service} has no process")
    executable = "/usr/bin/dji_gui_on_disp0" if service == "gui.service" else "/usr/bin/dji_gui_on_disp1"
    if os.readlink(f"/proc/{pid}/exe") != executable:
        raise ValueError("Unexpected native GUI executable")
    stat = pathlib.Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()
    mem = Memory(pid)
    try:
        cycle_address = mem.base("/usr/lib/libewrte_gfx_soft_ttfe.11.00.so") + EW_UPDATE_CYCLE
        agent = mem.u64(mem.base("/usr/lib/libewplatform_unity.so") + PLATFORM_AGENT)
        cycle = mem.u32(cycle_address)
        frame = mem.u64(agent + 0x820)
        free = mem.u64(agent + 0x838)
        if free > 2:
            raise ValueError("Unexpected GUI buffer queue size")
        result = {"pid": pid, "starttime": stat[19], "ew_update_cycle": cycle, "free_buffers": free}
        if capture:
            if frame not in (agent + 0x190, agent + 0x4D8):
                raise ValueError("Unexpected GUI frame context")
            header = mem.read(frame, 0x68)
            address = struct.unpack_from("<Q", header, 8)[0]
            width, height, pitch = struct.unpack_from("<III", header, 0x48)
            size = struct.unpack_from("<I", header, 0x60)[0]
            if (width, height, pitch, size) != (448, 712, 1792, 1275904):
                raise ValueError("Unsupported rear GUI buffer geometry")
            data = read_gui_pixels(lib, mem, address, size)
            pixels = packed_pixels(data, pitch)
            stable = mem.u32(cycle_address) == cycle and mem.u64(agent + 0x820) == frame
            result["capture"] = {"width": 400, "height": 712, "stable": stable,
                                 "sha256": hashlib.sha256(pixels).hexdigest(),
                                 "pixels_zlib": base64.b64encode(zlib.compress(pixels)).decode()}
        return result
    finally:
        mem.close()


if __name__ == "__main__":
    import sys
    for path, expected in FINGERPRINTS.items():
        if hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() != expected:
            raise ValueError("Unsupported display firmware")
    for attempt in range(3):
        sample = gui_sample("gui.service", True, libc_handle())["capture"]
        if sample["stable"]:
            pixels = zlib.decompress(base64.b64decode(sample["pixels_zlib"]))
            sys.stdout.buffer.write(pixels)
            break
    else:
        raise ValueError("Display changed during capture")

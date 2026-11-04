//go:build linux && (amd64 || arm64)

package hwstream

import (
	"errors"
	"fmt"
	"math"
	"runtime"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

type stabilization struct {
	videoEOS               bool
	source, livePad, entry uintptr
	metadata               uintptr
	destroyMetadata        func(uintptr)
	setPointer             func(uintptr, string, uintptr, uintptr)
	gate                   startupGate
	applied                bool
	probes                 []nativeProbe
}
type nativeProbe struct {
	pad      uintptr
	id       uint64
	callback uintptr
}

func checkStabilizationFirmware() error {
	if runtime.GOARCH != "arm64" {
		return errors.New("DJI stabilization requires the inspected ARM64 camera")
	}
	for path, want := range map[string]string{
		"/usr/lib/gstreamer-1.0/libgstdjiqmmfsrc.so":             "4c7c83e8ed5b2771fe05d53b5c2893c6802d5ce274e4e0a75d2f96bf259ab6a9",
		"/usr/lib/camera/components/com.dji.node.eis_preview.so": "c14c9d440dc2a006503d4b3a0807b5ba4d3ee43a40edeb8d6e6f8fd13dbb8c14",
		"/usr/lib/hw/com.qti.chi.override.so":                    "2f57a20c89b79f3e9d88921f8536facd5d1621119f2645918cacf226501231f9",
		"/usr/lib/libalgo_share.so":                              "00339ec9b61f61fac7a3531ab143b17f99369b57b70772e9e8db012e2d631c9f",
		"/usr/lib/gstreamer-1.0/libgstqtifcvtransform.so":        "304772b983ff28e3a69b3f84d547d1230e163964c2a5e7e00179318061582e1c",
		"/etc/adj/eis_param_ov50h40_focus.json":                  "9f41c5498d0017857fab06575a04c5202dc35d7f161e94b7575f632bcc6d4460",
		"/usr/lib/libcamera_metadata.so.0":                       "6e69cf7bae06ce9ae578bb8207523097a5d70bf17710d2b6aab2c42b0d496942",
	} {
		if err := checkedFile(path, want); err != nil {
			return err
		}
	}
	return nil
}

func (s *Capture) prepareStabilization(c Config) error {
	z := &stabilization{}
	s.steady = z // Close owns every reference, including partially initialized state.
	z.source = gst.getByName(s.pipeline, "camera")
	z.entry = gst.getByName(s.pipeline, "videoentry")
	if z.source == 0 || z.entry == 0 {
		return errors.New("stabilization source unavailable")
	}
	var setInt func(uintptr, string, int32, uintptr)
	var setArg func(uintptr, string, string)
	obj, e := purego.Dlopen("libgobject-2.0.so.0", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if e != nil {
		return e
	}
	core, e := purego.Dlopen("libgstreamer-1.0.so.0", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if e != nil {
		return e
	}
	purego.RegisterLibFunc(&setInt, obj, "g_object_set")
	purego.RegisterLibFunc(&z.setPointer, obj, "g_object_set")
	purego.RegisterLibFunc(&setArg, core, "gst_util_set_object_arg")
	for i, role := range []int32{1, 2, 3} {
		pad := gst.getStaticPad(z.source, fmt.Sprintf("video_%d", i))
		if pad == 0 {
			return errors.New("stabilization stream role missing")
		}
		setInt(pad, "type", role, 0)
		if i == 0 {
			// The tee, CPU conversion and hardware encoder retain raw frames.
			// Reserve enough source buffers to avoid exhausting the HAL pool.
			setInt(pad, "extra-buffers", 16, 0)
			z.livePad = pad
		} else {
			gst.unref(pad)
		}
	}
	if gst.setState(s.pipeline, 2) == 0 {
		return errors.New("stabilization camera open failed")
	}
	// Use the verified full-resolution sensor/preview graph for all outputs.
	// FastCV scales it down to the selected encoder size.
	lowPower, sensor, timing := int32(0), int32(0x0e0e), "<5,-320,1,0>"
	setInt(z.source, "lowpower-lv-enable", lowPower, 0)
	setInt(z.source, "pick-sensormode", sensor, 0)
	setInt(z.source, "max-hal-requests", 8, 0)
	setArg(z.source, "eis-algo-params", timing)
	if err := z.makeMetadata(c); err != nil {
		return err
	}
	if gst.setState(s.pipeline, 3) == 0 {
		return errors.New("stabilization track configuration failed")
	}
	for i := 1; i <= 2; i++ {
		pad := gst.getStaticPad(z.source, fmt.Sprintf("video_%d", i))
		ok := gst.setPadActive(pad, 0)
		gst.unref(pad)
		if ok == 0 {
			return errors.New("could not deactivate unused stabilization track")
		}
	}
	if err := z.addProbe(z.livePad, func(uintptr) bool { z.gate.seen.Store(true); return true }); err != nil {
		return err
	}
	video := gst.getByName(s.pipeline, "videogate")
	if video == 0 {
		return errors.New("stabilization video gate missing")
	}
	pad := gst.getStaticPad(video, "src")
	gst.unref(video)
	if pad == 0 {
		return errors.New("stabilization video gate pad missing")
	}
	err := z.addProbe(pad, func(buf uintptr) bool {
		t := (*bufferTimes)(unsafe.Pointer(buf))
		flags := gst.bufferFlags(buf)
		z.gate.encoded.Add(1)
		if flags&(1<<13) == 0 {
			z.gate.keyframes.Add(1)
		}
		ok := z.gate.video(t.pts, flags, time.Now())
		if ok {
			z.gate.videoEnd.Store(bufferEnd(t))
		}
		return ok
	})
	gst.unref(pad)
	if err != nil {
		return err
	}
	if s.mic != 0 {
		audio := gst.getByName(s.pipeline, "audiogate")
		if audio == 0 {
			return errors.New("stabilization audio gate missing")
		}
		pad = gst.getStaticPad(audio, "src")
		gst.unref(audio)
		if pad == 0 {
			return errors.New("stabilization audio gate pad missing")
		}
		err = z.addProbe(pad, func(buf uintptr) bool {
			t := (*bufferTimes)(unsafe.Pointer(buf))
			ok := z.gate.audio(t.pts)
			if ok {
				z.gate.audioEnd.Store(bufferEnd(t))
			}
			return ok
		})
		if err == nil {
			err = z.watchAudioEOS(pad)
		}
		gst.unref(pad)
		if err != nil {
			return err
		}
	}
	return nil
}

func (z *stabilization) makeMetadata(c Config) error {
	lib, e := purego.Dlopen("libcamera_metadata.so.0", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if e != nil {
		return e
	}
	prefix := "_ZN7android8hardware6camera6common4V1_06helper14CameraMetadata"
	var construct func(uintptr)
	var updateByte func(uintptr, uint32, unsafe.Pointer, uintptr) int32
	purego.RegisterLibFunc(&construct, lib, prefix+"C1Ev")
	purego.RegisterLibFunc(&z.destroyMetadata, lib, prefix+"D1Ev")
	purego.RegisterLibFunc(&updateByte, lib, prefix+"6updateEjPKhm")
	// CameraMetadata's inspected ABI fits within this aligned, zeroed C allocation.
	z.metadata = gst.malloc0(64)
	if z.metadata == 0 {
		return errors.New("stabilization metadata allocation failed")
	}
	construct(z.metadata)
	mode, fov := byte(2), byte(1)
	switch c.Stabilization {
	case "horizonsteady":
		mode, fov = 3, 2
	case "horizonbalancing":
		mode, fov = 6, 2
	}
	for _, t := range []struct {
		tag   uint32
		value []byte
	}{
		{0x80b7001a, []byte{mode}}, {0x80b70021, []byte{fov}},
		{0x80b70029, []byte{0, 0, 0}}, {0x00110000, []byte{0}},
	} {
		if updateByte(z.metadata, t.tag, unsafe.Pointer(&t.value[0]), uintptr(len(t.value))) != 0 {
			return errors.New("stabilization metadata update failed")
		}
		runtime.KeepAlive(t.value)
	}
	return nil
}
func (z *stabilization) addProbe(pad uintptr, allow func(uintptr) bool) error {
	gst.ref(pad)
	cb := purego.NewCallback(func(_ uintptr, info uintptr, _ uintptr) uintptr {
		buf := gst.probeBuffer(info)
		if buf == 0 || !allow(buf) {
			return 0
		}
		return 1
	})
	id := gst.addProbe(pad, 16, cb, 0, 0)
	if id == 0 {
		gst.unref(pad)
		return errors.New("stabilization frame probe unavailable")
	}
	z.probes = append(z.probes, nativeProbe{pad, id, cb})
	return nil
}
func (z *stabilization) update() {
	if !z.applied && z.gate.seen.Load() {
		z.setPointer(z.source, "video-metadata", z.metadata, 0)
		z.applied = true
		z.gate.readyAfter.Store(time.Now().Add(time.Second).UnixNano())
	}
}
func (z *stabilization) close() {
	for _, p := range z.probes {
		gst.removeProbe(p.pad, p.id)
		gst.unref(p.pad)
	}
	z.probes = nil
	if z.metadata != 0 {
		z.destroyMetadata(z.metadata)
		gst.free(z.metadata)
		z.metadata = 0
	}
	for _, h := range []uintptr{z.livePad, z.source, z.entry} {
		if h != 0 {
			gst.unref(h)
		}
	}
	z.livePad, z.source, z.entry = 0, 0, 0
}

func bufferEnd(t *bufferTimes) uint64 {
	if t.duration == math.MaxUint64 {
		return t.pts
	}
	return t.pts + t.duration
}
func (z *stabilization) watchAudioEOS(pad uintptr) error {
	eos := gst.newEOS()
	eosType := *(*uint32)(unsafe.Pointer(eos + 64))
	gst.eventUnref(eos)
	gst.ref(pad)
	cb := purego.NewCallback(func(_ uintptr, info uintptr, _ uintptr) uintptr {
		event := gst.probeEvent(info)
		if event != 0 && *(*uint32)(unsafe.Pointer(event + 64)) == eosType {
			z.gate.audioEOS.Store(true)
		}
		return 1
	})
	id := gst.addProbe(pad, 64, cb, 0, 0)
	if id == 0 {
		gst.unref(pad)
		return errors.New("stabilization audio EOS probe unavailable")
	}
	z.probes = append(z.probes, nativeProbe{pad, id, cb})
	return nil
}
func (z *stabilization) drain() {
	// Let delayed video catch the captured audio endpoint before ending video.
	if !z.videoEOS && z.gate.drained() {
		z.videoEOS = true
		gst.sendEvent(z.entry, gst.newEOS())
	}
}

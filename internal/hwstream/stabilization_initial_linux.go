//go:build linux && (amd64 || arm64)

package hwstream

import (
	"errors"
	"runtime"
	"unsafe"

	"github.com/ebitengine/purego"
)

// Populate the inspected source's stored startup metadata before opening the
// camera. Video-metadata writes made before PLAYING are replaced by the source's
// startup defaults. Writes made after the first frame leave the recording
// smoother initialized in the previous mode, despite the node's new mode tag.
//
// The source serializes its GstStructure buckets by section name and typed field
// name when building the initial CameraMetadata. Its empty NR-tuning bucket is
// repurposed as a vendor-metadata carrier. This changes only our source object's
// memory, not DJI libraries or persistent settings. The context owns/frees it.
func seedInitialEIS(source uintptr, c Config) error {
	if !c.HorizonMode() {
		return nil
	}
	if runtime.GOARCH != "arm64" {
		return errors.New("initial EIS metadata requires the inspected ARM64 source")
	}
	if err := checkedFile("/usr/lib/gstreamer-1.0/libgstdjiqmmfsrc.so", "4c7c83e8ed5b2771fe05d53b5c2893c6802d5ce274e4e0a75d2f96bf259ab6a9"); err != nil {
		return err
	}
	lib, err := purego.Dlopen("libgstreamer-1.0.so.0", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return err
	}
	var newStructure func(string) uintptr
	var name func(uintptr) uintptr
	var fields func(uintptr) int32
	var set func(uintptr, string, uintptr, int32, uintptr)
	var free func(uintptr)
	purego.RegisterLibFunc(&newStructure, lib, "gst_structure_new_empty")
	purego.RegisterLibFunc(&name, lib, "gst_structure_get_name")
	purego.RegisterLibFunc(&fields, lib, "gst_structure_n_fields")
	purego.RegisterLibFunc(&set, lib, "gst_structure_set")
	purego.RegisterLibFunc(&free, lib, "gst_structure_free")
	context := *(*uintptr)(unsafe.Pointer(source + 0x130))
	if context == 0 || *(*int32)(unsafe.Pointer(context + 0x24)) != 1 {
		return errors.New("unexpected initial source state")
	}
	slot := (*uintptr)(unsafe.Pointer(context + 0xa0))
	old := *slot
	if old == 0 || cString(name(old)) != "org.quic.camera.anr_tuning" || fields(old) != 0 {
		return errors.New("unexpected startup metadata bucket")
	}
	mode, fov := int32(2), int32(1)
	switch c.Stabilization {
	case "horizonsteady":
		mode, fov = 3, 2
	case "horizonbalancing":
		mode, fov = 6, 2
	}
	initial := newStructure("com.dji.camera")
	if initial == 0 {
		return errors.New("initial metadata allocation failed")
	}
	set(initial, "EISSteadyMode", 16, mode, 0) // G_TYPE_UCHAR, promoted int
	set(initial, "FovCtrlMode", 16, fov, 0)
	if fields(initial) != 2 {
		free(initial)
		return errors.New("initial metadata fields missing")
	}
	*slot = initial // The context now owns this GstStructure until source destruction.
	free(old)
	return nil
}

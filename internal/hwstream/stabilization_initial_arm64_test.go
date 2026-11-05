//go:build linux && arm64

package hwstream

import (
	"testing"
	"unsafe"

	"github.com/ebitengine/purego"
)

func TestInitialEISSeedWithoutCamera(t *testing.T) {
	if err := checkedFile("/usr/lib/gstreamer-1.0/libgstdjiqmmfsrc.so", "4c7c83e8ed5b2771fe05d53b5c2893c6802d5ce274e4e0a75d2f96bf259ab6a9"); err != nil {
		t.Fatal(err)
	}
	core, err := purego.Dlopen("libgstreamer-1.0.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		t.Fatal(err)
	}
	obj, err := purego.Dlopen("libgobject-2.0.so.0", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		t.Fatal(err)
	}
	var initialize func(uintptr, uintptr)
	var factory func(string, string) uintptr
	var unref func(uintptr)
	var value func(uintptr, string) uintptr
	var uchar func(uintptr) uint8
	purego.RegisterLibFunc(&initialize, core, "gst_init")
	initialize(0, 0)
	purego.RegisterLibFunc(&factory, core, "gst_element_factory_make")
	purego.RegisterLibFunc(&unref, core, "gst_object_unref")
	purego.RegisterLibFunc(&value, core, "gst_structure_get_value")
	purego.RegisterLibFunc(&uchar, obj, "g_value_get_uchar")
	for mode, wantMode := range map[string]uint8{"horizonsteady": 3, "horizonbalancing": 6} {
		t.Run(mode, func(t *testing.T) {
			source := factory("djiqmmfsrc", "initial-eis-seed-test")
			if source == 0 {
				t.Fatal("source unavailable")
			}
			defer unref(source)
			c := DefaultConfig()
			c.Stabilization = mode
			if err := seedInitialEIS(source, c); err != nil {
				t.Fatal(err)
			}
			context := *(*uintptr)(unsafe.Pointer(source + 0x130))
			structure := *(*uintptr)(unsafe.Pointer(context + 0xa0))
			for key, want := range map[string]uint8{"EISSteadyMode": wantMode, "FovCtrlMode": 2} {
				v := value(structure, key)
				if v == 0 || uchar(v) != want {
					t.Fatalf("%s missing or mistyped", key)
				}
			}
			if *(*int32)(unsafe.Pointer(context + 0x24)) != 1 {
				t.Fatal("camera unexpectedly opened")
			}
		})
	}
}

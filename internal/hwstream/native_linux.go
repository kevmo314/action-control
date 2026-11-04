//go:build linux && (amd64 || arm64)

package hwstream

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

// Opaque GStreamer handles avoid depending on private vendor struct layouts.
// Functions are from the stable GStreamer 1.x C ABI.
type gstAPI struct {
	init              func(uintptr, uintptr, *uintptr) int32
	parse             func(string, *uintptr) uintptr
	getByName         func(uintptr, string) uintptr
	setState          func(uintptr, int32) int32
	unref             func(uintptr)
	sampleUnref       func(uintptr)
	pull              func(uintptr, uint64) uintptr
	isEOS             func(uintptr) int32
	getBuffer         func(uintptr) uintptr
	getSize           func(uintptr) uintptr
	extract           func(uintptr, uintptr, unsafe.Pointer, uintptr) uintptr
	getBus            func(uintptr) uintptr
	pop               func(uintptr, uint64, uint32) uintptr
	parseError        func(uintptr, *uintptr, *uintptr)
	messageUnref      func(uintptr)
	errorFree         func(uintptr)
	free              func(uintptr)
	getProperty       func(uintptr, string, *uintptr, uintptr)
	setStringProperty func(uintptr, string, string, uintptr)
	newEOS            func() uintptr
	sendEvent         func(uintptr, uintptr) int32
}

var gst gstAPI
var gstOnce sync.Once
var gstErr error

func initGST() error {
	gstOnce.Do(func() {
		defer func() {
			if e := recover(); e != nil {
				gstErr = fmt.Errorf("GStreamer ABI unavailable: %v", e)
			}
		}()
		libs := map[string]uintptr{}
		for _, name := range []string{"libglib-2.0.so.0", "libgobject-2.0.so.0", "libgstreamer-1.0.so.0", "libgstapp-1.0.so.0"} {
			h, err := purego.Dlopen(name, purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if err != nil {
				gstErr = err
				return
			}
			libs[name] = h
		}
		core := libs["libgstreamer-1.0.so.0"]
		app := libs["libgstapp-1.0.so.0"]
		glib := libs["libglib-2.0.so.0"]
		for _, symbol := range []struct {
			target any
			lib    uintptr
			name   string
		}{
			{&gst.init, core, "gst_init_check"}, {&gst.parse, core, "gst_parse_launch"},
			{&gst.getByName, core, "gst_bin_get_by_name"}, {&gst.setState, core, "gst_element_set_state"},
			{&gst.unref, core, "gst_object_unref"}, {&gst.sampleUnref, core, "gst_sample_unref"},
			{&gst.pull, app, "gst_app_sink_try_pull_sample"}, {&gst.isEOS, app, "gst_app_sink_is_eos"},
			{&gst.getBuffer, core, "gst_sample_get_buffer"}, {&gst.getSize, core, "gst_buffer_get_size"},
			{&gst.extract, core, "gst_buffer_extract"}, {&gst.getBus, core, "gst_element_get_bus"},
			{&gst.pop, core, "gst_bus_timed_pop_filtered"}, {&gst.parseError, core, "gst_message_parse_error"},
			{&gst.messageUnref, core, "gst_message_unref"}, {&gst.errorFree, glib, "g_error_free"}, {&gst.free, glib, "g_free"},
			{&gst.getProperty, libs["libgobject-2.0.so.0"], "g_object_get"},
			{&gst.setStringProperty, libs["libgobject-2.0.so.0"], "g_object_set"},
			{&gst.newEOS, core, "gst_event_new_eos"}, {&gst.sendEvent, core, "gst_element_send_event"},
		} {
			purego.RegisterLibFunc(symbol.target, symbol.lib, symbol.name)
		}
		var detail uintptr
		if gst.init(0, 0, &detail) == 0 {
			gstErr = consumeError(detail)
		}
	})
	return gstErr
}

// GError's public ABI is guint32 domain, gint code, gchar *message.
func consumeError(p uintptr) error {
	if p == 0 {
		return errors.New("native capture failed without an error message")
	}
	defer gst.errorFree(p)
	e := (*struct {
		Domain  uint32
		Code    int32
		Message uintptr
	})(unsafe.Pointer(p))
	return errors.New(cString(e.Message))
}
func cString(p uintptr) string {
	if p == 0 {
		return ""
	}
	b := make([]byte, 0, 256)
	for i := uintptr(0); i < 8192; i++ {
		c := *(*byte)(unsafe.Pointer(p + i))
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

type Capture struct {
	pipeline, sink, bus, mic uintptr
	overlay                  uintptr
	overlayFrame             string
	overlayModified          time.Time
	lastOverlayCheck         time.Time
	audioSource              string
	lastAudioCheck           time.Time
	ending                   bool
}

func Open(c Config, testPattern bool) (*Capture, error) {
	if err := initGST(); err != nil {
		return nil, err
	}
	var detail uintptr
	pipeline := gst.parse(c.Pipeline(testPattern), &detail)
	if detail != 0 {
		if pipeline != 0 {
			gst.unref(pipeline)
		}
		return nil, consumeError(detail)
	}
	if pipeline == 0 {
		return nil, errors.New("could not create hardware HEVC pipeline")
	}
	s := &Capture{pipeline: pipeline}
	s.sink = gst.getByName(pipeline, "encoded")
	s.bus = gst.getBus(pipeline)
	if c.OverlayFrame != "" {
		s.overlay = gst.getByName(pipeline, "sceneoverlay")
		s.overlayFrame = c.OverlayFrame
		if s.overlay == 0 {
			s.Close()
			return nil, errors.New("scene overlay element unavailable")
		}
	}
	if c.AudioSource != "none" && c.AudioSource != "" {
		s.mic = gst.getByName(pipeline, "mic")
		s.audioSource = c.AudioSource
	}
	if s.sink == 0 || s.bus == 0 {
		s.Close()
		return nil, errors.New("encoded output unavailable")
	}
	if gst.setState(pipeline, 4) == 0 {
		err := s.nativeError()
		s.Close()
		if err == nil {
			err = errors.New("hardware capture failed to start")
		}
		return nil, err
	}
	return s, nil
}

func (s *Capture) nativeError() error {
	message := gst.pop(s.bus, 0, 2) // GST_MESSAGE_ERROR
	if message == 0 {
		return nil
	}
	defer gst.messageUnref(message)
	var detail, debug uintptr
	gst.parseError(message, &detail, &debug)
	if debug != 0 {
		gst.free(debug)
	}
	return consumeError(detail)
}

// Read returns one MPEG-TS group. The bounded appsink applies backpressure.
// Only encoded data crosses into Go; raw video is never copied into Go memory.
func (s *Capture) Read(ctx context.Context) ([]byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if s.overlay != 0 && !s.ending && time.Since(s.lastOverlayCheck) > 250*time.Millisecond {
			s.lastOverlayCheck = time.Now()
			info, err := os.Stat(s.overlayFrame)
			if err != nil || time.Since(info.ModTime()) > 15*time.Second {
				return nil, errors.New("scene renderer stopped updating; stopping stream")
			}
			if !info.ModTime().Equal(s.overlayModified) {
				gst.setStringProperty(s.overlay, "location", s.overlayFrame, 0)
				s.overlayModified = info.ModTime()
			}
		}
		if err := s.nativeError(); err != nil {
			return nil, err
		}
		sample := gst.pull(s.sink, uint64(100*time.Millisecond))
		if sample == 0 {
			if gst.isEOS(s.sink) != 0 {
				return nil, io.EOF
			}
			continue
		}
		buf := gst.getBuffer(sample)
		if !s.ending && s.mic != 0 && time.Since(s.lastAudioCheck) > 250*time.Millisecond {
			var current uintptr
			gst.getProperty(s.mic, "current-device", &current, 0)
			name := cString(current)
			if current != 0 {
				gst.free(current)
			}
			s.lastAudioCheck = time.Now()
			if name != "" && name != s.audioSource {
				gst.sampleUnref(sample)
				return nil, errors.New("microphone routing changed; stream stopped instead of switching inputs")
			}
		}
		size := gst.getSize(buf)
		if size == 0 || size > 2<<20 {
			gst.sampleUnref(sample)
			return nil, errors.New("invalid encoded buffer size")
		}
		data := make([]byte, int(size))
		n := gst.extract(buf, 0, unsafe.Pointer(&data[0]), size)
		runtime.KeepAlive(data)
		gst.sampleUnref(sample)
		if n != size {
			return nil, io.ErrUnexpectedEOF
		}
		return data, nil
	}
}

func (s *Capture) Close() {
	if s.pipeline != 0 {
		gst.setState(s.pipeline, 1)
	} // GST_STATE_NULL
	for _, h := range []uintptr{s.overlay, s.mic, s.sink, s.bus, s.pipeline} {
		if h != 0 {
			gst.unref(h)
		}
	}
	s.sink, s.bus, s.pipeline = 0, 0, 0
	s.mic = 0
	s.overlay = 0
}

// End flushes the encoders and muxer before the transport is closed.
func (s *Capture) End() { s.ending = true; gst.sendEvent(s.pipeline, gst.newEOS()) }

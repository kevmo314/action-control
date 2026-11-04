//go:build linux && (amd64 || arm64)

package hwstream

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

// GstBuffer and GstPadProbeInfo are public GStreamer 1.x C ABI structures.
// Only the documented timestamp fields of a writable, 64-bit GstBuffer are used.
type bufferTimes struct {
	miniObject         [64]byte
	pool               uintptr
	pts, dts, duration uint64
}

type audioProcessor struct {
	mode          string
	maxElapsed    time.Duration
	eventPad      uintptr
	eventProbe    uint64
	eventCallback uintptr
	eosType       uint32
	flushed       bool
	lastInputPTS  uint64
	mu            sync.Mutex
	err           error
	process       func([]byte, []byte) error
	closeNative   func()
	block         int
	delay         time.Duration
	frames        uint64
	samples       uint64
	elapsed       time.Duration
	input, output []byte
	metadata      [512]byte
	pad           uintptr
	probe         uint64
	callback      uintptr
}

var neuralOwner sync.Mutex

func checkedFile(path, want string) error {
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	if fmt.Sprintf("%x", sha256.Sum256(b)) != want {
		return fmt.Errorf("unsupported firmware asset: %s", path)
	}
	return nil
}
func openAudioProcessor(mode string) (w *audioProcessor, err error) {
	if runtime.GOARCH != "arm64" {
		return nil, errors.New("on-camera neural audio requires ARM64")
	}
	if !neuralOwner.TryLock() {
		return nil, errors.New("another neural audio instance is active")
	}
	success := false
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("native audio ABI: %v", r)
		}
		if !success {
			neuralOwner.Unlock()
		}
	}()
	w = &audioProcessor{mode: mode}
	switch mode {
	case "dji":
		for path, hash := range map[string]string{
			"/usr/lib/libapuapi.so":   "184b31c22618ec014e71725ce5d8babdf27664d1b91e73f555957debfa4b93ff",
			"/usr/lib/libwns.so":      "6ffa9bcbce666ee0afb4c62042b53d6b51c9a9e86be5a2ea3784a65576dd82ce",
			"/etc/libwns.bin.eng.enc": "90be86b487ebbad41b427ad0c83674d1635ccfe0002eb5a885a90a23ffeaa00d",
		} {
			if e := checkedFile(path, hash); e != nil {
				return nil, e
			}
		}
		h, e := purego.Dlopen("libapuapi.so", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if e != nil {
			return nil, e
		}
		var init func() int32
		var process func(unsafe.Pointer, unsafe.Pointer, uintptr, unsafe.Pointer) int32
		var close func() int32
		purego.RegisterLibFunc(&init, h, "dji_audio_nn_init")
		purego.RegisterLibFunc(&process, h, "dji_audio_nn_proc_v2")
		purego.RegisterLibFunc(&close, h, "dji_audio_nn_deinit")
		if rc := init(); rc != 0 {
			return nil, fmt.Errorf("DJI neural audio initialization returned %d", rc)
		}
		w.block, w.delay = 1024, 128*time.Millisecond
		binary.LittleEndian.PutUint32(w.metadata[124:], math.Float32bits(1))
		binary.LittleEndian.PutUint32(w.metadata[128:], math.Float32bits(1))
		w.process = func(in, out []byte) error {
			rc := process(unsafe.Pointer(&out[0]), unsafe.Pointer(&in[0]), uintptr(len(in)), unsafe.Pointer(&w.metadata[0]))
			if rc != 0 {
				return fmt.Errorf("DJI neural audio returned %d", rc)
			}
			return nil
		}
		w.closeNative = func() { close() }

	case "rnnoise":
		exe, e := os.Executable()
		if e != nil {
			return nil, e
		}
		path := filepath.Join(filepath.Dir(exe), "librnnoise-small.so")
		h, e := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_LOCAL)
		if e != nil {
			return nil, fmt.Errorf("RNNoise small library: %w", e)
		}
		var create func(uintptr) uintptr
		var process func(uintptr, unsafe.Pointer, unsafe.Pointer) float32
		var destroy func(uintptr)
		var frameSize func() int32
		purego.RegisterLibFunc(&create, h, "rnnoise_create")
		purego.RegisterLibFunc(&process, h, "rnnoise_process_frame")
		purego.RegisterLibFunc(&destroy, h, "rnnoise_destroy")
		purego.RegisterLibFunc(&frameSize, h, "rnnoise_get_frame_size")
		if frameSize() != 480 {
			return nil, errors.New("unsupported RNNoise frame size")
		}
		handle := create(0)
		if handle == 0 {
			return nil, errors.New("RNNoise initialization failed")
		}
		inFloats, outFloats := make([]float32, 480), make([]float32, 480)
		w.block, w.delay = 480, 20*time.Millisecond
		w.process = func(in, out []byte) error {
			for i := range inFloats {
				inFloats[i] = float32(int16(binary.LittleEndian.Uint16(in[2*i:])))
			}
			process(handle, unsafe.Pointer(&outFloats[0]), unsafe.Pointer(&inFloats[0]))
			for i, v := range outFloats {
				if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
					return errors.New("RNNoise produced invalid samples")
				}
				v = float32(math.Max(-32768, math.Min(32767, math.Round(float64(v)))))
				binary.LittleEndian.PutUint16(out[2*i:], uint16(int16(v)))
			}
			return nil
		}
		w.closeNative = func() { destroy(handle) }
	default:
		return nil, errors.New("neural audio mode unavailable")
	}
	w.input = make([]byte, w.block*2)
	w.output = make([]byte, w.block*2)
	success = true
	return w, nil
}

func (w *audioProcessor) attach(pipeline uintptr) error {
	element := gst.getByName(pipeline, "neuralwind")
	if element == 0 {
		return errors.New("neural audio element missing")
	}
	defer gst.unref(element)
	w.pad = gst.getStaticPad(element, "src")
	if w.pad == 0 {
		return errors.New("neural audio output pad missing")
	}
	w.callback = purego.NewCallback(func(_ uintptr, info uintptr, _ uintptr) uintptr {
		w.mu.Lock()
		defer w.mu.Unlock()
		if w.err != nil {
			return 0
		} // GST_PAD_PROBE_DROP
		buf := gst.probeBuffer(info)
		if buf == 0 || gst.getSize(buf) != uintptr(len(w.input)) {
			w.err = errors.New("unexpected neural audio frame size")
			return 0
		}
		if gst.extract(buf, 0, unsafe.Pointer(&w.input[0]), uintptr(len(w.input))) != uintptr(len(w.input)) {
			w.err = errors.New("could not read neural audio frame")
			return 0
		}
		timestamps := (*bufferTimes)(unsafe.Pointer(buf))
		w.lastInputPTS = timestamps.pts
		start := time.Now()
		err := w.process(w.input, w.output)
		duration := time.Since(start)
		w.elapsed += duration
		if duration > w.maxElapsed {
			w.maxElapsed = duration
		}
		w.frames++
		w.samples += uint64(w.block)
		if err != nil {
			w.err = err
			return 0
		}
		// Discard model warmup; later buffers keep the original capture timeline.
		if w.samples <= uint64(w.delay)*48000/uint64(time.Second) {
			return 0
		}
		if gst.miniWritable(buf) == 0 {
			w.err = errors.New("neural audio buffer is not writable")
			return 0
		}
		if gst.fill(buf, 0, unsafe.Pointer(&w.output[0]), uintptr(len(w.output))) != uintptr(len(w.output)) {
			w.err = errors.New("could not update neural audio buffer")
			return 0
		}
		if err := compensateAudioTime(timestamps, w.delay); err != nil {
			w.err = err
			return 0
		}
		runtime.KeepAlive(w)
		return 1 // GST_PAD_PROBE_OK
	})
	w.probe = gst.addProbe(w.pad, 16, w.callback, 0, 0)
	if w.probe == 0 {
		return errors.New("could not attach neural audio processor")
	}

	// Flush delayed samples before the identity forwards EOS. Its source pad has
	// not seen EOS yet, so pushed tail buffers pass through the normal processor.
	w.eventPad = gst.getStaticPad(element, "sink")
	if w.eventPad == 0 {
		return errors.New("neural audio event pad missing")
	}
	eos := gst.newEOS()
	w.eosType = *(*uint32)(unsafe.Pointer(eos + 64))
	gst.eventUnref(eos)
	w.eventCallback = purego.NewCallback(func(_ uintptr, info uintptr, _ uintptr) uintptr {
		event := gst.probeEvent(info)
		if event == 0 || *(*uint32)(unsafe.Pointer(event + 64)) != w.eosType {
			return 1
		}
		w.mu.Lock()
		flush := !w.flushed && w.err == nil && w.frames > 0
		w.flushed = true
		w.mu.Unlock()
		if !flush {
			return 1
		}
		zeros := make([]byte, w.block*2)
		for i := 0; i < int(uint64(w.delay)*48000/uint64(time.Second))/w.block; i++ {
			buf := gst.newAllocate(0, uintptr(len(zeros)), 0)
			if buf == 0 {
				w.mu.Lock()
				w.err = errors.New("neural audio tail allocation failed")
				w.mu.Unlock()
				break
			}
			gst.fill(buf, 0, unsafe.Pointer(&zeros[0]), uintptr(len(zeros)))
			w.mu.Lock()
			next := w.lastInputPTS + uint64(time.Second)*uint64(w.block)/48000
			w.mu.Unlock()
			ts := (*bufferTimes)(unsafe.Pointer(buf))
			ts.pts = next
			ts.duration = uint64(time.Second) * uint64(w.block) / 48000
			if gst.padPush(w.pad, buf) != 0 {
				break
			}
		}
		return 1
	})
	w.eventProbe = gst.addProbe(w.eventPad, 64, w.eventCallback, 0, 0)
	if w.eventProbe == 0 {
		return errors.New("could not attach neural audio tail drain")
	}
	return nil
}
func (w *audioProcessor) failure() error { w.mu.Lock(); defer w.mu.Unlock(); return w.err }
func (w *audioProcessor) close() {
	if w.eventPad != 0 {
		if w.eventProbe != 0 {
			gst.removeProbe(w.eventPad, w.eventProbe)
		}
		gst.unref(w.eventPad)
		w.eventPad = 0
	}
	if w.pad != 0 {
		if w.probe != 0 {
			gst.removeProbe(w.pad, w.probe)
		}
		gst.unref(w.pad)
		w.pad = 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closeNative != nil {
		w.closeNative()
		w.closeNative = nil
		neuralOwner.Unlock()
	}
}

func (w *audioProcessor) stats() ProcessorStats {
	w.mu.Lock()
	defer w.mu.Unlock()
	avg := 0.0
	if w.frames > 0 {
		avg = float64(w.elapsed) / float64(time.Millisecond) / float64(w.frames)
	}
	return ProcessorStats{Mode: w.mode, Frames: w.frames, BlockSamples: w.block, CompensatedDelayMS: int(w.delay / time.Millisecond), AverageMS: avg, MaxMS: float64(w.maxElapsed) / float64(time.Millisecond)}
}

// Processing changes sample content, not capture time. Retimestamp delayed output
// onto the original common pipeline clock; preserve unknown DTS for raw audio.
func compensateAudioTime(t *bufferTimes, delay time.Duration) error {
	d := uint64(delay)
	if t.pts == math.MaxUint64 || t.pts < d {
		return errors.New("invalid neural audio timestamps")
	}
	t.pts -= d
	if t.dts != math.MaxUint64 {
		if t.dts >= d {
			t.dts -= d
		} else {
			t.dts = 0
		}
	}
	return nil
}

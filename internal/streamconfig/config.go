// Package streamconfig connects the camera's frame source and hardware HEVC encoder
// to an application-owned SRT sender. It does not use DJI's livestream service.
package streamconfig

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

type Config struct {
	Stabilization  string `json:"stabilization,omitempty"`
	PreviewFile    string `json:"preview_file,omitempty"`
	Address        string `json:"address"`
	StreamID       string `json:"stream_id"`
	Passphrase     string `json:"passphrase,omitempty"`
	LatencyMS      int    `json:"latency_ms"`
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	FPS            int    `json:"fps"`
	BitrateKbps    int    `json:"bitrate_kbps"`
	AudioSource    string `json:"audio_source"`
	ImageMode      string `json:"image_mode,omitempty"`
	NoiseReduction string `json:"noise_reduction,omitempty"`
	WindFilter     bool   `json:"wind_filter"`
	OverlayFrame   string `json:"overlay_frame,omitempty"`
}

func DefaultConfig() Config {
	return Config{LatencyMS: 1000, Width: 1280, Height: 720, FPS: 30, BitrateKbps: 4000, AudioSource: "auto"}
}

func (c Config) Stabilized() bool { return c.Stabilization != "" && c.Stabilization != "off" }
func (c Config) HorizonMode() bool {
	return c.Stabilization == "horizonsteady" || c.Stabilization == "horizonbalancing"
}
func (c Config) NeuralAudio() bool { return c.NoiseMode() == "dji" || c.NoiseMode() == "rnnoise" }
func (c Config) NoiseMode() string {
	if c.NoiseReduction != "" {
		return c.NoiseReduction
	}
	if c.WindFilter {
		return "highpass"
	}
	return "off"
}
func (c Config) Validate() error {
	switch c.Stabilization {
	case "", "off", "rocksteady", "horizonsteady", "horizonbalancing":
	default:
		return errors.New("unsupported stabilization mode")
	}
	if c.Stabilized() && (c.FPS != 30 || (c.ImageMode != "" && c.ImageMode != "standard")) {
		return errors.New("stabilization currently requires Standard 8-bit at 30 fps")
	}
	switch c.NoiseMode() {
	case "off", "highpass", "dji", "rnnoise":
	default:
		return errors.New("unsupported noise reduction mode")
	}
	if c.NeuralAudio() && c.AudioSource != "regular0" && c.AudioSource != "auto" {
		return errors.New("neural noise reduction requires the internal microphone")
	}

	if c.PreviewFile != "" && (!strings.HasPrefix(c.PreviewFile, "/") || strings.ContainsAny(c.PreviewFile, "\"\\\r\n\x00")) {
		return errors.New("invalid preview path")
	}
	switch c.ImageMode {
	case "", "standard", "10bit", "dlogm", "shdr", "lowlight":
	default:
		return errors.New("unsupported image mode")
	}
	if c.OverlayFrame != "" && (strings.ContainsAny(c.OverlayFrame, "\"\\\r\n\x00") || !strings.HasPrefix(c.OverlayFrame, "/")) {
		return errors.New("overlay frame must be an absolute local path")
	}
	if c.OverlayFrame != "" && (c.ImageMode == "10bit" || c.ImageMode == "dlogm") {
		return errors.New("browser overlays currently require an 8-bit image mode; disable the scene or select Standard")
	}
	if c.ImageMode != "" && c.ImageMode != "standard" && (c.Width != 1920 || c.Height != 1080 || c.FPS != 30) {
		return errors.New("advanced image modes currently require 1920×1080 at 30 fps")
	}
	if !ValidSourceName(c.AudioSource) {
		return errors.New("invalid microphone source name")
	}
	host, port, err := net.SplitHostPort(c.Address)
	p, e := strconv.Atoi(port)
	if err != nil || e != nil || host == "" || p < 1 || p > 65535 || strings.ContainsAny(host, " /\r\n\t") {
		return errors.New("destination must be a hostname or IP address and port, such as 192.168.1.10:9000")
	}
	if len(c.StreamID) > 512 || strings.ContainsAny(c.StreamID, "\x00\r\n") {
		return errors.New("stream ID must be at most 512 bytes without control characters")
	}
	if len(c.Passphrase) != 0 && (len(c.Passphrase) < 10 || len(c.Passphrase) > 79) {
		return errors.New("SRT passphrase must be empty or 10–79 bytes")
	}
	if c.LatencyMS < 20 || c.LatencyMS > 8000 {
		return errors.New("latency must be 20–8000 ms")
	}
	if !((c.Width == 1280 && c.Height == 720) || (c.Width == 1920 && c.Height == 1080) || (c.Width == 2560 && c.Height == 1440)) {
		return errors.New("choose 1280×720, 1920×1080, or 2560×1440")
	}
	if c.FPS != 25 && c.FPS != 30 {
		return errors.New("frame rate must be 25 or 30 fps")
	}
	if c.BitrateKbps < 500 || c.BitrateKbps > 30000 {
		return errors.New("bitrate must be 500–30000 kbps")
	}
	return nil
}

// Pipeline interpolates validated settings and a quoted local renderer path.
// Network URLs and credentials stay outside the native pipeline.
// Raw frames remain in the native pipeline; Go reads the encoded TS packets.
func (c Config) Pipeline(testPattern bool) string {
	source := "djiqmmfsrc camera=0"
	if testPattern {
		source = "videotestsrc is-live=true pattern=ball"
	}
	format, colorimetry := "NV12", ""
	switch c.ImageMode {
	case "10bit":
		format, colorimetry = "P010_10LE", ",colorimetry=bt709"
	case "dlogm":
		format, colorimetry = "P010_10LE", ",colorimetry=bt709-dlogm"
	case "lowlight":
		if !testPattern {
			source += " op-mode=lowlight viull-enable=true"
		}
	case "shdr":
		if !testPattern {
			source += " shdr=true shdr-enable=true"
		}
	}
	overlay := ""
	if c.OverlayFrame != "" {
		overlay = fmt.Sprintf("gdkpixbufoverlay name=sceneoverlay location=\"%s\" overlay-width=%d overlay-height=%d ! ", c.OverlayFrame, c.Width, c.Height)
	}
	split, preview := "", ""
	if c.PreviewFile != "" {
		split = "tee name=sensor ! queue max-size-buffers=4 max-size-bytes=0 max-size-time=0 ! "
		preview = "sensor. ! queue leaky=downstream max-size-buffers=1 max-size-bytes=0 max-size-time=0 ! videorate drop-only=true ! video/x-raw,framerate=2/1 ! videoscale ! video/x-raw,width=640,height=360 ! videoconvert ! video/x-raw,format=I420 ! jpegenc quality=70 ! appsink name=preview sync=false max-buffers=1 drop=true wait-on-eos=false "
	}
	cameraCaps := fmt.Sprintf("video/x-raw,format=%s,width=%d,height=%d,framerate=%d/1%s", format, c.Width, c.Height, c.FPS, colorimetry)
	dummies := ""
	if c.Stabilized() && !testPattern {
		live, auxiliary, compression := "video_0", "video_1", ",compression=ubwc"
		if c.HorizonMode() {
			live, auxiliary, compression = "video_1", "video_0", ""
		}
		source = "djiqmmfsrc name=camera camera=0 camera." + live
		// Linear GBM surfaces can be copied by FastCV for CPU overlays/preview.
		// Horizon modes consume corrected recording output while preview feeds IMU.
		// RockSteady keeps its inactive recording track UBWC for graph selection.
		cameraCaps = fmt.Sprintf("video/x-raw(memory:GBM),format=NV12,colorimetry=bt709,width=2560,height=1440,framerate=30/1 ! queue leaky=downstream max-size-buffers=2 max-size-bytes=0 max-size-time=0 ! qtifcvtransform ! video/x-raw,format=RGBA,width=%d,height=%d,framerate=30/1", c.Width, c.Height)
		dummies = fmt.Sprintf("camera.%s ! video/x-raw(memory:GBM)%s,colorimetry=bt709,format=NV12,width=2560,height=1440,framerate=30/1 ! fakesink sync=false async=false camera.video_2 ! video/x-raw(memory:GBM),colorimetry=bt709,format=NV12,width=2560,height=1440,framerate=30/1 ! fakesink sync=false async=false ", auxiliary, compression)
	}
	encodeConvert := ""
	if c.Stabilized() && !testPattern {
		encodeConvert = "videoconvert ! video/x-raw,format=NV12 ! "
	}
	videoGate := ""
	if c.Stabilized() && !testPattern {
		videoGate = "identity name=videogate ! "
	}
	video := fmt.Sprintf("%s ! %s ! identity name=videoentry ! %s%s%sdjicamc2venc name=videoencoder control-rate=constant target-bitrate=%d idr-interval=%d b-frames=0 ! video/x-h265,stream-format=byte-stream,alignment=au ! h265parse config-interval=-1 ! %squeue max-size-buffers=16 ! mux. ", source, cameraCaps, split, overlay, encodeConvert, c.BitrateKbps*1000, c.FPS, videoGate)
	audio := ""
	if c.AudioSource != "" && c.AudioSource != "none" && c.AudioSource != "auto" {
		capture := fmt.Sprintf("pulsesrc name=mic device=%s provide-clock=false client-name=osmo-stream", c.AudioSource)
		if c.AudioSource == "regular0" {
			// This firmware's PAL source contains three signed-16 PCM lanes in
			// 32-bit containers plus one metadata lane. Avoid PulseAudio remixing
			// the metadata, and normalize the PCM to the advertised 24-bit scale.
			capture += " ! audio/x-raw,format=S24_32LE,rate=48000,channels=4 ! audioconvert ! audio/x-raw,format=F32LE,channels=4 ! audiomixmatrix in-channels=4 out-channels=2 channel-mask=3 matrix=\"<<(double)0.6666666667,(double)0.0,(double)0.3333333333,(double)0.0>,<(double)0.0,(double)0.6666666667,(double)0.3333333333,(double)0.0>>\" ! audioamplify amplification=256 clipping-method=clip"
		}
		filter := ""
		if c.NoiseMode() == "highpass" {
			filter = "audiocheblimit mode=high-pass cutoff=180 poles=4 ripple=0.25 ! "
		}
		audio = fmt.Sprintf("%s ! queue max-size-buffers=16 ! audioconvert ! audioresample ! audio/x-raw,format=F32LE,rate=48000,channels=2 ! %savenc_aac bitrate=128000 ! aacparse ! queue max-size-buffers=16 ! mux. ", capture, filter)
		if c.NeuralAudio() {
			blockBytes := 2048
			if c.NoiseMode() == "rnnoise" {
				blockBytes = 960
			}
			audio = fmt.Sprintf("%s ! queue max-size-buffers=16 ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=1 ! audiobuffersplit output-buffer-size=%d strict-buffer-size=true ! identity name=neuralwind ! audioconvert ! audio/x-raw,format=F32LE,rate=48000,channels=1 ! avenc_aac bitrate=128000 ! aacparse ! queue max-size-buffers=16 ! mux. ", capture, blockBytes)
		}

	}
	if c.Stabilized() && !testPattern && audio != "" {
		audio = strings.Replace(audio, "avenc_aac bitrate=", "identity name=audiogate ! avenc_aac bitrate=", 1)
	}
	return video + audio + preview + dummies + "mpegtsmux name=mux alignment=7 ! appsink name=encoded sync=false max-buffers=8 drop=false wait-on-eos=false"
}

type ProcessorStats struct {
	Mode               string  `json:"mode,omitempty"`
	Frames             uint64  `json:"frames"`
	BlockSamples       int     `json:"block_samples"`
	CompensatedDelayMS int     `json:"compensated_delay_ms"`
	AverageMS          float64 `json:"average_ms"`
	MaxMS              float64 `json:"max_ms"`
}

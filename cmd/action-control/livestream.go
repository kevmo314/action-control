package main

import (
	"action-control/internal/streamconfig"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
)

type livestreamStatus struct {
	AudioProcessing streamconfig.ProcessorStats `json:"audio_processing"`
	State           string                      `json:"state"`
	Codec           string                      `json:"codec"`
	Bytes           uint64                      `json:"bytes"`
	StartedAt       time.Time                   `json:"started_at"`
	UpdatedAt       time.Time                   `json:"updated_at"`
	Error           string                      `json:"error,omitempty"`
	AudioSource     string                      `json:"audio_source"`
	AudioCodec      string                      `json:"audio_codec"`
}
type livestreamRun struct {
	cancel     context.CancelFunc
	done       chan struct{}
	statusFile string
	state      livestreamStatus
}
type livestreamController struct {
	camera *cameraController
	scene  *sceneController
	mu     sync.Mutex
	run    *livestreamRun
	last   livestreamStatus
	config streamconfig.Config
}

func (s *livestreamController) device() (*App, error) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "arm64" {
		return nil, errors.New("hardware livestreaming requires the ARM64 camera")
	}
	a, err := appAt("/")
	if err != nil {
		return nil, err
	}
	if err = a.RequireDevice(); err != nil {
		a.cancel()
		return nil, err
	}
	return a, nil
}
func (s *livestreamController) program() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	for _, p := range []string{filepath.Join(filepath.Dir(exe), "osmo-stream"), filepath.Join(s.camera.app.Dir, "bin/osmo-stream")} {
		if info, e := os.Stat(p); e == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return p, nil
		}
	}
	return "", errors.New("osmo-stream is not installed beside the console or in its bin directory")
}
func (s *livestreamController) snapshot() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.last
	if s.run != nil {
		st = s.run.state
		if st.State != "restoring" && st.State != "stopping" {
			var live livestreamStatus
			if b, e := os.ReadFile(s.run.statusFile); e == nil && json.Unmarshal(b, &live) == nil {
				st = live
			}
		}
	}
	c := s.config
	c.Passphrase = ""
	available, reason := true, ""
	a, err := s.device()
	if err != nil {
		available, reason = false, err.Error()
	} else {
		a.cancel()
	}
	if available {
		if _, err = s.program(); err != nil {
			available, reason = false, err.Error()
		}
	}
	return map[string]any{"status": st, "config": c, "available": available, "reason": reason, "running": s.run != nil, "has_passphrase": s.config.Passphrase != "", "source": "sensor → Codec2 hardware H.265 + PulseAudio AAC → MPEG-TS → Go SRT", "audio": c.AudioSource != "none" && c.AudioSource != ""}
}

func (s *livestreamController) start(config streamconfig.Config) error {
	// Only our renderer may supply a file path, never an HTTP client.
	config.PreviewFile = filepath.Join(s.camera.app.RunDir, "stream-preview.jpg")
	config.OverlayFrame = ""
	frame, sceneErr := s.scene.prepare()
	if sceneErr != nil {
		return sceneErr
	}
	config.OverlayFrame = frame
	if err := config.Validate(); err != nil {
		return err
	}
	a, err := s.device()
	if err != nil {
		return err
	}
	a.cancel()
	if config.NeuralAudio() {
		query, stop := context.WithTimeout(s.camera.app.Ctx, 3*time.Second)
		sources, e := streamconfig.AudioSources(query)
		stop()
		if e != nil {
			return e
		}
		config.AudioSource, e = streamconfig.ResolveAudioSource(config.AudioSource, sources)
		if e != nil {
			return e
		}
		if e = config.Validate(); e != nil {
			return e
		}
	}
	if _, err = s.program(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.run != nil {
		return errors.New("a livestream is already running or changing state")
	}
	if !s.camera.operation.TryLock() {
		return errors.New("a camera operation is in progress")
	}
	if s.camera.status().State != "stopped" || s.camera.app.RebootRequired() {
		s.camera.operation.Unlock()
		return errors.New("restore native camera services before starting a livestream")
	}
	ctx, cancel := context.WithCancel(s.camera.app.Ctx)
	run := &livestreamRun{cancel: cancel, done: make(chan struct{}), statusFile: filepath.Join(s.camera.app.RunDir, "livestream-status.json"), state: livestreamStatus{State: "preparing", Codec: "H.265 / HEVC", StartedAt: time.Now().UTC()}}
	_ = os.Remove(run.statusFile)
	// Preserve the previous frame for Studio before clearing the live file.
	if b, err := os.ReadFile(config.PreviewFile); err == nil {
		_ = atomicWrite(filepath.Join(s.camera.app.RunDir, "camera-background.jpg"), b, 0600)
	}
	_ = os.Remove(config.PreviewFile)
	s.run, s.config = run, config
	go s.send(ctx, run, config)
	return nil
}

func (s *livestreamController) setState(run *livestreamRun, state string) {
	s.mu.Lock()
	run.state.State = state
	s.mu.Unlock()
}

func (s *livestreamController) send(ctx context.Context, run *livestreamRun, config streamconfig.Config) {
	var result error
	restore := false
	configFile := filepath.Join(s.camera.app.RunDir, "livestream-secret.json")
	a, _ := appAt("/")
	defer a.cancel()
	defer func() {
		_ = os.Remove(configFile)
		// Recovery is intentionally independent of HTTP and app cancellation.
		if restore {
			s.setState(run, "restoring")
			if e := s.service(context.Background(), "start"); e != nil {
				result = errors.Join(result, fmt.Errorf("restore native camera service: %w", e))
			} else {
				check, stop := context.WithTimeout(context.Background(), 5*time.Second)
				for {
					st := readNativeCameraStatus(check, a)
					if st.NativeState.Status == "ok" {
						break
					}
					if check.Err() != nil {
						result = errors.Join(result, errors.New("native service restarted but camera recovery is not confirmed"))
						break
					}
					time.Sleep(200 * time.Millisecond)
				}
				stop()
			}
		}
		s.mu.Lock()
		st := run.state
		if b, e := os.ReadFile(run.statusFile); e == nil {
			_ = json.Unmarshal(b, &st)
		}
		st.State = "stopped"
		st.UpdatedAt = time.Now().UTC()
		if result != nil {
			st.State = "error"
			st.Error = result.Error()
		}
		s.last = st
		s.run = nil
		s.config.Passphrase = ""
		s.mu.Unlock()
		run.cancel()
		s.camera.operation.Unlock()
		close(run.done)
	}()
	if err := s.camera.mimoPreview.stop(); err != nil {
		result = err
		return
	}
	status := readNativeCameraStatus(ctx, a)
	if status.NativeState.Status != "ok" || status.Recording == nil || *status.Recording || status.NativeState.CaptureState == nil || *status.NativeState.CaptureState != 0 {
		result = errors.New("camera must be confirmed idle before handing off its sensor")
		return
	}
	if ctx.Err() != nil {
		return
	}
	if config.AudioSource != "" && config.AudioSource != "none" {
		query, stop := context.WithTimeout(ctx, 3*time.Second)
		sources, e := streamconfig.AudioSources(query)
		stop()
		if e != nil {
			result = e
			return
		}
		if _, e = streamconfig.ResolveAudioSource(config.AudioSource, sources); e != nil {
			result = e
			return
		}
	}
	// Only this one runtime service is stopped. No unit files or boot settings change.
	restore = true
	if result = s.service(ctx, "stop"); result != nil {
		return
	}
	if ctx.Err() != nil {
		return
	}
	data, _ := json.Marshal(config)
	if result = atomicWrite(configFile, data, 0600); result != nil {
		return
	}
	program, e := s.program()
	if e != nil {
		result = e
		return
	}
	cmd := ownedCommand(ctx, program, "--config", configFile, "--status-file", run.statusFile)
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	}
	cmd.WaitDelay = 15 * time.Second
	logs := &boundedBuffer{limit: 65536}
	cmd.Stdout = logs
	cmd.Stderr = logs
	defer func() {
		_ = atomicWrite(filepath.Join(s.camera.app.RunDir, "livestream.log"), []byte(logs.Text()), 0600)
	}()
	if result = cmd.Start(); result != nil {
		return
	}
	s.setState(run, "starting")
	if e = cmd.Wait(); e != nil && ctx.Err() == nil {
		var st livestreamStatus
		if b, err := os.ReadFile(run.statusFile); err == nil {
			_ = json.Unmarshal(b, &st)
		}
		if st.Error != "" {
			result = errors.New(st.Error)
		} else {
			result = errors.New("streamer exited; check the receiver and camera connection")
		}
	}
}

func (s *livestreamController) service(ctx context.Context, action string) error {
	ctx, stop := context.WithTimeout(ctx, 10*time.Second)
	defer stop()
	cmd := ownedCommand(ctx, "/bin/systemctl", action, "dji_camera3.service")
	if _, err := os.Stat("/bin/systemctl"); err != nil {
		cmd = ownedCommand(ctx, "/usr/bin/systemctl", action, "dji_camera3.service")
	}
	return cmd.Run()
}

func (s *livestreamController) stop() error {
	s.mu.Lock()
	run := s.run
	if run != nil {
		run.state.State = "stopping"
		run.cancel()
	}
	s.mu.Unlock()
	if run != nil {
		select {
		case <-run.done:
		case <-time.After(22 * time.Second):
			return errors.New("streamer is still stopping or restoring native camera services")
		}
	}
	return nil
}

func registerLivestream(mux *http.ServeMux, c *cameraController) *livestreamController {
	s := &livestreamController{camera: c, config: streamconfig.DefaultConfig(), last: livestreamStatus{State: "stopped", Codec: "H.265 / HEVC"}}
	s.scene = registerScenes(mux, c.app)
	registerRearScreen(mux)
	mux.HandleFunc("GET /api/livestream/preview.jpg", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		active := s.run != nil
		s.mu.Unlock()
		path := filepath.Join(c.app.RunDir, "stream-preview.jpg")
		info, e := os.Stat(path)
		if !active || e != nil || time.Since(info.ModTime()) > 3*time.Second {
			jsonError(w, 503, "preview_unavailable", errors.New("camera preview is available while streaming"))
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeFile(w, r, path)
	})
	mux.HandleFunc("GET /api/livestream/background.jpg", func(w http.ResponseWriter, r *http.Request) {
		// Retain a still when streaming stops. No sensor ownership or service
		// changes are needed to display or refresh this background.
		path := filepath.Join(c.app.RunDir, "stream-preview.jpg")
		info, err := os.Stat(path)
		if err != nil {
			path = filepath.Join(c.app.RunDir, "camera-background.jpg")
			info, err = os.Stat(path)
		}
		if err != nil {
			jsonError(w, 503, "background_unavailable", errors.New("no camera frame has been captured yet"))
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("X-Captured-At", info.ModTime().UTC().Format(time.RFC3339))
		http.ServeFile(w, r, path)
	})
	mux.HandleFunc("GET /api/livestream", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, s.snapshot()) })
	mux.HandleFunc("GET /api/livestream/audio", func(w http.ResponseWriter, r *http.Request) {
		a, err := s.device()
		if err != nil {
			jsonError(w, 503, "audio_unavailable", err)
			return
		}
		a.cancel()
		ctx, stop := context.WithTimeout(r.Context(), 3*time.Second)
		defer stop()
		sources, err := streamconfig.AudioSources(ctx)
		if err != nil {
			jsonError(w, 503, "audio_sources", err)
			return
		}
		jsonResponse(w, 200, map[string]any{"sources": sources, "wireless_source": "source.wireless-mic", "wireless_pairing": "Pair DJI microphones using the camera settings. Existing channel mapping, gain, mute, and pairing are preserved."})
	})
	mux.HandleFunc("POST /api/livestream", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Action   string              `json:"action"`
			Config   streamconfig.Config `json:"config"`
			Takeover bool                `json:"takeover_native"`
		}
		if !readJSON(w, r, &request) {
			return
		}
		var err error
		switch request.Action {
		case "start":
			if !request.Takeover {
				err = errors.New("sensor handoff requires takeover_native=true")
			} else {
				err = s.start(request.Config)
			}
		case "stop":
			err = s.stop()
		default:
			err = errors.New("action must be start or stop")
		}
		if err != nil {
			jsonError(w, 409, "livestream_operation", err)
			return
		}
		jsonResponse(w, 200, s.snapshot())
	})
	return s
}

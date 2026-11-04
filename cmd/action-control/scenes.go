package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// Scene coordinates use a fixed 1280x720 canvas, scaled to the stream resolution.
type sceneSource struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`
	URL     string  `json:"url"`
	HTML    string  `json:"html"`
	X       int     `json:"x"`
	Y       int     `json:"y"`
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	Opacity float64 `json:"opacity"`
	Visible bool    `json:"visible"`
}
type sceneLayout struct {
	Revision uint64        `json:"revision"`
	Enabled  bool          `json:"enabled"`
	Sources  []sceneSource `json:"sources"`
}
type sceneRenderStatus struct {
	Revision  uint64    `json:"revision"`
	UpdatedAt time.Time `json:"updated_at"`
	Error     string    `json:"error,omitempty"`
	FPS       float64   `json:"fps"`
}
type sceneController struct {
	mu                sync.Mutex
	layout            sceneLayout
	status            sceneRenderStatus
	dir               string
	frame             string
	ctx               context.Context
	cancel            context.CancelFunc
	wake              chan struct{}
	done              chan struct{}
	outputDone        chan struct{}
	previewPNG        []byte
	sourcePNGs        map[string][]byte
	reloadEpoch       uint64
	publishedRevision uint64
	outputError       string
}

var sourceID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func validateScene(s sceneLayout) error {
	if len(s.Sources) > 4 {
		return errors.New("a scene supports up to four browser sources")
	}
	seen := map[string]bool{}
	area := 0
	for _, v := range s.Sources {
		if !sourceID.MatchString(v.ID) || seen[v.ID] {
			return errors.New("source IDs must be unique letters, digits, hyphens or underscores")
		}
		seen[v.ID] = true
		if len(v.Name) > 100 || v.Width < 32 || v.Height < 24 || v.Width > 1280 || v.Height > 720 || v.X < 0 || v.Y < 0 || v.X+v.Width > 1280 || v.Y+v.Height > 720 || math.IsNaN(v.Opacity) || math.IsInf(v.Opacity, 0) || v.Opacity < 0 || v.Opacity > 1 {
			return errors.New("source bounds or opacity are invalid")
		}
		area += v.Width * v.Height
		switch v.Kind {
		case "url":
			u, e := url.Parse(v.URL)
			if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || len(v.URL) > 2048 {
				return errors.New("browser source URL must use HTTP or HTTPS")
			}
		case "html":
			if len(v.HTML) > 12000 {
				return errors.New("custom HTML is limited to 12000 bytes per source")
			}
		default:
			return errors.New("source kind must be url or html")
		}
	}
	if area > 1280*720*2 {
		return errors.New("combined browser source area exceeds two full canvases")
	}
	return nil
}
func registerScenes(mux *http.ServeMux, a *App) *sceneController {
	dir := filepath.Join(a.Dir, "studio")
	if runtime.GOARCH == "arm64" {
		if exe, e := os.Executable(); e == nil && filepath.Dir(exe) == "/blackbox/upgrade/osmo-srt/console" {
			dir = filepath.Join(filepath.Dir(exe), "studio")
		}
	}
	ctx, cancel := context.WithCancel(a.Ctx)
	s := &sceneController{dir: dir, frame: filepath.Join(a.RunDir, "scene.png"), ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), done: make(chan struct{}), outputDone: make(chan struct{}), sourcePNGs: make(map[string][]byte), layout: sceneLayout{Sources: []sceneSource{}}}
	if b, e := os.ReadFile(filepath.Join(dir, "scene.json")); e == nil {
		var v sceneLayout
		if json.Unmarshal(b, &v) == nil && validateScene(v) == nil {
			s.layout = v
		}
	}
	mux.HandleFunc("GET /api/scene", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		status := s.status
		if s.outputError != "" {
			status.Error = s.outputError
		}
		jsonResponse(w, 200, map[string]any{"layout": s.layout, "renderer": status, "width": 1280, "height": 720, "target_fps": 2})
	})
	mux.HandleFunc("POST /api/scene", func(w http.ResponseWriter, r *http.Request) {
		var v sceneLayout
		if !readJSON(w, r, &v) {
			return
		}
		if err := validateScene(v); err != nil {
			jsonError(w, 400, "invalid_scene", err)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if v.Revision != s.layout.Revision {
			jsonError(w, 409, "scene_conflict", errors.New("scene changed; reload before saving"))
			return
		}
		v.Revision++
		if v.Sources == nil {
			v.Sources = []sceneSource{}
		}
		b, _ := json.MarshalIndent(v, "", "  ")
		if err := os.MkdirAll(s.dir, 0700); err != nil {
			jsonError(w, 500, "scene_save", err)
			return
		}
		if err := atomicWrite(filepath.Join(s.dir, "scene.json"), b, 0600); err != nil {
			jsonError(w, 500, "scene_save", err)
			return
		}
		// Drop images whose document changed immediately, before navigation begins.
		previous := make(map[string]sceneSource)
		for _, source := range s.layout.Sources {
			previous[source.ID] = source
		}
		for _, source := range v.Sources {
			if old, ok := previous[source.ID]; !ok || !sameSourceDocument(old, source) {
				delete(s.sourcePNGs, source.ID)
			}
			delete(previous, source.ID)
		}
		for id := range previous {
			delete(s.sourcePNGs, id)
		}
		s.layout = v
		select {
		case s.wake <- struct{}{}:
		default:
		}
		jsonResponse(w, 200, map[string]any{"layout": v})
	})
	mux.HandleFunc("GET /api/scene/frame.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "image/png")
		s.mu.Lock()
		data := s.previewPNG
		s.mu.Unlock()
		if len(data) == 0 {
			http.Error(w, "preview is starting", 503)
			return
		}
		_, _ = w.Write(data)
	})
	mux.HandleFunc("GET /api/scene/source/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		data := s.sourcePNGs[r.PathValue("id")]
		reason := s.status.Error
		s.mu.Unlock()
		if len(data) == 0 {
			if reason == "" {
				reason = "source is loading; apply changes to render unsaved sources"
			}
			http.Error(w, reason, 503)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	})
	mux.HandleFunc("POST /api/scene/reload", func(w http.ResponseWriter, r *http.Request) {
		s.reload()
		jsonResponse(w, 200, map[string]bool{"ok": true})
	})
	go s.outputLoop()
	go s.renderLoop()
	return s
}
func (s *sceneController) close() { s.cancel(); <-s.done; <-s.outputDone }

// A fresh, matching revision is required before taking the camera away from DJI.
func (s *sceneController) prepare() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.layout.Enabled {
		return "", nil
	}
	if s.outputError != "" || s.publishedRevision != s.layout.Revision || s.status.Revision != s.layout.Revision || s.status.UpdatedAt.IsZero() || time.Since(s.status.UpdatedAt) > 10*time.Second || s.status.Error != "" {
		return "", errors.New("scene renderer is not ready; check Studio before starting")
	}
	return s.frame, nil
}

type browserSource struct {
	source sceneSource
	ctx    context.Context
	cancel context.CancelFunc
}

func (s *sceneController) renderLoop() {
	defer close(s.done)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var allocator context.Context
	var stopAllocator context.CancelFunc
	tabs := map[string]*browserSource{}
	var appliedReload uint64
	cleanup := func() {
		for _, t := range tabs {
			t.cancel()
		}
		tabs = map[string]*browserSource{}
		if stopAllocator != nil {
			stopAllocator()
			stopAllocator = nil
			allocator = nil
		}
	}
	defer cleanup()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
		case <-ticker.C:
		}
		s.mu.Lock()
		layout := s.layout
		reloadEpoch := s.reloadEpoch
		s.mu.Unlock()
		if reloadEpoch != appliedReload {
			for _, tab := range tabs {
				tab.cancel()
			}
			tabs = map[string]*browserSource{}
			appliedReload = reloadEpoch
		}
		started := time.Now()
		canvas := image.NewNRGBA(image.Rect(0, 0, 1280, 720))
		var renderErr error
		sourcePNGs := make(map[string][]byte)
		if len(layout.Sources) == 0 {
			cleanup()
		} else {
			needed := map[string]bool{}
			for _, v := range layout.Sources {
				if !v.Visible || v.Opacity == 0 {
					continue
				}
				needed[v.ID] = true
				if allocator == nil {
					endpoint := os.Getenv("OSMO_BROWSER_URL")
					if endpoint == "" {
						endpoint = "http://127.0.0.1:9222"
					}
					allocator, stopAllocator = chromedp.NewRemoteAllocator(s.ctx, endpoint)
				}
				t := tabs[v.ID]
				if t != nil && (!sameSourceDocument(t.source, v)) {
					t.cancel()
					delete(tabs, v.ID)
					t = nil
				}
				if t == nil {
					tc, cancel := chromedp.NewContext(allocator)
					t = &browserSource{source: v, ctx: tc, cancel: cancel}
					tabs[v.ID] = t
					target := v.URL
					if v.Kind == "html" {
						target = "data:text/html;charset=utf-8;base64," + base64.StdEncoding.EncodeToString([]byte(v.HTML))
					}
					// Allocate using the page lifetime, so cancelling a navigation timeout
					// cannot close the page or its browser connection after a successful load.
					timer := time.AfterFunc(10*time.Second, cancel)
					firstErr := chromedp.Run(tc)
					timer.Stop()
					if firstErr != nil {
						t.cancel()
						delete(tabs, v.ID)
						renderErr = firstErr
						continue
					}
					initCtx, stop := context.WithTimeout(tc, 10*time.Second)
					err := chromedp.Run(initCtx, chromedp.EmulateViewport(int64(v.Width), int64(v.Height)), chromedp.ActionFunc(func(ctx context.Context) error {
						// Browser-level settings survive document navigation and do not
						// override author CSS (including an explicit white background).
						if err := emulation.SetScrollbarsHidden(true).Do(ctx); err != nil {
							return err
						}
						return emulation.SetDefaultBackgroundColorOverride().WithColor(&cdp.RGBA{R: 0, G: 0, B: 0, A: 0}).Do(ctx)
					}), chromedp.Navigate(target))
					stop()
					if err != nil {
						t.cancel()
						delete(tabs, v.ID)
						renderErr = fmt.Errorf("%s: %w", v.Name, err)
						continue
					}
				}
				var data []byte
				shotCtx, stop := context.WithTimeout(t.ctx, 3*time.Second)
				err := chromedp.Run(shotCtx, chromedp.ActionFunc(func(ctx context.Context) error { return page.BringToFront().Do(ctx) }), chromedp.CaptureScreenshot(&data))
				stop()
				if err != nil {
					t.cancel()
					delete(tabs, v.ID)
					renderErr = fmt.Errorf("%s: %w", v.Name, err)
					continue
				}
				sourcePNGs[v.ID] = data
				im, err := png.Decode(bytes.NewReader(data))
				if err != nil {
					renderErr = err
					continue
				}
				draw.DrawMask(canvas, image.Rect(v.X, v.Y, v.X+v.Width, v.Y+v.Height), im, im.Bounds().Min, image.NewUniform(color.Alpha{A: uint8(math.Round(v.Opacity * 255))}), image.Point{}, draw.Over)
			}
			for id, t := range tabs {
				if !needed[id] {
					t.cancel()
					delete(tabs, id)
				}
			}
		}
		var out bytes.Buffer
		if renderErr == nil {
			encoder := png.Encoder{CompressionLevel: png.BestSpeed}
			renderErr = encoder.Encode(&out, canvas)
		}
		s.mu.Lock()
		if layout.Revision == s.layout.Revision && reloadEpoch == s.reloadEpoch {
			s.sourcePNGs = sourcePNGs
			if renderErr == nil {
				s.previewPNG = out.Bytes()

			}
			s.status.Error = ""
			if renderErr != nil {
				s.status.Error = renderErr.Error()
			} else {
				s.status.Revision = layout.Revision
				s.status.UpdatedAt = time.Now().UTC()
				s.status.FPS = math.Min(2, 1/time.Since(started).Seconds())
			}
		}
		s.mu.Unlock()
	}
}

// Output publication is separate from page loading. Turning burn-in off always
// clears a running stream's layer, even if an external preview page has stalled.
func (s *sceneController) outputLoop() {
	defer close(s.outputDone)
	var blank bytes.Buffer
	_ = png.Encode(&blank, image.NewNRGBA(image.Rect(0, 0, 1280, 720)))
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	var publishedAt time.Time
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
		s.mu.Lock()
		if !s.layout.Enabled {
			err := atomicWrite(s.frame, blank.Bytes(), 0600)
			s.outputError = ""
			if err != nil {
				s.outputError = err.Error()
			}
		} else if len(s.previewPNG) > 0 && s.status.Error == "" && s.status.Revision == s.layout.Revision && !s.status.UpdatedAt.Equal(publishedAt) {
			err := atomicWrite(s.frame, s.previewPNG, 0600)
			s.outputError = ""
			if err != nil {
				s.outputError = err.Error()
			} else {
				s.publishedRevision = s.layout.Revision
				publishedAt = s.status.UpdatedAt
			}
		}
		s.mu.Unlock()
	}
}

// Geometry and opacity can change without reloading a browser document.
func sameSourceDocument(a, b sceneSource) bool {
	return a.Kind == b.Kind && a.URL == b.URL && a.HTML == b.HTML && a.Width == b.Width && a.Height == b.Height
}

// Reconnect browser sources after an internet route change, without touching
// camera or GUI services. An in-flight capture cannot publish the old session.
func (s *sceneController) reload() {
	s.mu.Lock()
	s.reloadEpoch++
	s.sourcePNGs = nil
	s.status.UpdatedAt = time.Time{}
	s.status.Error = ""
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

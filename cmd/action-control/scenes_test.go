package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScenePersistenceAndConflict(t *testing.T) {
	a, err := NewApp(testFilesystem(t))
	if err != nil {
		t.Fatal(err)
	}
	defer a.cancel()
	mux := http.NewServeMux()
	s := registerScenes(mux, a)
	layout := sceneLayout{Sources: []sceneSource{{ID: "clock", Name: "Clock", Kind: "html", HTML: "<p>hello</p>", X: 10, Y: 10, Width: 200, Height: 80, Opacity: 1, Visible: true}}}
	save := func(v sceneLayout) *httptest.ResponseRecorder {
		b, _ := json.Marshal(v)
		r := httptest.NewRequest("POST", "/api/scene", bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if w := save(layout); w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	if w := save(layout); w.Code != 409 {
		t.Fatalf("stale editor overwrote newer scene: %d", w.Code)
	}
	path := filepath.Join(s.dir, "scene.json")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private scene storage: %v %v", info, err)
	}
	s.close()
	s2 := registerScenes(http.NewServeMux(), a)
	defer s2.close()
	s2.mu.Lock()
	persisted := s2.layout
	s2.mu.Unlock()
	if persisted.Revision != 1 || len(persisted.Sources) != 1 || persisted.Sources[0].HTML != "<p>hello</p>" {
		t.Fatalf("layout lost on restart: %+v", persisted)
	}
}

func TestSceneMustBeFreshBeforeCameraHandoff(t *testing.T) {
	s := &sceneController{frame: "/tmp/frame.png", layout: sceneLayout{Enabled: true, Revision: 2}}
	if _, e := s.prepare(); e == nil {
		t.Fatal("unrendered scene allowed")
	}
	s.status = sceneRenderStatus{Revision: 1, UpdatedAt: time.Now()}
	if _, e := s.prepare(); e == nil {
		t.Fatal("old revision allowed")
	}
	s.status.Revision = 2
	s.status.UpdatedAt = time.Now().Add(-20 * time.Second)
	if _, e := s.prepare(); e == nil {
		t.Fatal("frozen scene allowed")
	}
	s.status.UpdatedAt = time.Now()
	s.status.Error = "page failed"
	if _, e := s.prepare(); e == nil {
		t.Fatal("failed renderer allowed")
	}
	s.status.Error = ""
	s.publishedRevision = 2
	if p, e := s.prepare(); e != nil || p != s.frame {
		t.Fatalf("fresh scene: %s %v", p, e)
	}
}

func TestRejectInvalidSceneGeometryAndSources(t *testing.T) {
	valid := sceneLayout{Sources: []sceneSource{{ID: "source", Kind: "url", URL: "https://example.com", Width: 300, Height: 100, Opacity: 1, Visible: true}}}
	if err := validateScene(valid); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*sceneLayout){
		"off canvas":    func(s *sceneLayout) { s.Sources[0].X = 1200 },
		"negative size": func(s *sceneLayout) { s.Sources[0].Width = -100 },
		"opacity":       func(s *sceneLayout) { s.Sources[0].Opacity = 2 },
		"local file":    func(s *sceneLayout) { s.Sources[0].URL = "file:///etc/passwd" },
		"script URL":    func(s *sceneLayout) { s.Sources[0].URL = "javascript:alert(1)" },
		"duplicate IDs": func(s *sceneLayout) { s.Sources = append(s.Sources, s.Sources[0]) },
		"too many tabs": func(s *sceneLayout) {
			for _, id := range []string{"a", "b", "c", "d"} {
				v := s.Sources[0]
				v.ID = id
				s.Sources = append(s.Sources, v)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			v := valid
			v.Sources = append([]sceneSource(nil), valid.Sources...)
			mutate(&v)
			if validateScene(v) == nil {
				t.Fatal("invalid scene accepted")
			}
		})
	}
}

func TestStudioPreviewDoesNotLeakIntoDisabledStream(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	preview := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	preview.Set(0, 0, color.NRGBA{R: 255, A: 255})
	var b bytes.Buffer
	if err := png.Encode(&b, preview); err != nil {
		t.Fatal(err)
	}
	s := &sceneController{ctx: ctx, frame: filepath.Join(t.TempDir(), "output.png"), outputDone: make(chan struct{}), layout: sceneLayout{Revision: 7}, status: sceneRenderStatus{Revision: 7, UpdatedAt: time.Now()}, previewPNG: b.Bytes()}
	go s.outputLoop()
	defer func() { cancel(); <-s.outputDone }()
	waitAlpha := func(want uint32) {
		t.Helper()
		until := time.Now().Add(2 * time.Second)
		for time.Now().Before(until) {
			f, e := os.Open(s.frame)
			if e == nil {
				im, e := png.Decode(f)
				f.Close()
				if e == nil {
					_, _, _, a := im.At(0, 0).RGBA()
					if a == want {
						return
					}
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("output did not reach alpha %d", want)
	}
	waitAlpha(0)
	s.mu.Lock()
	s.layout.Enabled = true
	s.mu.Unlock()
	waitAlpha(65535)
	s.mu.Lock()
	s.layout.Enabled = false
	s.status.Error = "preview page stalled"
	s.mu.Unlock()
	waitAlpha(0)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !bytes.Equal(s.previewPNG, b.Bytes()) {
		t.Fatal("disabling burn-in cleared Studio preview")
	}
}

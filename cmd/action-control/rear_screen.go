package main

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"sync"
	"time"
)

//go:embed rear_screen_reader.py
var rearScreenReader string

// Requests share one bounded readback and a two-second cache, including errors.
// The native GUI process is never paused or written to by this reader.
func registerRearScreen(mux *http.ServeMux) {
	var mu sync.Mutex
	var expires time.Time
	var data []byte
	var captureErr error
	mux.HandleFunc("GET /api/camera/rear-screen.png", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Now().After(expires) {
			ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
			cmd := ownedCommand(ctx, "/usr/bin/python3", "-I", "-B", "-c", rearScreenReader)
			var output bytes.Buffer
			cmd.Stdout = &output
			captureErr = cmd.Run()
			cancel()
			data = nil
			if captureErr == nil {
				raw := output.Bytes()
				if len(raw) != 400*712*4 {
					captureErr = fmt.Errorf("unexpected rear screen buffer size")
				} else {
					frame := image.NewNRGBA(image.Rect(0, 0, 712, 400))
					for y := 0; y < 400; y++ {
						for x := 0; x < 712; x++ {
							at := (x*400 + 399 - y) * 4
							to := y*frame.Stride + x*4
							copy(frame.Pix[to:to+4], []byte{raw[at+2], raw[at+1], raw[at], raw[at+3]})
						}
					}
					var encoded bytes.Buffer
					encoder := png.Encoder{CompressionLevel: png.BestSpeed}
					captureErr = encoder.Encode(&encoded, frame)
					if captureErr == nil {
						data = encoded.Bytes()
					}
				}
			}
			expires = time.Now().Add(2 * time.Second)
		}
		result, err := data, captureErr
		mu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		if err != nil {
			jsonError(w, 503, "rear_screen_unavailable", fmt.Errorf("rear screen readback unavailable"))
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(result)
	})
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// This gate only serializes access to our native client. It never represents
// camera ownership, and it does not lock out physical buttons or native clients.
type nativeCameraGate struct {
	once sync.Once
	held chan struct{}
}

func (gate *nativeCameraGate) acquire(ctx context.Context) error {
	gate.once.Do(func() { gate.held = make(chan struct{}, 1) })
	select {
	case gate.held <- struct{}{}:
		if err := ctx.Err(); err != nil {
			gate.release()
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (gate *nativeCameraGate) release() { <-gate.held }

type NativeRecordingControls struct {
	Start bool `json:"start"`
	Stop  bool `json:"stop"`
}

func nativeRecordingControls(observation NativeCameraObservation) NativeRecordingControls {
	var controls NativeRecordingControls
	if recording := nativeRecording(observation); recording != nil {
		controls.Stop = *recording
		controls.Start = !*recording && observation.CaptureState != nil && *observation.CaptureState == 0
	}
	return controls
}

type nativeRecordingRequest struct {
	Action    string `json:"action"`
	RequestID string `json:"request_id"`
}

type NativeRecordingState struct {
	RecordState  *int32 `json:"record_state"`
	CaptureState *int32 `json:"capture_state"`
	ModeProfile  *int32 `json:"mode_profile,omitempty"`
}

type NativeRecordingResult struct {
	Source      string                `json:"source"`
	RequestID   string                `json:"request_id"`
	Action      string                `json:"action"`
	Outcome     string                `json:"outcome"`
	Dispatched  *bool                 `json:"dispatched"`
	NativeCode  *int32                `json:"native_code"`
	Before      *NativeRecordingState `json:"before"`
	After       *NativeRecordingState `json:"after"`
	Message     string                `json:"message"`
	Reason      string                `json:"reason,omitempty"`
	CompletedAt string                `json:"completed_at"`
	Replayed    bool                  `json:"replayed"`
}

func validNativeRecordingAction(action string) bool {
	return action == "start_recording" || action == "stop_recording"
}

// capture and mode switch share the same native client, operation lock, and
// dedup as recording, so no two of them can dispatch at the same time.
func validNativeAction(action string) bool {
	return validNativeRecordingAction(action) || action == "capture" || validNativeModeAction(action)
}

// Only the two verified profiles are exposed; unknown mode integers are never
// offered or sent. mode_photo=5, mode_video=1.
func validNativeModeAction(action string) bool {
	return action == "mode_photo" || action == "mode_video"
}

func nativeModeTarget(action string) int32 {
	if action == "mode_photo" {
		return 5
	}
	return 1
}

type NativeModeControls struct {
	Photo bool `json:"photo"`
	Video bool `json:"video"`
}

// A mode switch dispatches only from the verified idle state. Each button is
// offered only when idle and not already in that profile.
func nativeModeControls(observation NativeCameraObservation) NativeModeControls {
	recording := nativeRecording(observation)
	idle := recording != nil && !*recording &&
		observation.CaptureState != nil && *observation.CaptureState == 0
	profile := observation.ModeProfile
	return NativeModeControls{
		Photo: idle && profile != nil && *profile != 5,
		Video: idle && profile != nil && *profile != 1,
	}
}

type NativeCaptureControls struct {
	Capture bool `json:"capture"`
}

// A photo dispatches only from the verified idle state (not recording, capture
// state zero). Unknown states never enable the button.
func nativeCaptureControls(observation NativeCameraObservation) NativeCaptureControls {
	recording := nativeRecording(observation)
	idle := recording != nil && !*recording &&
		observation.CaptureState != nil && *observation.CaptureState == 0
	return NativeCaptureControls{Capture: idle}
}

func decodeNativeRecording(data []byte, action string) (NativeRecordingResult, error) {
	var wire struct {
		Schema     int                   `json:"schema"`
		Action     string                `json:"action"`
		Outcome    string                `json:"outcome"`
		Dispatched *bool                 `json:"dispatched"`
		NativeCode *int32                `json:"native_code"`
		Before     *NativeRecordingState `json:"before"`
		After      *NativeRecordingState `json:"after"`
		Reason     string                `json:"reason"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return NativeRecordingResult{}, err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return NativeRecordingResult{}, errors.New("extra native recording output")
	}
	if wire.Schema != 1 || !validNativeAction(action) || wire.Action != action || wire.Dispatched == nil {
		return NativeRecordingResult{}, errors.New("incomplete native recording result")
	}
	for _, state := range []*NativeRecordingState{wire.Before, wire.After} {
		if state != nil && (state.RecordState == nil || state.CaptureState == nil) {
			return NativeRecordingResult{}, errors.New("incomplete native recording state")
		}
	}
	dispatched, accepted := *wire.Dispatched, wire.NativeCode != nil && *wire.NativeCode == 0
	valid := false
	if action == "capture" {
		// A photo has no stable target state, so no "confirmed"/"already".
		switch wire.Outcome {
		case "accepted":
			valid = dispatched && accepted && wire.Before != nil
		case "blocked":
			valid = !dispatched && wire.NativeCode == nil && wire.Before != nil && wire.After == nil
		case "rejected":
			valid = dispatched && wire.NativeCode != nil && *wire.NativeCode != 0 && wire.Before != nil
		case "not_sent":
			valid = !dispatched && wire.NativeCode == nil && wire.After == nil
		case "unknown":
			valid = dispatched && wire.After == nil
		}
	} else if validNativeModeAction(action) {
		target := nativeModeTarget(action)
		beforeProfile := wire.Before != nil && wire.Before.ModeProfile != nil
		targetObserved := wire.After != nil && wire.After.ModeProfile != nil && *wire.After.ModeProfile == target
		switch wire.Outcome {
		case "confirmed":
			valid = dispatched && accepted && beforeProfile && targetObserved
		case "accepted":
			valid = dispatched && accepted && beforeProfile
		case "already":
			valid = !dispatched && wire.NativeCode == nil && beforeProfile && *wire.Before.ModeProfile == target && targetObserved
		case "blocked":
			valid = !dispatched && wire.NativeCode == nil && beforeProfile && wire.After == nil
		case "rejected":
			valid = dispatched && wire.NativeCode != nil && *wire.NativeCode != 0 && beforeProfile
		case "not_sent":
			valid = !dispatched && wire.NativeCode == nil && wire.After == nil
		case "unknown":
			valid = dispatched && wire.After == nil
		}
	} else {
		target := int32(1)
		if action == "stop_recording" {
			target = 3
		}
		targetObserved := wire.After != nil && *wire.After.RecordState == target
		switch wire.Outcome {
		case "confirmed":
			valid = dispatched && accepted && wire.Before != nil && targetObserved
		case "accepted":
			valid = dispatched && accepted && wire.Before != nil
		case "already":
			valid = !dispatched && wire.NativeCode == nil && wire.Before != nil && *wire.Before.RecordState == target && targetObserved
		case "blocked":
			valid = !dispatched && wire.NativeCode == nil && wire.Before != nil && wire.After == nil
		case "rejected":
			valid = dispatched && wire.NativeCode != nil && *wire.NativeCode != 0 && wire.Before != nil
		case "not_sent":
			valid = !dispatched && wire.NativeCode == nil && wire.After == nil
		case "unknown":
			valid = dispatched && wire.After == nil
		}
	}
	if !valid {
		return NativeRecordingResult{}, errors.New("inconsistent native recording result")
	}
	return NativeRecordingResult{
		Action: action, Outcome: wire.Outcome, Dispatched: wire.Dispatched,
		NativeCode: wire.NativeCode, Before: wire.Before, After: wire.After, Reason: wire.Reason,
	}, nil
}

func nativeRecordingNotSent(reason string) NativeRecordingResult {
	dispatched := false
	return NativeRecordingResult{Outcome: "not_sent", Dispatched: &dispatched, Reason: reason}
}

func runNativeRecording(ctx context.Context, a *App, action string) NativeRecordingResult {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if !validNativeAction(action) {
		return nativeRecordingNotSent("Unsupported native camera operation.")
	}
	if err := a.nativeIO.acquire(ctx); err != nil {
		return nativeRecordingNotSent("Waiting for native camera access timed out or was cancelled.")
	}
	defer a.nativeIO.release()
	a.nativeReader.invalidate()
	defer a.nativeReader.invalidate()
	output, err := a.Run(ctx, 8*time.Second, "python3", "-I", "-B", "-c", nativeCameraReaderScript, action)
	if err != nil || ctx.Err() != nil {
		// The child may have sent a command before timing out or failing. Neither
		// missing output nor process termination proves that the camera stopped.
		return NativeRecordingResult{Outcome: "unknown", Reason: "Incomplete native response. Check camera status before retrying; do not resend automatically."}
	}
	result, err := decodeNativeRecording(output, action)
	if err != nil {
		return NativeRecordingResult{Outcome: "unknown", Reason: "Invalid native response: " + err.Error()}
	}
	return result
}

func (c *cameraController) executeNativeRecording(action string) NativeRecordingResult {
	ctx, cancel := context.WithTimeout(c.app.Ctx, 8*time.Second)
	defer cancel()
	c.mu.Lock()
	independent := c.run != nil
	c.mu.Unlock()
	if independent || c.app.ScreenRequired() {
		return nativeRecordingNotSent("Independent capture has taken over the native camera. Restore native services first.")
	}
	status := readNativeCameraServices(ctx, c.app)
	available := false
	for _, service := range status.Services {
		if service.Unit == "dji_camera3.service" && service.State == "running" {
			available = true
		}
	}
	if !available || status.Reason != "" {
		return nativeRecordingNotSent("Native camera services have not been confirmed running.")
	}
	return runNativeRecording(ctx, c.app, action)
}

func nativeRecordingMessage(result NativeRecordingResult) string {
	if result.Action == "capture" {
		switch result.Outcome {
		case "accepted":
			return "Camera accepted the photo request. Check the album for the new photo."
		case "blocked":
			return "The current camera state does not allow photos. Stop recording and refresh status shortly."
		case "rejected":
			return fmt.Sprintf("Camera returned an error (code %d). Check the camera display and current status.", *result.NativeCode)
		case "not_sent":
			return "Photo request was not sent. Check native camera status."
		default:
			return "Photo request outcome unknown. Check native status before trying again."
		}
	}
	if validNativeModeAction(result.Action) {
		mode := "photo"
		if result.Action == "mode_video" {
			mode = "video"
		}
		switch result.Outcome {
		case "confirmed":
			return "Switched to " + mode + " mode."
		case "already":
			return "Camera is already in " + mode + " mode; no duplicate switch sent."
		case "accepted":
			return "Switch accepted to " + mode + " mode; not yet confirmed."
		case "blocked":
			return "The current camera state does not allow mode switching. Stop recording and refresh status shortly."
		case "rejected":
			return fmt.Sprintf("Camera returned an error (code %d). Check the camera display and current status.", *result.NativeCode)
		case "not_sent":
			return "Mode switch request was not sent. Check native camera status."
		default:
			return "Mode switch outcome unknown. Check native status before trying again."
		}
	}
	verb := "start"
	if result.Action == "stop_recording" {
		verb = "stop"
	}
	switch result.Outcome {
	case "confirmed":
		return "Observed camera " + verb + " recording."
	case "already":
		if result.Action == "stop_recording" {
			return "Camera is not recording; no duplicate stop command sent."
		}
		return "Camera is already recording; no duplicate start command sent."
	case "accepted":
		return "Camera accepted " + verb + " recording request; state change not yet confirmed."
	case "blocked":
		return "The current camera state does not allow this operation. Refresh status shortly."
	case "rejected":
		return fmt.Sprintf("Camera returned an error (code %d). Check the camera display and current status.", *result.NativeCode)
	case "not_sent":
		return "Recording request was not sent. Check native camera status."
	default:
		return "Recording request outcome unknown. Check native status before trying again."
	}
}

type nativeRecordingAttempt struct {
	action    string
	done      chan struct{}
	result    NativeRecordingResult
	completed time.Time
}

type nativeRecordingController struct {
	camera   *cameraController
	mu       sync.Mutex
	attempts map[string]*nativeRecordingAttempt
}

var (
	nativeRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,80}$`)
	errNativeRequestReuse  = errors.New("The same request_id cannot be reused for different recording operations")
	errNativeActionBusy    = errors.New("A camera operation is already in progress. Refresh status shortly")
	errNativeRequestLimit  = errors.New("Recording requests are too frequent; try again shortly")
)

// Store request results, never a desired recording state. A disconnected HTTP
// waiter does not cancel or repeat a physical action. The shared operation lock
// also excludes Action Control's independent capture/takeover operations.
func (controller *nativeRecordingController) begin(request nativeRecordingRequest, run func() NativeRecordingResult) (*nativeRecordingAttempt, bool, error) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	now := time.Now()
	for id, attempt := range controller.attempts {
		if !attempt.completed.IsZero() && now.Sub(attempt.completed) >= 10*time.Minute {
			delete(controller.attempts, id)
		}
	}
	if attempt := controller.attempts[request.RequestID]; attempt != nil {
		if attempt.action != request.Action {
			return nil, false, errNativeRequestReuse
		}
		return attempt, true, nil
	}
	if len(controller.attempts) >= 256 {
		return nil, false, errNativeRequestLimit
	}
	if !controller.camera.operation.TryLock() {
		return nil, false, errNativeActionBusy
	}
	attempt := &nativeRecordingAttempt{action: request.Action, done: make(chan struct{})}
	if controller.attempts == nil {
		controller.attempts = make(map[string]*nativeRecordingAttempt)
	}
	controller.attempts[request.RequestID] = attempt
	go func() {
		result := run()
		result.Source, result.Action, result.RequestID = "native_binder", request.Action, request.RequestID
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		result.Message = nativeRecordingMessage(result)
		controller.mu.Lock()
		attempt.result, attempt.completed = result, time.Now()
		controller.camera.operation.Unlock()
		close(attempt.done)
		controller.mu.Unlock()
	}()
	return attempt, false, nil
}

func waitNativeRecording(ctx context.Context, attempt *nativeRecordingAttempt, replayed bool) (NativeRecordingResult, error) {
	select {
	case <-ctx.Done():
		return NativeRecordingResult{}, ctx.Err()
	case <-attempt.done:
		result := attempt.result
		result.Replayed = replayed
		return result, nil
	}
}

func (controller *nativeRecordingController) handleRecording(w http.ResponseWriter, r *http.Request) {
	controller.serve(w, r, validNativeRecordingAction, "Requires an explicit recording action and a request_id of 8–80 characters")
}

func (controller *nativeRecordingController) handleCapture(w http.ResponseWriter, r *http.Request) {
	controller.serve(w, r, func(a string) bool { return a == "capture" }, "Requires action=capture and a request_id of 8–80 characters")
}

func (controller *nativeRecordingController) handleMode(w http.ResponseWriter, r *http.Request) {
	controller.serve(w, r, validNativeModeAction, "Requires action=mode_photo|mode_video and a request_id of 8–80 characters")
}

func (controller *nativeRecordingController) serve(w http.ResponseWriter, r *http.Request, allowed func(string) bool, invalidMsg string) {
	var request nativeRecordingRequest
	if !readJSON(w, r, &request) {
		return
	}
	if !allowed(request.Action) || !nativeRequestIDPattern.MatchString(request.RequestID) {
		jsonError(w, 400, "invalid_native_recording_request", errors.New(invalidMsg))
		return
	}
	if err := controller.camera.app.RequireManaged(); err != nil {
		jsonError(w, 503, "device_unavailable", err)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	attempt, replayed, err := controller.begin(request, func() NativeRecordingResult {
		return controller.camera.executeNativeRecording(request.Action)
	})
	if err != nil {
		code := "native_recording_busy"
		status := http.StatusConflict
		if errors.Is(err, errNativeRequestReuse) {
			code = "native_recording_request_reused"
		} else if errors.Is(err, errNativeRequestLimit) {
			code, status = "native_recording_request_limit", http.StatusTooManyRequests
		}
		jsonError(w, status, code, err)
		return
	}
	result, err := waitNativeRecording(r.Context(), attempt, replayed)
	if err != nil {
		return
	}
	// The operation report is available even on native rejection or uncertainty.
	// Clients must inspect outcome; HTTP 200 is not proof of recording success.
	jsonResponse(w, http.StatusOK, result)
}

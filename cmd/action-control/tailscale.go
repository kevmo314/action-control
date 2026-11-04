package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"sort"
	"sync"
	"time"
)

const tailscaleBinary = "/blackbox/upgrade/osmo-srt/tailscale/tailscale"
const tailscaleSocket = "/tmp/osmo-tailscale/tailscaled.sock"

type tailPeer struct {
	ID             string
	HostName       string
	TailscaleIPs   []string
	Online         bool
	ExitNodeOption bool
	ExitNode       bool
}
type tailWireStatus struct {
	BackendState string
	Self         *tailPeer
	Peer         map[string]*tailPeer
}
type tailPrefs struct {
	ExitNodeID             string
	ExitNodeIP             string
	ExitNodeAllowLANAccess bool
}
type tailExitNode struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	IP     string `json:"ip"`
	Online bool   `json:"online"`
	Active bool   `json:"active"`
}
type tailStatus struct {
	Available  bool           `json:"available"`
	State      string         `json:"state"`
	Reason     string         `json:"reason,omitempty"`
	Hostname   string         `json:"hostname"`
	IPs        []string       `json:"ips"`
	ExitNodeID string         `json:"exit_node_id"`
	AllowLAN   bool           `json:"allow_lan"`
	ExitNodes  []tailExitNode `json:"exit_nodes"`
}
type tailRunner func(context.Context, ...string) ([]byte, error)
type tailscaleController struct {
	mu      sync.Mutex
	run     tailRunner
	expires time.Time
	cached  tailStatus
}

func tailView(status tailWireStatus, prefs tailPrefs) tailStatus {
	out := tailStatus{Available: true, State: status.BackendState, ExitNodeID: prefs.ExitNodeID, AllowLAN: prefs.ExitNodeAllowLANAccess, IPs: []string{}, ExitNodes: []tailExitNode{}}
	if status.Self != nil {
		out.Hostname = status.Self.HostName
		out.IPs = status.Self.TailscaleIPs
	}
	for _, peer := range status.Peer {
		if peer == nil || !peer.ExitNodeOption {
			continue
		}
		address := ""
		for _, candidate := range peer.TailscaleIPs {
			if ip, err := netip.ParseAddr(candidate); err == nil && ip.Is4() {
				address = ip.String()
				break
			}
		}
		if address == "" {
			continue
		}
		out.ExitNodes = append(out.ExitNodes, tailExitNode{ID: peer.ID, Name: peer.HostName, IP: address, Online: peer.Online, Active: peer.ExitNode})
		if out.ExitNodeID == "" && prefs.ExitNodeIP == address {
			out.ExitNodeID = peer.ID
		}
	}
	sort.Slice(out.ExitNodes, func(i, j int) bool { return out.ExitNodes[i].Name < out.ExitNodes[j].Name })
	return out
}

// Decode only public status and the three routing preferences. In particular,
// debug prefs also contains private node keys and is never returned or logged.
func (t *tailscaleController) load(ctx context.Context) tailStatus {
	unavailable := func(reason string) tailStatus {
		return tailStatus{State: "Unavailable", Reason: reason, IPs: []string{}, ExitNodes: []tailExitNode{}}
	}
	raw, err := t.run(ctx, "status", "--json")
	if err != nil {
		return unavailable("Cannot reach the camera's Tailscale daemon.")
	}
	var status tailWireStatus
	if json.Unmarshal(raw, &status) != nil {
		return unavailable("Invalid Tailscale status response.")
	}
	raw, err = t.run(ctx, "debug", "prefs")
	if err != nil {
		return unavailable("Cannot read Tailscale routing preferences.")
	}
	var prefs tailPrefs
	if json.Unmarshal(raw, &prefs) != nil {
		return unavailable("Invalid Tailscale preferences response.")
	}
	return tailView(status, prefs)
}

func (t *tailscaleController) selectExit(ctx context.Context, id string) error {
	current := t.load(ctx)
	if !current.Available {
		return errors.New(current.Reason)
	}
	if id != "" && current.State != "Running" {
		return errors.New("Tailscale must be connected before choosing an exit node")
	}
	address := ""
	if id != "" {
		for _, peer := range current.ExitNodes {
			if peer.ID == id && peer.Online {
				address = peer.IP
				break
			}
		}
		if address == "" {
			return errors.New("choose an online exit node from the current tailnet")
		}
	}
	// set changes just these preferences, preserving login, Serve and other flags.
	// LAN access keeps the camera's Wi-Fi gateway and browser DNS reachable.
	args := []string{"set", "--exit-node=" + address}
	if address != "" {
		args = append(args, "--exit-node-allow-lan-access=true")
	}
	if _, err := t.run(ctx, args...); err != nil {
		return fmt.Errorf("could not apply exit node; refresh Tailscale status")
	}
	return nil
}

func registerTailscale(mux *http.ServeMux, reconnectWebviews func()) {
	t := &tailscaleController{run: func(ctx context.Context, args ...string) ([]byte, error) {
		return ownedCommand(ctx, tailscaleBinary, append([]string{"--socket=" + tailscaleSocket}, args...)...).Output()
	}}
	mux.HandleFunc("GET /api/tailscale", func(w http.ResponseWriter, r *http.Request) {
		t.mu.Lock()
		if time.Now().After(t.expires) {
			ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
			t.cached = t.load(ctx)
			cancel()
			t.expires = time.Now().Add(3 * time.Second)
		}
		status := t.cached
		t.mu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		jsonResponse(w, 200, status)
	})
	mux.HandleFunc("POST /api/tailscale/exit-node", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID string `json:"id"`
		}
		if !readJSON(w, r, &request) {
			return
		}
		if len(request.ID) > 128 {
			jsonError(w, 400, "invalid_exit_node", errors.New("invalid exit node identifier"))
			return
		}
		t.mu.Lock()
		defer t.mu.Unlock()
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		err := t.selectExit(ctx, request.ID)
		t.expires = time.Time{}
		if err != nil {
			jsonError(w, 400, "exit_node_failed", err)
			return
		}
		if reconnectWebviews != nil {
			reconnectWebviews()
		}
		jsonResponse(w, 200, map[string]any{"ok": true, "exit_node_id": request.ID})
	})
}

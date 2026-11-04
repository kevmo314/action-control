package main

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestTailStatusDoesNotExposePrivatePreferences(t *testing.T) {
	runner := func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] == "status" {
			return []byte(`{"BackendState":"Running","Self":{"HostName":"camera","TailscaleIPs":["100.64.0.2"]},"Peer":{"key":{"ID":"node-a","HostName":"Exit A","TailscaleIPs":["100.64.0.3"],"Online":true,"ExitNodeOption":true}}}`), nil
		}
		return []byte(`{"ExitNodeID":"node-a","ExitNodeAllowLANAccess":true,"Persist":{"PrivateNodeKey":"NEVER-EXPOSE-THIS"}}`), nil
	}
	controller := tailscaleController{run: runner}
	status := controller.load(context.Background())
	if !status.Available || status.ExitNodeID != "node-a" || len(status.ExitNodes) != 1 {
		t.Fatalf("status: %+v", status)
	}
	b, _ := json.Marshal(status)
	if strings.Contains(string(b), "NEVER-EXPOSE") || strings.Contains(string(b), "PrivateNodeKey") {
		t.Fatal("private prefs leaked")
	}
}

func TestTailExitSelectionOnlyChangesRoutingPreferences(t *testing.T) {
	for _, test := range []struct {
		name, id, state string
		online          bool
		wantError       bool
		want            []string
	}{
		{"select", "node-a", "Running", true, false, []string{"set", "--exit-node=100.64.0.3", "--exit-node-allow-lan-access=true"}},
		{"clear", "", "Running", true, false, []string{"set", "--exit-node="}},
		{"offline", "node-a", "Running", false, true, nil},
		{"unknown", "--reset", "Running", true, true, nil},
		{"logged out", "node-a", "NeedsLogin", true, true, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			var applied []string
			controller := tailscaleController{run: func(_ context.Context, args ...string) ([]byte, error) {
				switch args[0] {
				case "status":
					raw, _ := json.Marshal(tailWireStatus{BackendState: test.state, Peer: map[string]*tailPeer{"key": {ID: "node-a", HostName: "Exit", Online: test.online, ExitNodeOption: true, TailscaleIPs: []string{"100.64.0.3"}}}})
					return raw, nil
				case "debug":
					return []byte(`{}`), nil
				default:
					applied = append([]string{}, args...)
					return nil, nil
				}
			}}
			err := controller.selectExit(context.Background(), test.id)
			if (err != nil) != test.wantError {
				t.Fatalf("error: %v", err)
			}
			if !reflect.DeepEqual(applied, test.want) {
				t.Fatalf("applied %v; want %v", applied, test.want)
			}
		})
	}
}

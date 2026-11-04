#!/bin/sh
# Binaries and login state live on the persistent upgrade partition. Runtime
# socket/log files stay in RAM. This script does not install a boot hook.
set -eu
base=/blackbox/upgrade/osmo-srt/tailscale
runtime_dir=/tmp/osmo-tailscale
umask 077
mkdir -p "$runtime_dir"
if [ -r "$runtime_dir/daemon.pid" ]; then
    read -r daemon_pid < "$runtime_dir/daemon.pid"
    case "$daemon_pid" in
        ''|*[!0-9]*) ;;
        *)
            if [ "$(readlink "/proc/$daemon_pid/exe" 2>/dev/null || true)" = "$base/tailscaled" ]; then
                "$base/tailscale" --socket="$runtime_dir/tailscaled.sock" status
                exit 0
            fi
            ;;
    esac
fi
nohup "$base/tailscaled" --tun=ts-osmo --state="$base/state" \
    --socket="$runtime_dir/tailscaled.sock" --statedir="$base/state-dir" \
    </dev/null >"$runtime_dir/daemon.log" 2>&1 &
echo "$!" > "$runtime_dir/daemon.pid"
echo 'Tailscale started. Connect the camera to Wi-Fi before use.'

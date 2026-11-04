#!/bin/sh
# Start the independent console from persistent storage without a boot hook.
set -eu
base=/blackbox/upgrade/osmo-srt/console
runtime_dir=/tmp/osmo-srt-console
umask 077
mkdir -p "$runtime_dir/root"
if [ -r "$runtime_dir/console.pid" ]; then
    read -r console_pid < "$runtime_dir/console.pid"
    case "$console_pid" in
        ''|*[!0-9]*) ;;
        *)
            if [ "$(readlink "/proc/$console_pid/exe" 2>/dev/null || true)" = "$base/action-control" ]; then
                echo 'Console is already running on 127.0.0.1:8080.'
                exit 0
            fi
            ;;
    esac
fi
nohup "$base/action-control" serve --root "$runtime_dir/root" \
    --listen 127.0.0.1:8080 </dev/null >"$runtime_dir/console.log" 2>&1 &
echo "$!" > "$runtime_dir/console.pid"
echo 'Console started on 127.0.0.1:8080 (USB forwarding or Tailscale Serve).'

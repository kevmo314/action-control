#!/bin/sh
set -eu
root=/blackbox/upgrade/osmo-srt/browser/root
if [ "${1:-}" != --inside ]; then
  if python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2)' >/dev/null 2>&1; then
    exit 0
  fi
  exec unshare --mount --fork "$0" --inside
fi
mount --make-rprivate /
mkdir -p "$root/proc" "$root/dev" "$root/sys" "$root/tmp" "$root/etc/fonts"
mount -t proc proc "$root/proc"
mount --rbind /dev "$root/dev"
mount --rbind /sys "$root/sys"
cp /etc/resolv.conf "$root/etc/resolv.conf"
echo "$$" > /tmp/osmo-browser.pid
exec chroot "$root" /usr/lib/chromium/chromium-headless-shell --no-sandbox --disable-gpu --mute-audio --disable-dev-shm-usage --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/osmo-chromium --disable-background-networking --disable-component-update --no-first-run about:blank

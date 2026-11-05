#!/usr/bin/python3
"""Reconnect the camera's Wi-Fi using a private, preconfigured WPA profile."""
import ipaddress
import os
from pathlib import Path
import signal
import subprocess
import time

BASE = Path('/blackbox/upgrade/osmo-srt/wifi')
RUN = Path('/tmp/osmo-wifi')
CONTROL = str(RUN / 'control')
PROFILE = str(BASE / 'wpa.conf')
ALLOWED_PROFILES = {PROFILE, str(RUN / 'wpa.conf')}
ALLOWED_HOOKS = {str(BASE / 'dhcp-hook.sh'), str(RUN / 'dhcp-hook.sh')}
stopping = False


def command(*args):
    try:
        p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=15, text=True)
        return p.stdout.strip() if p.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def arguments(pid):
    try:
        return Path('/proc/%d/cmdline' % pid).read_bytes().decode().rstrip('\0').split('\0')
    except (OSError, UnicodeError):
        return []


def option(args, flag):
    try:
        return args[args.index(flag) + 1]
    except (ValueError, IndexError):
        return ''


def daemon(tool, pid_file, config_flag, allowed):
    """Return an owned/legacy PID or -1 for another manager of wlan0.

    Never signal a PID just because its number was left in a file. Inspect the
    live executable arguments, interface and exact configuration/hook path.
    """
    try:
        preferred = int(pid_file.read_text().strip())
    except (OSError, ValueError):
        preferred = 0
    candidates = [preferred] if preferred else []
    candidates += [int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit() and int(p.name) != preferred]
    for pid in candidates:
        args = arguments(pid)
        if not any(Path(a).name == tool for a in args[:2]):
            continue
        if option(args, '-i') != 'wlan0':
            continue
        return pid if option(args, config_flag) in allowed else -1
    return 0


def ipv4_address(output):
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[0] == 'inet':
            try:
                ip = ipaddress.ip_interface(fields[1]).ip
                if ip.version == 4 and not (ip.is_loopback or ip.is_link_local or ip.is_unspecified):
                    return str(ip)
            except ValueError:
                pass
    return ''


def wpa(*args):
    return command('wpa_cli', '-p', CONTROL, '-i', 'wlan0', *args)


def tick(retry):
    link = command('iw', 'dev', 'wlan0', 'link')
    connected = link.startswith('Connected to ')
    address = ipv4_address(command('ip', '-4', 'addr', 'show', 'wlan0')) if connected else ''
    # Association + IP are the health test. A broken upstream internet service
    # must not flap an otherwise healthy Wi-Fi connection.
    if connected and address:
        return 'connected ' + address, retry
    if time.monotonic() < retry:
        return 'waiting for Wi-Fi/DHCP', retry
    retry = time.monotonic() + 30
    command('systemctl', 'stop', 'dji_network.service')
    supplicant = daemon('wpa_supplicant', RUN / 'wpa.pid', '-c', ALLOWED_PROFILES)
    dhcp = daemon('udhcpc', RUN / 'dhcp.pid', '-s', ALLOWED_HOOKS)
    if supplicant < 0 or dhcp < 0:
        return 'another network manager owns wlan0; leaving it alone', retry
    # On cold boot DJI may have started its hotspot. Stop only that network
    # service when recovery is required; camera, display and USB are untouched.
    command('ip', 'link', 'set', 'wlan0', 'up')
    if not supplicant:
        command('wpa_supplicant', '-B', '-i', 'wlan0', '-c', PROFILE,
                '-P', str(RUN / 'wpa.pid'), '-f', str(RUN / 'wpa.log'))
        return 'started Wi-Fi association', retry
    status = dict(line.split('=', 1) for line in wpa('status').splitlines() if '=' in line)
    if not connected:
        # An existing supplicant already retries while scanning/authenticating.
        if status.get('wpa_state') in ('DISCONNECTED', 'INACTIVE', 'INTERFACE_DISABLED'):
            wpa('enable_network', 'all')
            wpa('reconnect')
        return 'waiting for AP association', retry
    if dhcp:
        # BusyBox udhcpc renews on USR1; revalidate immediately before signalling.
        args = arguments(dhcp)
        if option(args, '-s') in ALLOWED_HOOKS and option(args, '-i') == 'wlan0':
            try:
                os.kill(dhcp, signal.SIGUSR1)
            except ProcessLookupError:
                pass
    else:
        command('udhcpc', '-b', '-i', 'wlan0', '-p', str(RUN / 'dhcp.pid'),
                '-s', str(BASE / 'dhcp-hook.sh'), '-t', '3', '-T', '2')
    return 'waiting for DHCP lease', retry


def stop(_signum, _frame):
    global stopping
    stopping = True


def main():
    os.umask(0o077)
    if not Path(PROFILE).is_file():
        raise SystemExit('Private Wi-Fi profile is missing')
    for path in (RUN, RUN / 'control'):
        path.mkdir(mode=0o700, exist_ok=True)
        if path.is_symlink() or path.stat().st_uid != 0:
            raise SystemExit('Unexpected Wi-Fi runtime directory')
        path.chmod(0o700)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    last, retry = '', 0
    while not stopping:
        try:
            state, retry = tick(retry)
        except Exception as exc:
            # Exceptions must not silently terminate auto-recovery. Do not log
            # command arguments, profile contents or credentials.
            state = 'recovery retry: ' + type(exc).__name__
            retry = time.monotonic() + 30
        if state != last:
            print(state, flush=True)
            last = state
        for _ in range(10):
            if stopping:
                break
            time.sleep(1)


if __name__ == '__main__':
    main()

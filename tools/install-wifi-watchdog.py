#!/usr/bin/env python3
"""Install private AP credentials and the camera's Wi-Fi watchdog over USB."""
import argparse
import base64
import getpass
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--ssid', required=True)
    parser.add_argument('--password-stdin', action='store_true')
    args = parser.parse_args()
    password = sys.stdin.readline().rstrip('\n') if args.password_stdin else getpass.getpass('AP password: ')
    ssid = args.ssid.encode('utf-8')
    if not 1 <= len(ssid) <= 32 or not 8 <= len(password.encode('utf-8')) <= 63:
        parser.error('SSID must be 1–32 bytes; WPA2 password must be 8–63 bytes')
    key = hashlib.pbkdf2_hmac('sha1', password.encode('utf-8'), ssid, 4096, 32).hex()
    root = Path(__file__).resolve().parents[1]
    base = '/blackbox/upgrade/osmo-srt/wifi'
    profile = 'ctrl_interface=/tmp/osmo-wifi/control\nupdate_config=0\nnetwork={\n    ssid=' + ssid.hex() + '\n    psk=' + key + '\n    scan_ssid=1\n}\n'
    files = {base + '/wpa.conf': (profile.encode(), 0o600)}
    for name in ['watchdog.py', 'dhcp-hook.sh']:
        files[base + '/' + name] = ((root / 'native/wifi' / name).read_bytes(), 0o700)
    unit = (root / 'native/wifi/osmo-wifi-watchdog.service').read_bytes()
    files['/etc/systemd/system/osmo-wifi-watchdog.service'] = (unit, 0o644)
    encoded = {p: [base64.b64encode(data).decode(), mode] for p, (data, mode) in files.items()}
    # Only the PSK crosses ADB, not the original passphrase. Never print it.
    code = '''import base64,json,os,pathlib,shutil,subprocess
os.umask(0o077)
base=pathlib.Path('/blackbox/upgrade/osmo-srt/wifi')
base.mkdir(mode=0o700,exist_ok=True);base.chmod(0o700)
files=json.loads(PAYLOAD)
for name,(encoded,mode) in files.items():
 p=pathlib.Path(name);tmp=p.with_name(p.name+'.new')
 tmp.write_bytes(base64.b64decode(encoded));tmp.chmod(mode);os.replace(tmp,p)
# /etc is mounted after systemd's first unit scan on this firmware. Reload and
# start from the existing post-boot hook; enabling the unit alone is insufficient.
p=pathlib.Path('/etc/init.post_boot.sh')
data=p.read_bytes()
backup=base/'init.post_boot.before'
if not backup.exists(): shutil.copy2(p,backup)
marker=b'# BEGIN OSMO WIFI WATCHDOG'
if marker not in data:
 hook=b'\\n# BEGIN OSMO WIFI WATCHDOG\\nsystemctl daemon-reload\\nsystemctl --no-block start osmo-wifi-watchdog.service\\n/blackbox/upgrade/osmo-srt/console/start.sh >>/tmp/osmo-console-boot.log 2>&1 &\\n# END OSMO WIFI WATCHDOG\\n'
 tmp=p.with_name(p.name+'.osmo-new');tmp.write_bytes(data+hook);tmp.chmod(p.stat().st_mode&0o777);os.replace(tmp,p)
# LAN access is required for bootstrapping the web UI from the AP.
p=pathlib.Path('/blackbox/upgrade/osmo-srt/console/start.sh')
backup=base/'console-start.before'
if not backup.exists(): shutil.copy2(p,backup)
data=p.read_text().replace('--listen 127.0.0.1:8080','--listen :8080')
tmp=p.with_name(p.name+'.wifi-new');tmp.write_text(data);tmp.chmod(0o700);os.replace(tmp,p)
subprocess.run(['systemctl','daemon-reload'],check=True,timeout=15)
subprocess.run(['systemctl','enable','--now','osmo-wifi-watchdog.service'],check=True,timeout=20)
print('Wi-Fi watchdog installed and enabled; private profile mode 0600')
'''.replace('PAYLOAD', repr(json.dumps(encoded)))
    result = subprocess.run(['adb', '-s', args.serial, 'shell', 'python3', '-I', '-B', '-'], input=code, text=True)
    if result.returncode:
        raise SystemExit('Installation failed; reconnect the camera over USB and retry')


if __name__ == '__main__':
    main()

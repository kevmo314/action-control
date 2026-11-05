# Wi-Fi auto-reconnect

A small Python worker checks association and IPv4 every 10 seconds. It reconnects
with a private WPA2 profile and retries recovery at most once per 30 seconds.
The supplicant handles normal scanning and authentication retries. Healthy Wi-Fi
is left alone even when the AP has no internet access; another manager's client
processes are never killed. On recovery it stops DJI's network service before
starting its own client. Camera, display and USB services are not restarted.

Install over USB, entering the password at the prompt:

```sh
python3 tools/install-wifi-watchdog.py --serial CAMERA_SERIAL --ssid 'Your AP'
```

The profile contains a derived PSK, is mode 0600, and lives outside the repository
at `/blackbox/upgrade/osmo-srt/wifi/wpa.conf`. No credentials are compiled into the
worker. The installer enables `osmo-wifi-watchdog.service` and adds a marked
post-boot hook because this firmware mounts its writable `/etc` overlay after
systemd's initial unit scan. It also starts the existing web console at boot
and switches its listener to port 8080 on the LAN. Existing boot and console
startup scripts are backed up beside the private profile.

Inspect status on the camera:

```sh
systemctl status osmo-wifi-watchdog.service
journalctl -u osmo-wifi-watchdog.service -n 20
```

To suspend reconnection, including across boots:

```sh
touch /blackbox/upgrade/osmo-srt/wifi/disabled
systemctl stop osmo-wifi-watchdog.service
```

Remove `disabled` and start the unit to resume. Stopping the unit stops network
clients it launched; clients inherited from the earlier manual setup are not
signalled. Suspend the watchdog before using a different network manager.

Host policy checks:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s native/wifi -p '*_test.py' -v
```

Device verification on November 5: the service was enabled and running while
already associated with the saved AP. Stopping the original manual supplicant
caused the worker to launch a replacement using the persistent profile; WPA
completed again and the camera retained its assigned IPv4 address. This verifies
helper recovery and the saved credentials. Boot startup is configured but was
not exercised by rebooting the camera. The console's new LAN listener takes
effect on its next launch.

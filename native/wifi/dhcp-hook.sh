#!/bin/sh
# BusyBox udhcpc supplies these values. Bind only the intended interface.
[ "$interface" = wlan0 ] || exit 0
case "$1" in
deconfig)
    ip -4 addr flush dev "$interface"
    ;;
bound|renew)
    prefix=$(/usr/bin/python3 -I -B -c 'import ipaddress,os; print(ipaddress.IPv4Network("0.0.0.0/" + os.environ.get("subnet", "255.255.255.0")).prefixlen)') || exit 1
    ip addr replace "$ip/$prefix" dev "$interface" || exit 1
    for gateway in $router; do
        ip route replace default via "$gateway" dev "$interface" metric 600
        break
    done
    # This camera's resolver already points to /var/run/resolv.conf (/run).
    temporary=/run/osmo-wifi-resolv.new
    umask 077
    : > "$temporary"
    for server in $dns; do
        printf 'nameserver %s\n' "$server" >> "$temporary"
    done
    if [ -s "$temporary" ]; then
        cat "$temporary" > /run/resolv.conf
    fi
    rm -f "$temporary"
    ;;
esac

#!/bin/sh
# Vivi DinD entrypoint — force every container the agent launches inside DinD to
# egress through the MITM proxy, so the network allowlist and TLS interception
# that constrain the sandbox can't be sidestepped with `docker run`.
#
# Two mechanisms working together:
#   1. A relay: nested containers reach us at their bridge gateway (172.17.0.1:7443)
#      and we forward to the real proxy (resolved per-connection). The server
#      injects HTTP(S)_PROXY pointing here into every nested container.
#   2. An egress firewall (DOCKER-USER): private networks + the relay are allowed;
#      direct public egress is dropped. So even a process that ignores the proxy
#      env vars simply has no route to the internet except through the proxy.
set -e

PROXY_UPSTREAM="${VIVI_PROXY_UPSTREAM:-proxy:7443}"
EGRESS_LOCKDOWN="${VIVI_DIND_EGRESS_LOCKDOWN:-1}"

# Relay nested-container proxy traffic to the real MITM proxy. Per-connection DNS
# resolution means a proxy restart (new IP) is picked up without restarting DinD.
socat TCP-LISTEN:7443,fork,reuseaddr "TCP:${PROXY_UPSTREAM}" &
echo "[dind] proxy relay listening on :7443 -> ${PROXY_UPSTREAM}"

if [ "$EGRESS_LOCKDOWN" = "1" ]; then
  (
    # dockerd creates the DOCKER-USER chain at startup; wait for it.
    i=0
    until iptables -L DOCKER-USER >/dev/null 2>&1 || [ "$i" -ge 60 ]; do
      i=$((i + 1)); sleep 1
    done

    if iptables -L DOCKER-USER >/dev/null 2>&1; then
      # Insert DROP first (above DinD's default RETURN), then the private-network
      # RETURNs above it. Final order: RETURN private…, DROP public, RETURN(default).
      iptables -C DOCKER-USER -o eth0 -j DROP 2>/dev/null \
        || iptables -I DOCKER-USER -o eth0 -j DROP
      for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 224.0.0.0/4; do
        iptables -C DOCKER-USER -o eth0 -d "$net" -j RETURN 2>/dev/null \
          || iptables -I DOCKER-USER -o eth0 -d "$net" -j RETURN
      done
      echo "[dind] nested-container egress lockdown active (proxy-only)"
    else
      echo "[dind] WARNING: DOCKER-USER not found; egress lockdown NOT applied" >&2
    fi
  ) &
else
  echo "[dind] egress lockdown disabled (VIVI_DIND_EGRESS_LOCKDOWN=0)"
fi

exec dockerd-entrypoint.sh "$@"

#!/bin/bash
set -e

CA_DIR="/ca"
CA_CERT="$CA_DIR/ca-cert.pem"
CA_KEY="$CA_DIR/ca-key.pem"

generate_ca() {
  echo "[proxy] Generating CA certificate..."
  mkdir -p "$CA_DIR"
  openssl genrsa -out "$CA_KEY" 2048 2>/dev/null
  # 10-year validity so rotation is rare; the checkend probe below is the
  # safety net that rotates before an old CA can silently break MITM.
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 3650 \
    -out "$CA_CERT" -subj "/CN=Vivi Proxy CA" 2>/dev/null
  echo "[proxy] CA certificate generated (valid 10 years)"
}

# Generate the CA when missing, or rotate it if it expires within 30 days.
# Without this, a CA past its validity makes every MITM host fail with no signal.
if [ ! -f "$CA_CERT" ] || [ ! -f "$CA_KEY" ]; then
  generate_ca
elif ! openssl x509 -checkend 2592000 -noout -in "$CA_CERT" >/dev/null 2>&1; then
  echo "[proxy] CA certificate is missing or expires within 30 days — rotating..."
  generate_ca
else
  echo "[proxy] CA certificate present and valid"
fi

exec tsx /app/proxy.ts

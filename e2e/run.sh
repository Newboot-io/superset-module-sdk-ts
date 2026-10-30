#!/usr/bin/env bash
# Runs the example module (examples/minimal), then the sensor-sim sample, against a throwaway MQTT broker and twin endpoint on a
# private Docker network (no route out), then checks what the SDK promises.
# Docker only; safe to re-run: every container, network, image and temp file it makes is removed
# on exit.
#
#   e2e/run.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
MODULE_ID=my-module
OPENSSL_IMAGE=alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
PYTHON_IMAGE=python:3.12-alpine@sha256:5789aa194f757888f41fa3d48e14b6feaa1b57c0af0b56fcb1372d6474d3bff0
BROKER_IMAGE=eclipse-mosquitto:2@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f
WORK=$(mktemp -d)
# Per-run names: two runs at once never touch each other's containers, network or images.
PREFIX=sdk-ts-e2e-$(basename "$WORK" | tr -c 'a-zA-Z0-9\n' '-' | tr 'A-Z' 'a-z')
NETWORK=$PREFIX-net
CHECKER_IMAGE=$PREFIX-checker:test
MODULE_IMAGE=$PREFIX-module:test
SENSOR_SIM_IMAGE=$PREFIX-sensor-sim:test
# The image module_command runs: the example first, then the sensor-sim sample.
IMAGE=$MODULE_IMAGE

# Everything a run makes carries its label, so cleanup finds it all, even after an interrupt.
LABEL=sdk-e2e-run=$PREFIX
remove() {
  docker ps -aq --filter "label=$LABEL" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "label=$LABEL" | xargs -r docker network rm >/dev/null 2>&1 || true
  docker images -q --filter "label=$LABEL" | sort -u | xargs -r docker rmi -f >/dev/null 2>&1 || true
}
CLEANUP_PASSES=5
cleanup() {
  trap '' INT TERM # finish cleaning up, whatever arrives now
  # A `docker run` killed mid-create can leave its container behind after a first pass.
  for _ in $(seq "$CLEANUP_PASSES"); do
    remove
    [ -z "$(docker ps -aq --filter "label=$LABEL")" ] && break
    sleep 1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A name the twin server, the checker and this script share (fixtures.py).
fixture() { sed -n "s/^$1 = \"\(.*\)\"$/\1/p" "$HERE/fixtures.py"; }

echo "== certificates (throwaway CA, broker, twin endpoint, module, checker)"
mkdir -p "$WORK/certs"
docker run --rm --label "$LABEL" -v "$WORK/certs:/w" -w /w "$OPENSSL_IMAGE" sh -euc '
  apk add -q --no-cache openssl >/dev/null
  key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1.key" 2>/dev/null; }
  key ca
  openssl req -x509 -new -key ca.key -subj /CN=sdk-e2e-ca -days 1 -out ca.crt
  leaf() { # name, common name, extensions
    key "$1"
    openssl req -new -key "$1.key" -subj "/CN=$2" -out "$1.csr"
    printf "%s\n" "$3" >"$1.ext"
    openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -days 1 -extfile "$1.ext" -out "$1.crt" 2>/dev/null
  }
  leaf broker broker "subjectAltName=DNS:broker
extendedKeyUsage=serverAuth"
  leaf twin twin "subjectAltName=DNS:twin
extendedKeyUsage=serverAuth"
  for client in '"$MODULE_ID"' '"$MODULE_ID"'-twin checker; do
    leaf "$client" "$client" "extendedKeyUsage=clientAuth"
    # One PEM per identity: certificate, chain, then key, like the files Newboot mounts.
    cat "$client.crt" ca.crt "$client.key" >"$client.pem"
  done
  chmod 644 ./*
  chown -R '"$(id -u):$(id -g)"' /w'

echo "== broker and module configuration"
cat >"$WORK/mosquitto.conf" <<EOF
listener 8883
cafile /certs/ca.crt
certfile /certs/broker.crt
keyfile /certs/broker.key
require_certificate true
use_identity_as_username true
allow_anonymous false
acl_file /mosquitto/config/acl
EOF
# Default deny, like the superset broker: the module publishes its telemetry and replies, and reads
# its commands and the one upstream module its superset links to it.
cat >"$WORK/acl" <<EOF
user $MODULE_ID
topic write output/telemetry/tenant-a/node-a/$MODULE_ID/v
topic write output/directmethod/tenant-a/cluster-a/$MODULE_ID/res/+
topic read input/directmethod/tenant-a/cluster-a/$MODULE_ID/#
topic read output/telemetry/tenant-a/node-a/sensor/v

user checker
topic readwrite #
EOF
cat >"$WORK/module.json" <<EOF
{
  "brokerUrl": "tcps://broker:8883",
  "configuration": { "inputs": ["output/telemetry/tenant-a/node-a/sensor/v"], "secretFiles": ["/vault/material/device-password.json"] },
  "mqtt": {
    "ca": "/etc/newboot/ca/mqtt-ca.crt",
    "identity": "/vault/material/mqtt-client.pem",
    "mode": "mutual-tls"
  },
  "target": {
    "clusterId": "cluster-a",
    "moduleId": "$MODULE_ID",
    "nodeId": "node-a",
    "tenantConfigId": "tenant-a"
  },
  "twin": {
    "ca": "/etc/newboot/ca/twin-ca.crt",
    "endpoint": "https://twin/twin",
    "identity": "/vault/material/twin-client.pem"
  }
}
EOF
# One declared secret, as Newboot renders it: the value as a JSON string. No log may show it.
SECRET_VALUE="sdk-e2e-$(date +%s)-secret"
printf '"%s"' "$SECRET_VALUE" >"$WORK/device-password.json"
# The same value in two other shapes, valid JSON that is no string and no JSON at all (a parse
# error can quote the file): the module must refuse either at start, naming the secret only.
printf '{"value": "%s"}' "$SECRET_VALUE" >"$WORK/device-password-object.json"
printf '%s' "$SECRET_VALUE" >"$WORK/device-password-raw.json"
chmod 644 "$WORK/mosquitto.conf" "$WORK/acl" "$WORK/module.json" "$WORK/device-password.json" \
  "$WORK/device-password-object.json" "$WORK/device-password-raw.json"

echo "== images (built with network access; the test runs without it)"
docker build -q --label "$LABEL" -t "$CHECKER_IMAGE" - >/dev/null <<EOF
FROM $PYTHON_IMAGE
RUN pip install --no-cache-dir paho-mqtt==2.1.0
EOF
docker build -q --platform linux/amd64 --label "$LABEL" -t "$MODULE_IMAGE" \
  -f "$ROOT/examples/minimal/Dockerfile" "$ROOT" >/dev/null
docker build -q --platform linux/amd64 --label "$LABEL" -t "$SENSOR_SIM_IMAGE" \
  -f "$ROOT/samples/sensor-sim/Dockerfile" "$ROOT" >/dev/null

docker network create --internal --label "$LABEL" "$NETWORK" >/dev/null
docker run -d --label "$LABEL" --name "$PREFIX-broker" --network "$NETWORK" --network-alias broker \
  -v "$WORK/certs:/certs:ro" -v "$WORK/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
  -v "$WORK/acl:/mosquitto/config/acl:ro" "$BROKER_IMAGE" >/dev/null
# The twin endpoint; extra arguments go to docker run (STARTUP_TWIN for a sample's twin).
start_twin() {
  docker rm -f "$PREFIX-twin" >/dev/null 2>&1 || true
  docker run -d --label "$LABEL" --name "$PREFIX-twin" --network "$NETWORK" --network-alias twin \
    -v "$WORK/certs:/certs:ro" -v "$HERE:/test:ro" -e PYTHONDONTWRITEBYTECODE=1 "$@" \
    "$PYTHON_IMAGE" python -u /test/twin_server.py >/dev/null
}
start_twin

# The way Newboot runs a module: uid 10001, read-only root, no capabilities, its files mounted.
# $1: the secret file to mount; the rest: extra docker run arguments. Sets MODULE_COMMAND, an
# array, so `timeout` can run it too.
module_command() {
  local secret=$1
  shift
  MODULE_COMMAND=(docker run --label "$LABEL" --network "$NETWORK" \
    --read-only --user 10001 --cap-drop ALL --security-opt no-new-privileges \
    -e MODULE_CONFIG=/etc/newboot/module.json \
    -v "$WORK/module.json:/etc/newboot/module.json:ro" \
    -v "$WORK/certs/ca.crt:/etc/newboot/ca/mqtt-ca.crt:ro" \
    -v "$WORK/certs/ca.crt:/etc/newboot/ca/twin-ca.crt:ro" \
    -v "$WORK/certs/$MODULE_ID.pem:/vault/material/mqtt-client.pem:ro" \
    -v "$WORK/certs/$MODULE_ID-twin.pem:/vault/material/twin-client.pem:ro" \
    -v "$WORK/$secret:/vault/material/device-password.json:ro" \
    "$@" "$IMAGE")
}

# A secret file that is not a JSON string ($1) stops the module at start, with a message naming
# the secret and never its value.
refuses_unreadable_secret() {
  local log status=0
  module_command "$1" --rm --name "$PREFIX-refusal"
  log=$(timeout 60 "${MODULE_COMMAND[@]}" 2>&1) || status=$?
  # A module still running when the timeout ends the client is removed here.
  docker rm -f "$PREFIX-refusal" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ "$status" -ne 124 ] &&
    grep -qF 'secret device-password' <<<"$log" && ! grep -qF "$SECRET_VALUE" <<<"$log"; then
    echo "PASS the module refuses $1 at start, naming the secret only"
  else
    echo "FAIL the module accepted $1 or leaked it (status $status)"
    return 1
  fi
}

# The module log holds this line (or, with "!", does not).
logged() {
  local negate=$1 line=$2 what=$3
  if docker logs "$PREFIX-module" 2>&1 | grep -qxF -- "$line"; then found=1; else found=0; fi
  if { [ "$negate" = "!" ] && [ "$found" = 0 ]; } || { [ "$negate" != "!" ] && [ "$found" = 1 ]; }; then
    echo "PASS $what"
  else
    echo "FAIL $what"
    return 1
  fi
}

echo "== example module"
module_command device-password.json -d --name "$PREFIX-module" --network-alias module
"${MODULE_COMMAND[@]}" >/dev/null
if docker run --rm --label "$LABEL" --name "$PREFIX-checker" --network "$NETWORK" \
  -v "$WORK/certs:/certs:ro" -v "$HERE:/test:ro" -e PYTHONDONTWRITEBYTECODE=1 \
  "$CHECKER_IMAGE" python -u /test/checker.py &&
  # The SDK logs "mqtt: …" when its connection drops; it must not have dropped, even over the
  # checker's big messages (mosquitto honours a client's packet limit, the superset broker not).
  ! docker logs "$PREFIX-module" 2>&1 | grep '^mqtt: ' &&
  # A module reads its secrets at start and never logs one.
  ! docker logs "$PREFIX-module" 2>&1 | grep -F "$SECRET_VALUE" &&
  # onTelemetry delivers kept values from linked modules, and nothing else.
  logged + "input: $(fixture UPSTREAM_VARIABLE)" "a linked module's number is delivered" &&
  logged + "input: $(fixture UPSTREAM_ARRAY_VARIABLE)" "a linked module's array is delivered" &&
  logged ! "input: $(fixture UPSTREAM_NAN_VARIABLE)" "a NaN input is dropped" &&
  logged ! "input: $(fixture UPSTREAM_HUGE_VARIABLE)" "a 1e400 input is dropped" &&
  logged ! "input: $(fixture UPSTREAM_NESTED_VARIABLE)" "an object input is dropped" &&
  logged ! "input: $(fixture UPSTREAM_NESTED_ARRAY_VARIABLE)" "a nested array input is dropped" &&
  logged ! "input: variable-big" "an input over 8 KiB is dropped" &&
  refuses_unreadable_secret device-password-object.json &&
  refuses_unreadable_secret device-password-raw.json; then
  echo "== example module: PASS"
else
  echo "== example module: FAIL; module log:"
  docker logs "$PREFIX-module" 2>&1 | tail -40
  exit 1
fi
docker rm -f "$PREFIX-module" >/dev/null

echo "== sensor-sim sample"
# Its twin: settings, its two variables found by name, and one it does not own.
start_twin -e STARTUP_TWIN='{"amplitude": 5, "rateMs": 500, "variables": {
  "variable-temperature": {"name": "temperature"}, "variable-pressure": {"name": "pressure"},
  "variable-humidity": {"name": "humidity"}}}'
IMAGE=$SENSOR_SIM_IMAGE
module_command device-password.json -d --name "$PREFIX-module" --network-alias module
"${MODULE_COMMAND[@]}" >/dev/null
if docker run --rm --label "$LABEL" --name "$PREFIX-checker" --network "$NETWORK" \
  -v "$WORK/certs:/certs:ro" -v "$HERE:/test:ro" -e PYTHONDONTWRITEBYTECODE=1 \
  "$CHECKER_IMAGE" python -u /test/sensor_sim_check.py &&
  ! docker logs "$PREFIX-module" 2>&1 | grep '^mqtt: ' &&
  ! docker logs "$PREFIX-module" 2>&1 | grep -F "$SECRET_VALUE" &&
  logged + "variable temperature: variable-temperature" "sensor-sim finds temperature by name" &&
  logged + "variable pressure: variable-pressure" "sensor-sim finds pressure by name" &&
  refuses_unreadable_secret device-password-raw.json; then
  echo "== sensor-sim sample: PASS"
else
  echo "== sensor-sim sample: FAIL; module log:"
  docker logs "$PREFIX-module" 2>&1 | tail -40
  exit 1
fi
echo "== E2E PASSED"

"""Checks the sensor-sim sample over the test broker: it answers its health probes, serves its flow
metrics and sends `temperature` and `pressure` at the twin's `rateMs`, within their simulated
ranges."""

import json
import os
import queue
import ssl
import time
import urllib.request

import paho.mqtt.client as mqtt
from fixtures import MODULE, NODE, TENANT, check_flow_metrics
from paho.mqtt.enums import CallbackAPIVersion

AMPLITUDE = 5
MODULE_HTTP = "http://module:8080"
RANGES = {"pressure": (1012, 1014), "temperature": (20 - 1.1 * AMPLITUDE, 20 + 1.1 * AMPLITUDE)}
STARTUP_S = 90
TELEMETRY_TOPIC = f"output/telemetry/{TENANT}/{NODE}/{MODULE}/v"
WAIT_S = 15
# At rateMs 500 a few seconds bring each variable several times.
WANTED_PER_VARIABLE = 4

messages: "queue.Queue[dict]" = queue.Queue()


def fail(what):
    print(f"FAIL {what}", flush=True)
    os._exit(1)


def check(condition, what):
    if not condition:
        fail(what)
    print(f"PASS {what}", flush=True)


def on_message(_client, _userdata, message):
    messages.put(json.loads(message.payload))


def http_status(path):
    try:
        with urllib.request.urlopen(MODULE_HTTP + path, timeout=2) as response:
            return response.status
    except OSError as error:
        return getattr(error, "code", None)


tls = ssl.create_default_context(cafile="/certs/ca.crt")
tls.load_cert_chain("/certs/checker.pem")
client = mqtt.Client(CallbackAPIVersion.VERSION2, client_id="checker", protocol=mqtt.MQTTv5)
client.tls_set_context(tls)
client.on_message = on_message
client.connect("broker", 8883)
client.subscribe(TELEMETRY_TOPIC, qos=1)
client.loop_start()

end = time.monotonic() + STARTUP_S
while http_status("/readyz") != 200 and time.monotonic() < end:
    time.sleep(0.5)
check(http_status("/readyz") == 200, "sensor-sim: GET /readyz answers 200 once connected")
check(http_status("/healthz") == 200, "sensor-sim: GET /healthz answers 200")
check_flow_metrics(check, MODULE_HTTP, "sensor-sim: ")

seen = {name: [] for name in RANGES}
end = time.monotonic() + WAIT_S
while min(len(values) for values in seen.values()) < WANTED_PER_VARIABLE:
    left = end - time.monotonic()
    if left <= 0:
        fail(f"sensor-sim: too few messages: { {k: len(v) for k, v in seen.items()} }")
    try:
        message = messages.get(timeout=left)
    except queue.Empty:
        continue
    check(message.get("name") in RANGES, f"sensor-sim: message named {message.get('name')}")
    seen[message["name"]].append(message)

for name, (low, high) in RANGES.items():
    values = [message["value"] for message in seen[name]]
    check(all(low <= value <= high for value in values), f"sensor-sim: {name} within range")
    ids = {message["variableId"] for message in seen[name]}
    check(ids == {f"variable-{name}"}, f"sensor-sim: {name} sent on its own variable id")
    stamps = [message["timestamp"] for message in seen[name]]
    gaps = [later - earlier for earlier, later in zip(stamps, stamps[1:])]
    check(all(400 <= gap <= 1500 for gap in gaps), f"sensor-sim: {name} every rateMs: {gaps}")

# The messages seen were counted as enqueued.
flow = check_flow_metrics(check, MODULE_HTTP, "sensor-sim: at the end, ")
enqueued = flow['newboot_flow_operations_total{operation="enqueue",outcome="success"}']
check(enqueued > 0, f"sensor-sim: enqueue successes counted: {enqueued}")
check(
    flow['newboot_flow_last_success_timestamp_seconds{operation="enqueue"}'] > 0,
    "sensor-sim: last enqueue success has a timestamp",
)

client.loop_stop()
print("SENSOR-SIM CHECKS PASSED", flush=True)

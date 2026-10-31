"""Drives the running example module over the test broker and asserts what the SDK promises:
telemetry per variable of the twin, reload answers (success and every failure), health probes,
linked-module input (run.sh reads the module log for it), and silence for every command the SDK
must not answer: getValue and custom commands (out of scope in v0.1), and any reload that is not
addressed to the module or not on time."""

import json
import os
import queue
import ssl
import time
import urllib.request

import paho.mqtt.client as mqtt
from fixtures import (
    ARRAY_RELOAD,
    CLUSTER,
    CUT_RELOAD,
    DEEP_RELOAD,
    DRIP_BODY_RELOAD,
    DRIP_HEADERS_RELOAD,
    FAILING_RELOAD,
    MODULE,
    NODE,
    REDIRECT_RELOAD,
    RELOADED_VARIABLE,
    SHORT_RELOAD,
    STARTUP_VARIABLE,
    STARTUP_VARIABLE_NAME,
    TENANT,
    UPSTREAM_ARRAY_VARIABLE,
    UPSTREAM_HUGE_VARIABLE,
    UPSTREAM_NAN_VARIABLE,
    UPSTREAM_NESTED_ARRAY_VARIABLE,
    UPSTREAM_NESTED_VARIABLE,
    UPSTREAM_VARIABLE,
    check_flow_metrics,
    reloaded_name,
)
from paho.mqtt.enums import CallbackAPIVersion
from paho.mqtt.subscribeoptions import SubscribeOptions

# Above the SDK's 8 KiB message limit. Mosquitto (this harness) honours the largest packet a
# client announces; the superset broker does not and forwards up to 2 MiB, so a module must take
# both sizes without dropping its connection.
BIG_MESSAGE_BYTES = (20 * 1024, 100 * 1024)
BIG_VARIABLE = "variable-big"
COMMAND_PREFIX = f"input/directmethod/{TENANT}/{CLUSTER}/{MODULE}"
COMMAND_TOPIC = f"{COMMAND_PREFIX}/unicast"
INPUT_TOPIC = f"output/telemetry/{TENANT}/{NODE}/sensor/v"
MAX_COMMAND_BYTES = 8192
MAX_SEGMENT_BYTES = 200
MAX_TTL_MS = 30_000
MODULE_HTTP = "http://module:8080"
RELOADED = {"reloaded": True}
REPLY_KEYS = 3
REPLY_PREFIX = f"output/directmethod/{TENANT}/{CLUSTER}/{MODULE}/res/"
SCOPE = {"clusterId": CLUSTER, "moduleId": MODULE, "tenantConfigId": TENANT}
SILENCE_S = 3
STARTUP_S = 90
TELEMETRY_TOPIC = f"output/telemetry/{TENANT}/{NODE}/{MODULE}/v"
TTL_MS = 5000
UPSTREAM_VALUE = 1.5
WAIT_S = 15

telemetry: "queue.Queue[dict]" = queue.Queue()
replies: "dict[str, queue.Queue[dict]]" = {}


def fail(what):
    print(f"FAIL {what}", flush=True)
    os._exit(1)  # also from paho's thread: a failure never turns into a timeout


def check(condition, what):
    if not condition:
        fail(what)
    print(f"PASS {what}", flush=True)


def reject_constant(name):
    raise ValueError(f"{name} is not JSON")


def on_message(_client, _userdata, message):
    """Collect what the module sends; the checker's own messages to it are skipped."""
    if message.topic != TELEMETRY_TOPIC and not message.topic.startswith(REPLY_PREFIX):
        return
    try:
        body = json.loads(message.payload, parse_constant=reject_constant)
    except ValueError:
        fail(f"non-JSON message on {message.topic}: {message.payload[:80]!r}")
    if message.qos != 0 or message.retain:
        fail(f"{message.topic} sent at QoS {message.qos}, retain {message.retain}")
    if message.topic == TELEMETRY_TOPIC:
        telemetry.put(body)
    else:
        replies.setdefault(message.topic.removeprefix(REPLY_PREFIX), queue.Queue()).put(body)


def valid_segment(value):
    return (
        isinstance(value, str)
        and 0 < len(value.encode()) <= MAX_SEGMENT_BYTES
        and not any(c in "/+#" or ord(c) < 32 or ord(c) == 127 for c in value)
    )


def next_telemetry(deadline_s, variable_id, name=None):
    """The next telemetry message for this variable (and name, if given) before the deadline."""
    end = time.monotonic() + deadline_s
    while (left := end - time.monotonic()) > 0:
        try:
            message = telemetry.get(timeout=left)
        except queue.Empty:
            break
        if message.get("variableId") == variable_id and name in (None, message.get("name")):
            return message
    return None


def publish(topic, payload, retain=False):
    client.publish(topic, payload, qos=1, retain=retain).wait_for_publish()


def envelope(name, correlation_id, payload, **override):
    now = int(time.time() * 1000)
    fields = {
        "command": name,
        "correlationId": correlation_id,
        "delivery": "unicast",
        "expiresAtUnixMs": now + TTL_MS,
        "issuedAtUnixMs": now,
        "payload": payload,
        "replyTopic": REPLY_PREFIX + correlation_id,
        "target": SCOPE,
    }
    fields.update(override)
    return {key: value for key, value in fields.items() if value is not None}


def command(name, correlation_id, payload, retain=False, delivery="unicast", **override):
    replies.setdefault(correlation_id, queue.Queue())
    body = envelope(name, correlation_id, payload, delivery=delivery, **override)
    publish(f"{COMMAND_PREFIX}/{delivery}/{name}", json.dumps(body), retain)
    return correlation_id


def reload(correlation_id, payload=None, **override):
    return command("reload", correlation_id, {} if payload is None else payload, **override)


def reply_to(correlation_id, wait_s=WAIT_S):
    """The module's reply, checked against the envelope the cloud accepts."""
    try:
        answer = replies[correlation_id].get(timeout=wait_s)
    except queue.Empty:
        return None
    well_formed = (
        len(answer) == REPLY_KEYS
        and answer.get("correlationId") == correlation_id
        and answer.get("target") == SCOPE
        and (("result" in answer) != ("error" in answer))
        and ("error" not in answer or valid_segment(answer["error"]))
    )
    check(well_formed, f"reply {correlation_id} has exactly correlationId, target, result|error")
    return answer


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
# Retain as published: the checker sees the flag the module set.
client.subscribe([("output/#", SubscribeOptions(qos=1, retainAsPublished=True))])
client.loop_start()

# Sending: one message per variable of the twin fetched at start, named after the variable.
first = next_telemetry(STARTUP_S, STARTUP_VARIABLE)
check(first is not None, "telemetry for the variable listed in the twin at start")
check(first.get("name") == STARTUP_VARIABLE_NAME, "telemetry is named after the variable")
check(isinstance(first.get("value"), (int, float)), "telemetry has a numeric value")
check(abs(first["timestamp"] - time.time() * 1000) < 60_000, "telemetry timestamp is epoch ms")
check(sorted(first) == ["name", "timestamp", "value", "variableId"], "telemetry has exactly 4 keys")

end = time.monotonic() + STARTUP_S
while http_status("/readyz") != 200 and time.monotonic() < end:
    time.sleep(0.5)
check(http_status("/readyz") == 200, "GET /readyz answers 200 once subscribed")
check(http_status("/healthz") == 200, "GET /healthz answers 200")
flow = check_flow_metrics(check, MODULE_HTTP, "")
enqueued = 'newboot_flow_operations_total{operation="enqueue",outcome="success"}'
check(flow[enqueued] > 0, "the telemetry sent is counted as enqueued")

# Receiving: linked-module values the SDK delivers (a number, an array) and ignores (NaN, 1e400,
# an object, a nested array, a retained value, an oversized one). run.sh reads the module log.
publish(INPUT_TOPIC, json.dumps({"value": UPSTREAM_VALUE, "variableId": UPSTREAM_VARIABLE}))
publish(INPUT_TOPIC, json.dumps({"value": [1, 2.5, 3.25], "variableId": UPSTREAM_ARRAY_VARIABLE}))
publish(INPUT_TOPIC, '{"value": NaN, "variableId": "%s"}' % UPSTREAM_NAN_VARIABLE)
publish(INPUT_TOPIC, '{"value": 1e400, "variableId": "%s"}' % UPSTREAM_HUGE_VARIABLE)
publish(INPUT_TOPIC, json.dumps({"value": {"a": [1]}, "variableId": UPSTREAM_NESTED_VARIABLE}))
publish(INPUT_TOPIC, json.dumps({"value": [[1]], "variableId": UPSTREAM_NESTED_ARRAY_VARIABLE}))

# Commands v0.1 leaves unanswered: getValue and any custom command.
command("getValue", "get-value", {"variableId": UPSTREAM_VARIABLE})
command("ping", "custom-command", {})
answer = reply_to(reload("get-bad-payload", "not an object"))
check(answer and answer.get("error") == "invalid_payload", f"reload invalid payload: {answer}")

# Big messages on the input and command topics must not cut the module's connection (run.sh
# checks its log for reconnects).
for size in BIG_MESSAGE_BYTES:
    big = json.dumps({"value": "x" * size, "variableId": BIG_VARIABLE})
    publish(INPUT_TOPIC, big)
    publish(f"{COMMAND_TOPIC}/reload", big)
    answer = reply_to(reload(f"after-big-{size}"))
    check(answer and answer.get("result") == RELOADED, f"after {size}-byte messages, reload works")

# Messages that are not command objects must not stop the module.
for raw in ("5", "[1]", "null", "not json", '"text"'):
    publish(f"{COMMAND_TOPIC}/reload", raw)
answer = reply_to(reload("after-junk"))
check(answer and answer.get("result") == RELOADED, "after non-object commands, reload works")

# Reloads the module must leave unanswered.
now = int(time.time() * 1000)
silent = {
    "another-target": {"target": {**SCOPE, "moduleId": "other"}},
    "expired": {"expiresAtUnixMs": now - 1, "issuedAtUnixMs": now - TTL_MS},
    "future-issue": {"expiresAtUnixMs": now + 2 * TTL_MS, "issuedAtUnixMs": now + TTL_MS},
    "long-ttl": {"expiresAtUnixMs": now + MAX_TTL_MS + TTL_MS},
    "no-deadline": {"expiresAtUnixMs": None},
    "text-deadline": {"expiresAtUnixMs": "soon"},
    "wrong-reply-topic": {"replyTopic": REPLY_PREFIX + "elsewhere"},
}
for correlation_id, override in silent.items():
    reload(correlation_id, **override)
reload("retained", retain=True)
publish(f"{COMMAND_TOPIC}/reload", b"", retain=True)  # clear it for the next run
replies.setdefault("oversized", queue.Queue())
oversized = envelope("reload", "oversized", {})
oversized["pad"] = "x" * MAX_COMMAND_BYTES
publish(f"{COMMAND_TOPIC}/reload", json.dumps(oversized))
time.sleep(SILENCE_S)
for correlation_id in [*silent, "retained", "oversized", "elsewhere", "get-value", "custom-command"]:
    check(
        replies.get(correlation_id, queue.Queue()).empty(),
        f"no reply to the {correlation_id} command",
    )

# Twin: a failed fetch (HTTP 500, an answer cut mid-body, one shorter than announced, a JSON
# array, a redirect, JSON nested too deep) answers a short code and leaves the module working.
failing_reloads = (
    FAILING_RELOAD,
    CUT_RELOAD,
    SHORT_RELOAD,
    ARRAY_RELOAD,
    REDIRECT_RELOAD,
    DEEP_RELOAD,
)
for failing in failing_reloads:
    answer = reply_to(reload(failing))
    check(answer and answer.get("error") == "reload_failed", f"failed reload {failing}: {answer}")
# A twin endpoint that answers too slowly: the SDK gives up at its deadline and still answers
# within the command's longest life (30 s).
for slow in (DRIP_HEADERS_RELOAD, DRIP_BODY_RELOAD):
    issued = int(time.time() * 1000)
    longest = {"expiresAtUnixMs": issued + MAX_TTL_MS, "issuedAtUnixMs": issued}
    answer = reply_to(reload(slow, **longest), MAX_TTL_MS / 1000)
    check(answer and answer.get("error") == "reload_failed", f"slow reload {slow}: {answer}")
# Then a broadcast reload brings the new variables.
answer = reply_to(reload("reload-1", delivery="broadcast"))
check(answer and answer.get("result") == RELOADED, f"reload: {answer}")
# Earlier successful reloads served the same variable under other names: wait for this one's.
after = next_telemetry(WAIT_S, RELOADED_VARIABLE, reloaded_name("reload-1"))
check(after is not None, "after reload, telemetry follows the variables fetched again")

# Flow metrics: the linked-module values above were received, the valid ones processed and the
# dropped ones counted as process errors; commands and reloads are not counted.
flow = check_flow_metrics(check, MODULE_HTTP, "at the end, ")
received = flow['newboot_flow_operations_total{operation="receive",outcome="success"}']
processed = flow['newboot_flow_operations_total{operation="process",outcome="success"}']
rejected = flow['newboot_flow_operations_total{operation="process",outcome="error"}']
check(processed >= 2 and rejected >= 4, f"inputs processed {processed}, rejected {rejected}")
check(received == processed + rejected, f"each of the {received} inputs is processed once")

client.loop_stop()
print("ALL CHECKS PASSED", flush=True)

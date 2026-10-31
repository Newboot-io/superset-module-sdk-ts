"""Names the harness's broker, settings server and checker share, and the checkers' flow metrics
check."""

import urllib.request

CLUSTER, MODULE, NODE, TENANT = "cluster-a", "my-module", "node-a", "tenant-a"
TWIN_CLIENT = f"{MODULE}-twin"
TWIN_PATH = "/twin"

# Console variables are named `variable-<uuid>`; the settings list the module's own.
STARTUP_VARIABLE = "variable-0c6e3d1a-5b0f-4f43-9a52-7f1e2d3c4b5a"
STARTUP_VARIABLE_NAME = "Boiler temperature"
RELOADED_VARIABLE = "variable-9d8c7b6a-1e2f-4a3b-8c4d-5e6f7a8b9c0d"
UPSTREAM_VARIABLE = "variable-4b3a2c1d-7e6f-4d5c-9b8a-0f1e2d3c4b5a"

# The settings server fails every reload with one of these correlation ids: an HTTP 500, an
# answer cut mid-body (the connection closes after 10 of 1000 bytes), a JSON array, a redirect
# carrying valid settings, JSON nested too deep to parse on a small stack.
FAILING_RELOAD = "reload-fail"
CUT_RELOAD = "reload-cut"
ARRAY_RELOAD = "reload-array"
REDIRECT_RELOAD = "reload-redirect"
DEEP_RELOAD = "reload-deep"
CUT_DECLARED_BYTES = 1000
CUT_SENT_BYTES = 10
DEEP_LEVELS = 100_000
# The settings server announces SHORT_MISSING_BYTES more than the valid settings it sends, then
# closes the connection cleanly: only the length tells the module the answer is incomplete.
SHORT_RELOAD = "reload-short"
SHORT_MISSING_BYTES = 100

# Slow answers, valid settings written a byte at a time over DRIP_SECONDS: past the SDK's 12 s
# settings deadline (SETTINGS_DEADLINE_S) but within the command's 30 s, from the headers on or the
# body after prompt headers. The module must give up and answer reload_failed.
SETTINGS_DEADLINE_S = 12
DRIP_HEADERS_RELOAD = "reload-drip-headers"
DRIP_BODY_RELOAD = "reload-drip-body"
DRIP_SECONDS = SETTINGS_DEADLINE_S + 8

# Linked module values that are not valid JSON numbers (NaN, 1e400 which parses to infinity): the
# module must ignore them.
UPSTREAM_NAN_VARIABLE = "variable-5c4b3a2d-8f7e-4e6d-8c9b-1a0f2e3d4c5b"
UPSTREAM_HUGE_VARIABLE = "variable-6d5c4b3a-9e8f-4f7e-8d0c-2b1a0f3e4d5c"
# Linked module values the SDK keeps (an array of numbers, as an OPC UA array variable sends) and
# ignore (anything nested: an object, an array in an array).
UPSTREAM_ARRAY_VARIABLE = "variable-8f7e6d5c-1a0f-4b9e-8f2e-4d3c2b1a0f6e"
UPSTREAM_NESTED_ARRAY_VARIABLE = "variable-9a8f7e6d-2b1a-4c0f-9a3f-5e4d3c2b1a07"
UPSTREAM_NESTED_VARIABLE = "variable-7e6d5c4b-0f9e-4a8f-9e1d-3c2b1a0f4e5d"


def reloaded_name(correlation_id):
    """What the settings server names the variable it serves to a reload."""
    return f"reload-{correlation_id}"

# The module flow-metrics contract: 17 series, served as Prometheus text.
FLOW_OPERATIONS = ("acquire", "receive", "process", "enqueue")
FLOW_SERIES = 17
METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


def flow_metrics(module_http):
    """The module's /metrics: its content type and its series by name and labels."""
    with urllib.request.urlopen(module_http + "/metrics", timeout=2) as response:
        content_type = response.headers.get("Content-Type")
        text = response.read().decode()
    series = {}
    for line in text.splitlines():
        if line and not line.startswith("#"):
            name, _, value = line.rpartition(" ")
            series[name] = float(value)
    return content_type, series


def check_flow_metrics(check, module_http, prefix):
    """The 17 flow series, served as Prometheus text, connected once ready; returns the series."""
    content_type, series = flow_metrics(module_http)
    check(content_type == METRICS_CONTENT_TYPE, f"{prefix}GET /metrics is Prometheus text")
    check(len(series) == FLOW_SERIES, f"{prefix}GET /metrics has the {FLOW_SERIES} flow series")
    expected = {"newboot_flow_mqtt_connected"}
    for operation in FLOW_OPERATIONS:
        for outcome in ("success", "error"):
            labels = f'operation="{operation}"'
            expected.add(f"newboot_flow_operations_total{{{labels},outcome=\"{outcome}\"}}")
            expected.add(f"newboot_flow_last_{outcome}_timestamp_seconds{{{labels}}}")
    check(set(series) == expected, f"{prefix}flow series are exactly the contract's")
    check(series["newboot_flow_mqtt_connected"] == 1, f"{prefix}newboot_flow_mqtt_connected is 1")
    return series

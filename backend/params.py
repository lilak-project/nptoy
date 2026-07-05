"""Whitelisted batch-job parameters (PLAN §4.1 / §8).

A batch job runs the real nptool `npsimulation -B <macro>` for a whitelisted
project. The only knobs are the project and the number of events; the backend
renders a fixed `/run/beamOn <n>` macro — never arbitrary macros/commands.
"""
from __future__ import annotations

from typing import Any

import config


class ParamError(ValueError):
    pass


# Batch jobs run the user's current input workspace (/api/inputs); the only knob
# is the event count.
def schema() -> list[dict]:
    return [
        {"key": "n_events", "label": "Number of events (/run/beamOn)", "type": "int",
         "min": 1, "max": 1000000, "default": 1},
    ]


PARAM_SCHEMA = schema()


def validate(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ParamError("params must be an object")
    out: dict[str, Any] = {}
    for field in schema():
        key, ftype = field["key"], field["type"]
        val = raw.get(key, field["default"])
        if ftype == "choice":
            if val not in field["choices"]:
                raise ParamError(f"{key}: '{val}' is not an allowed choice")
            out[key] = val
        elif ftype == "int":
            try:
                num = int(val)
            except (TypeError, ValueError):
                raise ParamError(f"{key}: '{val}' is not an integer")
            if num < field["min"] or num > field["max"]:
                raise ParamError(f"{key}: must be in [{field['min']}, {field['max']}]")
            out[key] = num
        else:  # pragma: no cover
            raise ParamError(f"{key}: unsupported type {ftype}")
    return out


def build_macro(params: dict[str, Any]) -> str:
    """Fixed Geant4 batch macro from validated params — only `/run/beamOn <n>`."""
    p = validate(params)
    return f"/run/beamOn {p['n_events']}\n"

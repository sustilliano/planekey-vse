#!/usr/bin/env python3
"""
PlaneKey Environment Observer MCP Server v0.2.14

Official-channel MCP wrapper for the customer-facing PlaneKey environment observer.

Based on the older Rgano FastMCP pattern:
- stdio transport for Claude Desktop / MCP hosts
- optional HTTP transport for local/remote MCP hosts
- tools/resources instead of one-off JSON script output

Boundary:
- read-only workspace scanning
- reports signed observations to Home Bridge
- records coding-assistant suggestions
- NEVER patches, deletes, deploys, or executes assistant-provided shell commands
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import httpx
except Exception:  # pragma: no cover
    httpx = None

try:
    from mcp.server.fastmcp import FastMCP
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "FastMCP is required. Install with: pip install 'mcp[cli]' httpx\n"
        f"Import error: {exc}"
    )

# Reuse the v0.2.12 scanner logic when available.
try:
    from tools.planekey_env_observer_mcp import (
        DEFAULT_EXCLUDES,
        scan_workspace,
        build_home_bridge_payloads,
        build_assistant_suggestion,
        sha256_text,
        hmac_hex,
    )
except Exception:
    # Support running from mcp/ directly.
    import sys
    sys.path.append(str(Path(__file__).resolve().parents[1]))
    from tools.planekey_env_observer_mcp import (
        DEFAULT_EXCLUDES,
        scan_workspace,
        build_home_bridge_payloads,
        build_assistant_suggestion,
        sha256_text,
        hmac_hex,
    )


@dataclass
class PlaneKeyMCPState:
    home_bridge_url: str
    hmac_secret: str
    default_service_id: str
    default_environment_id: str
    workspace_root: Path
    allow_http_submit: bool


@asynccontextmanager
async def planekey_lifespan(server: FastMCP):
    state = PlaneKeyMCPState(
        home_bridge_url=os.environ.get("PLANEKEY_HOME_BRIDGE_URL", "http://localhost:8080").rstrip("/"),
        hmac_secret=os.environ.get("PLANEKEY_HMAC_SECRET", ""),
        default_service_id=os.environ.get("PLANEKEY_SERVICE_ID", "local-product"),
        default_environment_id=os.environ.get("PLANEKEY_ENVIRONMENT_ID", "local"),
        workspace_root=Path(os.environ.get("PLANEKEY_WORKSPACE_ROOT", ".")).resolve(),
        allow_http_submit=os.environ.get("PLANEKEY_MCP_ALLOW_SUBMIT", "false").lower() in ("1", "true", "yes"),
    )
    yield {"state": state}


mcp = FastMCP("planekey_env_observer", lifespan=planekey_lifespan)


def _state() -> PlaneKeyMCPState:
    ctx = mcp.get_context()
    return ctx.request_context.lifespan_context["state"]


async def _post_json(url: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if httpx is None:
        return {"ok": False, "error": "httpx not installed"}
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.post(url, json=payload)
        try:
            data = res.json()
        except Exception:
            data = {"text": res.text}
        return {"status_code": res.status_code, "response": data}


@mcp.tool()
def planekey_scan_workspace(
    root: Optional[str] = None,
    service_id: Optional[str] = None,
    environment_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Read-only scan of a workspace. Returns hashes, file counts, high-risk path counts,
    and Home Bridge-ready payloads. Does not submit unless explicit submit tool is called.
    """
    state = _state()
    scan_root = Path(root).resolve() if root else state.workspace_root
    sid = service_id or state.default_service_id
    eid = environment_id or state.default_environment_id

    scan = scan_workspace(scan_root, DEFAULT_EXCLUDES)
    payloads = build_home_bridge_payloads(
        scan=scan,
        service_id=sid,
        environment_id=eid,
        secret=state.hmac_secret,
        observer_id=os.environ.get("PLANEKEY_OBSERVER_ID", "mcp-observer"),
    )
    return {
        "ok": True,
        "root": str(scan_root),
        "service_id": sid,
        "environment_id": eid,
        "workspace_hash": scan["workspace_hash"],
        "files_scanned": scan["files_scanned"],
        "high_risk_files": scan["high_risk_files"],
        "payloads": payloads,
    }


@mcp.tool()
async def planekey_submit_workspace_report(
    root: Optional[str] = None,
    service_id: Optional[str] = None,
    environment_id: Optional[str] = None,
    dry_run: bool = True,
) -> Dict[str, Any]:
    """
    Submit the observer session/report to Home Bridge. Defaults to dry_run=True.
    Set dry_run=False and PLANEKEY_MCP_ALLOW_SUBMIT=true to actually POST.
    """
    state = _state()
    scan_result = planekey_scan_workspace(root, service_id, environment_id)
    payloads = scan_result["payloads"]

    if dry_run or not state.allow_http_submit:
        return {
            "ok": True,
            "dry_run": True,
            "reason": "dry_run true or PLANEKEY_MCP_ALLOW_SUBMIT not enabled",
            "would_post": [
                f"{state.home_bridge_url}/env-observer/session/start",
                f"{state.home_bridge_url}/env-observer/report",
            ],
            "payloads": payloads,
        }

    session_res = await _post_json(f"{state.home_bridge_url}/env-observer/session/start", payloads["session_start"])
    report_res = await _post_json(f"{state.home_bridge_url}/env-observer/report", payloads["report"])
    return {"ok": True, "dry_run": False, "session": session_res, "report": report_res}


@mcp.tool()
async def planekey_record_assistant_suggestion(
    target_paths: List[str],
    proposed_action: str,
    risk_level: str = "unknown",
    assistant_kind: str = "coding-assistant",
    assistant_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    service_id: Optional[str] = None,
    environment_id: Optional[str] = None,
    dry_run: bool = True,
) -> Dict[str, Any]:
    """
    Record a coding assistant suggestion against the observed environment.
    Does not execute the suggestion.
    """
    state = _state()
    sid = service_id or state.default_service_id
    eid = environment_id or state.default_environment_id
    suggestion = build_assistant_suggestion(
        service_id=sid,
        environment_id=eid,
        secret=state.hmac_secret,
        assistant_kind=assistant_kind,
        assistant_id=assistant_id,
        target_paths=target_paths,
        proposed_action=proposed_action,
        risk_level=risk_level,
        payload=payload or {},
    )

    if dry_run or not state.allow_http_submit:
        return {
            "ok": True,
            "dry_run": True,
            "reason": "dry_run true or PLANEKEY_MCP_ALLOW_SUBMIT not enabled",
            "would_post": f"{state.home_bridge_url}/env-observer/assistant-suggestion",
            "payload": suggestion,
        }

    res = await _post_json(f"{state.home_bridge_url}/env-observer/assistant-suggestion", suggestion)
    return {"ok": True, "dry_run": False, "response": res}


@mcp.tool()
async def planekey_get_environment_state(
    service_id: Optional[str] = None,
    environment_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Read recent Home Bridge records for this environment.
    """
    state = _state()
    sid = service_id or state.default_service_id
    eid = environment_id or state.default_environment_id
    if httpx is None:
        return {"ok": False, "error": "httpx not installed"}
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(f"{state.home_bridge_url}/env-observer/environment/{sid}/{eid}")
        try:
            data = res.json()
        except Exception:
            data = {"text": res.text}
        return {"status_code": res.status_code, "response": data}


@mcp.tool()
def planekey_explain_risk(
    changed_paths: List[str],
    action_kind: str = "patch_suggestion",
) -> Dict[str, Any]:
    """
    Local risk explanation for assistant suggestions. This is advisory only.
    """
    high_risk_patterns = [
        ".env", "secret", "credential", "private_key", "server.js", "main.rs",
        "lib.rs", "Cargo.toml", "package.json", "render.yaml", "Dockerfile",
        "docker-compose", "migrations/"
    ]
    hits = []
    for p in changed_paths:
        low = p.lower()
        matched = [pat for pat in high_risk_patterns if pat in low]
        if matched:
            hits.append({"path": p, "matched": matched})

    if hits and action_kind in ("patch_apply", "delete", "wipe_apply", "deploy"):
        level = "critical"
        decision = "requires_human_review"
    elif hits:
        level = "high"
        decision = "requires_review"
    else:
        level = "low"
        decision = "recordable"

    return {
        "risk_level": level,
        "decision": decision,
        "high_risk_hits": hits,
        "boundary": "MCP observes and reports; pk-client/operator applies only after approval."
    }


@mcp.resource("planekey://workspace/current")
def resource_workspace_current() -> str:
    """Current workspace scan summary as a resource."""
    result = planekey_scan_workspace()
    return json.dumps({
        "service_id": result["service_id"],
        "environment_id": result["environment_id"],
        "workspace_hash": result["workspace_hash"],
        "files_scanned": result["files_scanned"],
        "high_risk_files": result["high_risk_files"],
    }, indent=2)


@mcp.resource("planekey://policy/current")
def resource_policy_current() -> str:
    """Current MCP safety policy."""
    return json.dumps({
        "mcp_role": "environment_observer",
        "allowed": ["scan_workspace", "submit_report", "record_assistant_suggestion", "read_environment_state", "explain_risk"],
        "forbidden": ["patch_files", "delete_files", "deploy", "execute_assistant_shell", "bypass_home_bridge_review"],
        "rule": "MCP observes. Home Bridge records. pk-client/operator acts only after approval."
    }, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--http", action="store_true", help="Run Streamable HTTP/SSE-style transport if supported by installed MCP SDK")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PLANEKEY_MCP_PORT", "8765")))
    args = parser.parse_args()

    if args.http:
        # FastMCP SDK support varies by version. Try HTTP-friendly run path first.
        try:
            mcp.run(transport="streamable-http", host="0.0.0.0", port=args.port)
        except TypeError:
            # Older FastMCP builds may only support transport kwarg.
            mcp.run(transport="streamable-http")
    else:
        mcp.run()


if __name__ == "__main__":
    main()

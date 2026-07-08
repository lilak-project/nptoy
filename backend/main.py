"""nptoy backend — FastAPI app (PLAN §5).

Mounted behind the portal proxy at `/p/nptoy/`. The portal strips that prefix, so
this app sees plain `/…` paths. SSO via the portal JWT (auth.require_user); each
user gets an isolated workspace and a slice of the global single-worker queue.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import websockets

import browse
import common
import config
import db
import inputs
import migrate
import params as params_mod
import rbrowser as rbrowser_mod
import saves as saves_mod
import scene
import stylepresets as styles_mod
import sim_client
import session as session_mod
import settings as settings_mod
import worker
import workspace
from auth import PortalUser, require_user

app = FastAPI(title="nptoy", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.on_event("startup")
def _startup() -> None:
    config.ensure_dirs()
    common.build_common()          # extract preset workspaces from nptool sources
    migrate.run()                  # one-time: users/ → user/ + new layout
    worker.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    rbrowser_mod.shutdown_all()    # don't leak per-user RBrowser processes


def require_manager(user: PortalUser = Depends(require_user)) -> PortalUser:
    """Portal 'manager' role only (admin panel)."""
    if user.role != "manager":
        raise HTTPException(status_code=403, detail="관리자 전용입니다.")
    return user


# ── health (no auth — SERVICE_CONTRACT §2 health) ─────────────────────────────
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": config.SERVICE_NAME}


@app.get("/api/whoami")
def whoami(user: PortalUser = Depends(require_user)) -> dict:
    """Portal identity of the caller (nptoy scaffold pages read this)."""
    return {"authenticated": True, "email": user.email, "username": user.username,
            "name": user.name, "role": user.role, "color": user.color, "shape": user.shape}


# ── identity + quota (PLAN §5 /api/me) ────────────────────────────────────────
@app.get("/api/me")
def me(user: PortalUser = Depends(require_user)) -> dict:
    used = workspace.user_usage(user.user_key)
    return {
        "email": user.email,
        "username": user.username,
        "name": user.name,
        "role": user.role,
        "quota_bytes": workspace.quota(user.user_key),
        "used_bytes": used,
    }


@app.get("/api/params/schema")
def params_schema(_: PortalUser = Depends(require_user)) -> dict:
    return {"fields": params_mod.PARAM_SCHEMA}


# ── jobs ──────────────────────────────────────────────────────────────────────
class SubmitJob(BaseModel):
    params: dict = {}


def _queue_position(session, job: db.Job) -> int | None:
    """0 = the currently running job; 1.. = place in the FIFO queue."""
    if job.status == db.STATUS_RUNNING:
        return 0
    if job.status != db.STATUS_QUEUED:
        return None
    ahead = (
        session.query(db.Job)
        .filter(db.Job.status == db.STATUS_QUEUED, db.Job.created_at < job.created_at)
        .count()
    )
    running = session.query(db.Job).filter(db.Job.status == db.STATUS_RUNNING).count()
    return ahead + running + 1


@app.post("/api/jobs", status_code=201)
def submit_job(body: SubmitJob, user: PortalUser = Depends(require_user)) -> dict:
    # 1) validate params against the whitelist (PLAN §4.1 / §8)
    try:
        clean = params_mod.validate(body.params)
    except params_mod.ParamError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 2) quota gate: refuse if already over (counts the whole user dir now).
    if workspace.over_quota(user.user_key):
        raise HTTPException(status_code=413,
                            detail="디스크 용량 초과 — outputs를 정리하세요.")

    # 3) enqueue. The worker runs in place against inputs/ and writes artifacts to
    # outputs/job_<id>.* — no per-job workspace is created here.
    import json
    job_id = uuid.uuid4().hex[:16]
    inputs.ensure(user.user_key, user.username)
    run_id = inputs.next_run(user.user_key, user.username)["run_id"]
    session = db.Session()
    try:
        job = db.Job(
            id=job_id, user_key=user.user_key, email=user.email,
            status=db.STATUS_QUEUED, params_json=json.dumps(clean),
            workdir=str(inputs.outputs_dir(user.user_key)), run_name=run_id,
        )
        session.add(job)
        session.commit()
        return job.to_dict(queue_position=_queue_position(session, job))
    finally:
        session.close()


@app.get("/api/jobs")
def list_jobs(user: PortalUser = Depends(require_user)) -> dict:
    session = db.Session()
    try:
        jobs = (
            session.query(db.Job)
            .filter(db.Job.user_key == user.user_key)
            .order_by(db.Job.created_at.desc())
            .all()
        )
        return {"jobs": [j.to_dict(queue_position=_queue_position(session, j)) for j in jobs]}
    finally:
        session.close()


def _owned_job(session, job_id: str, user: PortalUser) -> db.Job:
    job = session.get(db.Job, job_id)
    if not job or job.user_key != user.user_key:
        raise HTTPException(status_code=404, detail="잡을 찾을 수 없습니다.")
    return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, user: PortalUser = Depends(require_user)) -> dict:
    session = db.Session()
    try:
        job = _owned_job(session, job_id, user)
        out = job.to_dict(queue_position=_queue_position(session, job))
        log = inputs.run_paths(user.user_key, f"job_{job_id}")["log"]
        if log.exists():
            out["log_tail"] = "\n".join(log.read_text().splitlines()[-40:])
        return out
    finally:
        session.close()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, user: PortalUser = Depends(require_user)) -> dict:
    session = db.Session()
    try:
        _owned_job(session, job_id, user)  # ownership check (raises 404 otherwise)
    finally:
        session.close()
    result = worker.request_cancel(job_id)
    if result == "not-cancellable":
        raise HTTPException(status_code=409, detail="이미 끝난 잡입니다.")
    return {"ok": True, "result": result}


@app.get("/api/jobs/{job_id}/viewer")
def job_viewer(job_id: str, tracks_from: int = 0, tracks_count: int = 0,
               user: PortalUser = Depends(require_user)) -> JSONResponse:
    """Scene JSON for the 3D viewer (PLAN §4.4). Geometry from GDML if exported;
    nptool track/point extraction from the ROOT output is the next step."""
    session = db.Session()
    try:
        job = _owned_job(session, job_id, user)
        n_events = int(job.params.get("n_events", 0))
    finally:
        session.close()
    rp = inputs.run_paths(user.user_key, f"job_{job_id}")
    return JSONResponse(scene.from_online(rp["stream"], rp["geom"],
                                          tracks_from=tracks_from, tracks_count=tracks_count or None))


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str, user: PortalUser = Depends(require_user)) -> StreamingResponse:
    """Zip of the job's output artifacts — owner only (PLAN §4.5)."""
    session = db.Session()
    try:
        _owned_job(session, job_id, user)
    finally:
        session.close()
    rp = inputs.run_paths(user.user_key, f"job_{job_id}")
    files = [rp[k] for k in ("root", "gdml", "geom", "stream", "log", "mac") if rp[k].exists()]
    if not files:
        raise HTTPException(status_code=404, detail="결과가 없습니다.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(f, f.name)
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="nptoy-{job_id}.zip"'},
    )


# ── queue (global, PLAN §5 /api/queue) ────────────────────────────────────────
@app.get("/api/queue")
def queue(_: PortalUser = Depends(require_user)) -> dict:
    session = db.Session()
    try:
        running = session.query(db.Job).filter(db.Job.status == db.STATUS_RUNNING).count()
        queued = session.query(db.Job).filter(db.Job.status == db.STATUS_QUEUED).count()
        return {"running": running, "queued": queued}
    finally:
        session.close()


# ── input workspace (3 editable slots: physics / detector / reaction) ─────────
class SaveSlot(BaseModel):
    slot: str
    content: str


class LoadExample(BaseModel):
    example: str


@app.get("/api/inputs")
def inputs_state(user: PortalUser = Depends(require_user)) -> dict:
    inputs.ensure(user.user_key, user.username)
    return {
        "slots": inputs.SLOTS,
        "crosssection": inputs.cs_info(user.user_key),
        "project": inputs.project_name(user.user_key),
        "name": inputs.setup_name(user.user_key),
        "run": inputs.next_run(user.user_key, user.username)["run"],
        "example": inputs.manifest(user.user_key).get("example", ""),
        "examples": inputs.examples(),
    }


class SaveContent(BaseModel):
    content: str


@app.get("/api/inputs/sources")
def inputs_sources(user: PortalUser = Depends(require_user)) -> dict:
    """Loadable input sources: built-in common presets + users who shared inputs."""
    return {
        "common": inputs.examples(),
        "users": saves_mod.shared_sources(),
        "me": user.user_key,
    }


@app.get("/api/inputs/crosssection")
def cs_get(name: str | None = None, user: PortalUser = Depends(require_user)) -> dict:
    path = name or inputs.cs_info(user.user_key)["path"]
    return {"path": path, "content": inputs.read_cs(user.user_key, name)}


@app.get("/api/inputs/crosssections")
def cs_candidates(user: PortalUser = Depends(require_user)) -> dict:
    return {"files": inputs.cs_candidates(user.user_key)}


class SaveCS(BaseModel):
    content: str
    name: str | None = None


@app.put("/api/inputs/crosssection")
def cs_put(body: SaveCS, user: PortalUser = Depends(require_user)) -> dict:
    name = body.name.strip() if body.name else None
    if name and "." not in name.rsplit("/", 1)[-1]:
        name += ".txt"                         # give bare names a .txt extension
    inputs.write_cs(user.user_key, body.content, name)
    return {"ok": True, "path": name or inputs.cs_info(user.user_key)["path"]}


# ── named / shareable configurations ──────────────────────────────────────────
class SaveConfig(BaseModel):
    name: str = ""
    shared: bool = False


class ShareConfig(BaseModel):
    shared: bool


@app.get("/api/configs")
def configs_list(user: PortalUser = Depends(require_user)) -> dict:
    return {"configs": saves_mod.list_for(user.user_key)}


@app.post("/api/configs")
def configs_save(body: SaveConfig, user: PortalUser = Depends(require_user)) -> dict:
    return saves_mod.save(user.user_key, user.username, body.name, body.shared)


@app.post("/api/configs/{cid}/load")
def configs_load(cid: str, user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    if s and s.alive():
        raise HTTPException(status_code=409, detail="세션 실행 중에는 불러올 수 없습니다.")
    try:
        return {"manifest": saves_mod.load(user.user_key, user.username, cid)}
    except KeyError:
        raise HTTPException(status_code=404, detail="설정을 찾을 수 없습니다.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="접근 권한이 없습니다.")


@app.post("/api/configs/{cid}/share")
def configs_share(cid: str, body: ShareConfig, user: PortalUser = Depends(require_user)) -> dict:
    try:
        return saves_mod.set_shared(user.user_key, cid, body.shared)
    except KeyError:
        raise HTTPException(status_code=404, detail="설정을 찾을 수 없습니다.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="소유자만 공유할 수 있습니다.")


@app.delete("/api/configs/{cid}")
def configs_delete(cid: str, user: PortalUser = Depends(require_user)) -> dict:
    try:
        saves_mod.delete(user.user_key, cid)
    except KeyError:
        raise HTTPException(status_code=404, detail="설정을 찾을 수 없습니다.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="소유자만 삭제할 수 있습니다.")
    return {"ok": True}


# ── viewer style presets (per-user, shareable) ────────────────────────────────
class SaveStylePreset(BaseModel):
    name: str = ""
    data: dict = {}
    shared: bool = False


@app.get("/api/styles")
def styles_list(user: PortalUser = Depends(require_user)) -> dict:
    return {"presets": styles_mod.list_for(user.user_key)}


@app.post("/api/styles")
def styles_save(body: SaveStylePreset, user: PortalUser = Depends(require_user)) -> dict:
    return styles_mod.save(user.user_key, user.username, body.name, body.data, body.shared)


@app.get("/api/styles/{sid}")
def styles_load(sid: str, user: PortalUser = Depends(require_user)) -> dict:
    try:
        return {"data": styles_mod.load(user.user_key, sid)}
    except KeyError:
        raise HTTPException(status_code=404, detail="스타일을 찾을 수 없습니다.")


@app.post("/api/styles/{sid}/share")
def styles_share(sid: str, body: ShareConfig, user: PortalUser = Depends(require_user)) -> dict:
    try:
        return styles_mod.set_shared(user.user_key, sid, body.shared)
    except KeyError:
        raise HTTPException(status_code=404, detail="스타일을 찾을 수 없습니다.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="소유자만 공유할 수 있습니다.")


@app.delete("/api/styles/{sid}")
def styles_delete(sid: str, user: PortalUser = Depends(require_user)) -> dict:
    try:
        styles_mod.delete(user.user_key, sid)
    except KeyError:
        raise HTTPException(status_code=404, detail="스타일을 찾을 수 없습니다.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="소유자만 삭제할 수 있습니다.")
    return {"ok": True}


# ── community chat: shared reusable module (kit <Community> + community.py) ────
from community import build_community_router


def _cm_identity(user: PortalUser = Depends(require_user)) -> dict:
    """Adapt nptoy's strict PortalUser → the soft-identity dict the community
    router expects (carries the portal avatar so chat matches the portal)."""
    return {"authenticated": True, "email": user.email, "username": user.username,
            "name": user.name, "role": user.role, "color": user.color, "shape": user.shape}


app.include_router(build_community_router(
    db_path=config.DATA_ROOT / "community.db",
    uploads_dir=config.DATA_ROOT / "community_uploads",
    identity=_cm_identity,
))


@app.get("/api/inputs/file")
def inputs_get_file(slot: str, user: PortalUser = Depends(require_user)) -> dict:
    try:
        return {"slot": slot, "content": inputs.read_slot(user.user_key, slot)}
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")


@app.put("/api/inputs/file")
def inputs_put_file(body: SaveSlot, user: PortalUser = Depends(require_user)) -> dict:
    try:
        inputs.write_slot(user.user_key, body.slot, body.content)
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=400, detail="잘못된 슬롯입니다.")
    return {"ok": True}


@app.post("/api/inputs/load-example")
def inputs_load_example(body: LoadExample, user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    if s and s.alive():
        raise HTTPException(status_code=409, detail="세션 실행 중에는 프리셋을 불러올 수 없습니다.")
    try:
        inputs.seed(user.user_key, body.example, user.username, name=body.example)
    except KeyError:
        raise HTTPException(status_code=404, detail="알 수 없는 프리셋입니다.")
    return {"ok": True, "project": inputs.project_name(user.user_key),
            "name": inputs.setup_name(user.user_key)}


# ── interactive nptool sessions (live npsimulation -N + Run button) ───────────
class RunBeamOn(BaseModel):
    n: int


@app.get("/api/session")
def session_status(user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    return {"session": s.to_dict() if s else None}


@app.post("/api/session/start")
def session_start(user: PortalUser = Depends(require_user)) -> dict:
    """Start a session running the user's current input workspace (/api/inputs)."""
    if workspace.over_quota(user.user_key):
        raise HTTPException(status_code=413, detail="디스크 용량 초과 — outputs를 정리하세요.")
    try:
        s = session_mod.manager.start(user.user_key, user.username)
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail=str(exc))
    return s.to_dict()


@app.post("/api/session/run")
def session_run(body: RunBeamOn, user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    if not s or not s.alive():
        raise HTTPException(status_code=409, detail="실행 중인 세션이 없습니다.")
    if workspace.over_quota(user.user_key):
        raise HTTPException(status_code=413, detail="디스크 용량 초과 — outputs를 정리하세요.")
    if body.n < 1 or body.n > config.SESSION_MAX_BEAMON:
        raise HTTPException(status_code=400,
                            detail=f"이벤트 수는 1..{config.SESSION_MAX_BEAMON} 사이여야 합니다.")
    try:
        s.run_beamon(body.n)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))  # not idle yet
    return s.to_dict()


@app.get("/api/session/log")
def session_log(since: int = 0, user: PortalUser = Depends(require_user)) -> dict:
    s = session_mod.manager.get(user.user_key)
    if not s:
        raise HTTPException(status_code=409, detail="세션이 없습니다.")
    return s.log_since(since)


@app.get("/api/session/scene")
def session_scene(tracks_from: int = 0, tracks_count: int = 0,
                  user: PortalUser = Depends(require_user)) -> JSONResponse:
    """Live 3D scene for the current session: GDML geometry + the streamed
    tracks/energy points (`online_stream.dat`), updating as /run/beamOn runs.
    `tracks_from`/`tracks_count` page through the (ordered) tracks (0 = default cap)."""
    s = session_mod.manager.get(user.user_key)
    if not s:
        raise HTTPException(status_code=409, detail="세션이 없습니다.")
    return JSONResponse(scene.from_online(s.paths["live_stream"], s.paths["geom"],
                                          tracks_from=tracks_from, tracks_count=tracks_count or None))


@app.post("/api/session/stop")
def session_stop(user: PortalUser = Depends(require_user)) -> dict:
    return {"stopped": session_mod.manager.stop(user.user_key)}


# ── file browser (read-only, sandboxed to the user's data folder) ─────────────
@app.get("/api/files")
def files_list(path: str = "", user: PortalUser = Depends(require_user)) -> dict:
    try:
        return browse.list_dir(user.user_key, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="잘못된 경로입니다.")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")


@app.get("/api/files/read")
def files_read(path: str, user: PortalUser = Depends(require_user)) -> dict:
    try:
        return browse.read_file(user.user_key, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="잘못된 경로입니다.")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")


@app.get("/api/files/download")
def files_download(path: str, user: PortalUser = Depends(require_user)) -> FileResponse:
    try:
        p = browse.resolve(user.user_key, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="잘못된 경로입니다.")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return FileResponse(str(p), filename=p.name, media_type="application/octet-stream")


class PathList(BaseModel):
    paths: list[str]


@app.post("/api/files/delete")
def files_delete(body: PathList, user: PortalUser = Depends(require_user)) -> dict:
    freed = browse.delete_paths(user.user_key, body.paths)
    return {"ok": True, "bytes_freed": freed, "usage": workspace.user_usage(user.user_key)}


@app.post("/api/files/zip")
def files_zip(body: PathList, user: PortalUser = Depends(require_user)) -> StreamingResponse:
    """Bundle the selected files/folders into a single zip download."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in body.paths:
            try:
                p = browse.resolve(user.user_key, rel)
            except ValueError:
                continue
            if p.is_file():
                z.write(p, arcname=p.name)
            elif p.is_dir():
                for f in p.rglob("*"):
                    if f.is_file():
                        z.write(f, arcname=str(Path(p.name) / f.relative_to(p)))
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="nptoy-files.zip"'})


# ── RBrowser (confined ROOT file viewer) ──────────────────────────────────────
class RBrowserOpen(BaseModel):
    path: str = ""          # selected .root (relative to the user folder); advisory


@app.post("/api/rbrowser/open")
def rbrowser_open(body: RBrowserOpen, user: PortalUser = Depends(require_user)) -> dict:
    """Ensure the user's confined RBrowser is running (scoped to their whole folder)
    and return its launch URL. A second .root reuses the same process — the folder
    already contains inputs/ + outputs/, so no per-file relaunch is needed."""
    # Guard: only meaningful for .root files that live in the user's folder.
    if body.path:
        try:
            p = browse.resolve(user.user_key, body.path)
        except ValueError:
            raise HTTPException(status_code=403, detail="잘못된 경로입니다.")
        if p.suffix != ".root":
            raise HTTPException(status_code=400, detail="ROOT 파일이 아닙니다.")
    try:
        return rbrowser_mod.open_for(user.user_key)
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


_RB_COOKIE = "nptoy_rbrowser_proxy"
_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}
_RB_TEXT_TYPES = (
    "text/html",
    "text/css",
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
)
_RB_ASSET_RE = re.compile(r"(?:\.\./)+(jsrootsys|rootui5sys)/")


def _rbrowser_session_from_request(request: Request, path: str = "") -> tuple[dict, str]:
    path_token = None
    upstream_path = path
    if "/" in path:
        first, rest = path.split("/", 1)
        if first:
            path_token = first
            upstream_path = rest
    token = path_token or request.query_params.get("pt") or request.cookies.get(_RB_COOKIE)
    sess = rbrowser_mod.session_for_proxy(token)
    if not sess:
        raise HTTPException(status_code=403, detail="RBrowser 세션이 없습니다.")
    return sess, upstream_path


def _rbrowser_proxy_prefix(sess: dict) -> str:
    token = sess.get("proxy") or sess.get("token")
    return f"/p/{config.SERVICE_NAME}/api/rbrowser/proxy/{token}/"


def _rewrite_rbrowser_assets(body: bytes, content_type: str, sess: dict) -> bytes:
    if not any(content_type.startswith(t) for t in _RB_TEXT_TYPES):
        return body
    prefix = _rbrowser_proxy_prefix(sess)
    text = body.decode(errors="replace")
    text = _RB_ASSET_RE.sub(lambda m: prefix + m.group(1) + "/", text)
    for asset in ("jsrootsys", "rootui5sys"):
        text = text.replace(f'"/{asset}/', f'"{prefix}{asset}/')
        text = text.replace(f"'/{asset}/", f"'{prefix}{asset}/")
        text = text.replace(f"`/{asset}/", f"`{prefix}{asset}/")
        text = text.replace(f"url(/{asset}/", f"url({prefix}{asset}/")
    return text.encode()


@app.api_route("/api/rbrowser/proxy/{path:path}", methods=["GET", "POST", "HEAD"])
async def rbrowser_proxy(path: str, request: Request) -> Response:
    sess, upstream_path = _rbrowser_session_from_request(request, path)
    query_items = [(k, v) for k, v in request.query_params.multi_items() if k != "pt"]
    query = urllib.parse.urlencode(query_items, doseq=True)
    if sess.get("backend") == "sci":
        url = sim_client.rbrowser_http_url(sess["token"], upstream_path, query)
    else:
        url = f"http://127.0.0.1:{sess['port']}/{upstream_path}"
        if query:
            url += "?" + query
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_HEADERS and k.lower() not in {"host", "accept-encoding"}
    }
    headers["Accept-Encoding"] = "identity"
    data = await request.body() if request.method in ("POST", "PUT", "PATCH") else None
    req = urllib.request.Request(url, data=data, headers=headers, method=request.method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
            content_type = r.headers.get_content_type()
            body = _rewrite_rbrowser_assets(body, content_type, sess)
            out_headers = {
                k: v for k, v in r.headers.items()
                if k.lower() not in _HOP_HEADERS and k.lower() not in {"content-length", "content-encoding"}
            }
            resp = Response(content=body, status_code=r.status, headers=out_headers,
                            media_type=content_type)
    except urllib.error.HTTPError as e:
        resp = Response(content=e.read(), status_code=e.code,
                        media_type=e.headers.get_content_type() if e.headers else None)
    token_value = sess.get("proxy") or sess.get("token")
    if request.query_params.get("pt") and token_value:
        resp.set_cookie(_RB_COOKIE, token_value, httponly=True, samesite="lax", path="/")
    return resp


@app.websocket("/api/rbrowser/proxy/{path:path}")
async def rbrowser_proxy_ws(path: str, websocket: WebSocket):
    try:
        sess, upstream_path = _rbrowser_session_from_request(websocket, path)
    except HTTPException:
        await websocket.close(code=1008)
        return
    query_items = [(k, v) for k, v in websocket.query_params.multi_items() if k != "pt"]
    query = urllib.parse.urlencode(query_items, doseq=True)
    if sess.get("backend") == "sci":
        url = sim_client.rbrowser_ws_url(sess["token"], upstream_path, query)
    else:
        url = f"ws://127.0.0.1:{sess['port']}/{upstream_path}"
        if query:
            url += "?" + query
    await websocket.accept()
    try:
        async with websockets.connect(url, max_size=None) as upstream:  # RBrowser dir/histogram frames exceed 1 MB
            async def client_to_upstream():
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("text") is not None:
                            await upstream.send(msg["text"])
                        elif msg.get("bytes") is not None:
                            await upstream.send(msg["bytes"])
                except WebSocketDisconnect:
                    await upstream.close()

            async def upstream_to_client():
                async for msg in upstream:
                    if isinstance(msg, bytes):
                        await websocket.send_bytes(msg)
                    else:
                        await websocket.send_text(msg)

            import asyncio
            done, pending = await asyncio.wait(
                [asyncio.create_task(client_to_upstream()), asyncio.create_task(upstream_to_client())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass


@app.post("/api/rbrowser/close")
def rbrowser_close(user: PortalUser = Depends(require_user)) -> dict:
    return {"closed": rbrowser_mod.close_for(user.user_key)}


# ── user outputs (ROOT / GDML results) ────────────────────────────────────────
@app.get("/api/outputs")
def outputs_list(user: PortalUser = Depends(require_user)) -> dict:
    return {"runs": workspace.list_runs(user.user_key)}


@app.get("/api/outputs/file")
def outputs_file(name: str, user: PortalUser = Depends(require_user)) -> FileResponse:
    try:
        p = workspace.output_file(user.user_key, name)
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=404, detail="파일이 없습니다.")
    return FileResponse(str(p), filename=p.name, media_type="application/octet-stream")


@app.get("/api/outputs/scene")
def outputs_scene(run: str, tracks_from: int = 0, tracks_count: int = 0,
                  user: PortalUser = Depends(require_user)) -> JSONResponse:
    """3D scene for a stored run (GDML geometry + persisted stream)."""
    rp = inputs.run_paths(user.user_key, run.replace("/", "").replace("..", ""))
    return JSONResponse(scene.from_online(rp["stream"], rp["geom"],
                                          tracks_from=tracks_from, tracks_count=tracks_count or None))


@app.delete("/api/outputs")
def outputs_delete_run(run: str, user: PortalUser = Depends(require_user)) -> dict:
    freed = workspace.delete_run(user.user_key, run)
    return {"ok": True, "bytes_freed": freed, "used_bytes": workspace.user_usage(user.user_key)}


@app.post("/api/outputs/clean")
def outputs_clean(user: PortalUser = Depends(require_user)) -> dict:
    """User clears their own outputs/ (ROOT results) to free quota."""
    freed = workspace.clean_outputs(user.user_key)
    return {"ok": True, "bytes_freed": freed, "used_bytes": workspace.user_usage(user.user_key)}


# ── admin panel (manager only): live limits + cleanup ─────────────────────────
class UpdateSettings(BaseModel):
    job_timeout_sec: int | None = None
    user_quota_bytes: int | None = None
    max_sessions: int | None = None


@app.get("/api/admin/settings")
def admin_settings(_: PortalUser = Depends(require_manager)) -> dict:
    overrides = settings_mod.user_overrides()
    users = [{**u, "override": overrides.get(u["user_key"], {}),
              "quota_bytes": workspace.quota(u["user_key"])}
             for u in workspace.usage_summary()]
    return {"settings": settings_mod.all(), "users": users}


@app.put("/api/admin/settings")
def admin_settings_update(body: UpdateSettings, _: PortalUser = Depends(require_manager)) -> dict:
    patch = {k: v for k, v in body.dict().items() if v is not None}
    return {"settings": settings_mod.update(patch)}


class UserLimit(BaseModel):
    user_key: str
    job_timeout_sec: int | None = None
    user_quota_bytes: int | None = None


@app.put("/api/admin/user-limit")
def admin_user_limit(body: UserLimit, _: PortalUser = Depends(require_manager)) -> dict:
    patch = {"job_timeout_sec": body.job_timeout_sec, "user_quota_bytes": body.user_quota_bytes}
    return {"override": settings_mod.set_user_limit(body.user_key, patch)}


class AdminClean(BaseModel):
    user_key: str | None = None    # None = every user


@app.post("/api/admin/clean")
def admin_clean(body: AdminClean, _: PortalUser = Depends(require_manager)) -> dict:
    if body.user_key:
        return {"bytes_freed": workspace.clean_outputs(body.user_key)}
    return workspace.clean_all_outputs()


# ── frontend ──────────────────────────────────────────────────────────────────
# The base-path-aware UI is served from public/ (Vite build lands here later).
# Mounted last so it never shadows the /api/* routes.
if config.PUBLIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.PUBLIC_DIR), html=True), name="public")

"""SQLite + the Job model (PLAN §6).

The queue is just the `status` column + a single worker loop (PLAN §7) — no
separate broker. The DB is the service's own, fully separate from the portal DB.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

import config

config.ensure_dirs()

_engine = create_engine(
    f"sqlite:///{config.DB_PATH}",
    connect_args={"check_same_thread": False},
)
Session = sessionmaker(bind=_engine, autoflush=False, autocommit=False)

# Job lifecycle (PLAN §4.2): a fresh job is queued, the single worker promotes the
# oldest to running, and it ends in exactly one terminal state.
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_TIMEOUT = "timeout"
STATUS_CANCELLED = "cancelled"
TERMINAL = {STATUS_DONE, STATUS_FAILED, STATUS_TIMEOUT, STATUS_CANCELLED}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_key: Mapped[str] = mapped_column(String, index=True)
    email: Mapped[str] = mapped_column(String, default="")
    status: Mapped[str] = mapped_column(String, index=True, default=STATUS_QUEUED)
    params_json: Mapped[str] = mapped_column(Text, default="{}")
    workdir: Mapped[str] = mapped_column(String, default="")
    run_name: Mapped[str] = mapped_column(String, default="")   # output basename: {project}_{run}.{user}.sim
    created_at: Mapped[str] = mapped_column(String, default=_now)
    started_at: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    finished_at: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    exit_code: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")

    # ── serialization ────────────────────────────────────────────────────────
    @property
    def params(self) -> dict:
        try:
            return json.loads(self.params_json)
        except (ValueError, TypeError):
            return {}

    def to_dict(self, queue_position: Optional[int] = None) -> dict:
        d = {
            "id": self.id,
            "status": self.status,
            "params": self.params,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "exit_code": self.exit_code,
            "size_bytes": self.size_bytes,
            "error": self.error,
        }
        if queue_position is not None:
            d["queue_position"] = queue_position
        return d


class ChatMessage(Base):
    """A single community-chat message (one global room, all service users)."""
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    author_key: Mapped[str] = mapped_column(String, index=True, default="")
    author_name: Mapped[str] = mapped_column(String, default="")
    author_color: Mapped[str] = mapped_column(String, default="")   # portal avatar colour
    author_shape: Mapped[str] = mapped_column(String, default="")   # portal avatar icon
    body: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String, default="msg", index=True)   # 'msg' | 'question'
    reply_to_id: Mapped[int] = mapped_column(Integer, default=0)           # 0 = not a reply
    reply_to_author: Mapped[str] = mapped_column(String, default="")
    reply_to_body: Mapped[str] = mapped_column(String, default="")
    attachments: Mapped[str] = mapped_column(Text, default="[]")           # JSON list
    created_at: Mapped[str] = mapped_column(String, default=_now, index=True)

    def to_dict(self) -> dict:
        try:
            atts = json.loads(self.attachments or "[]")
        except (ValueError, TypeError):
            atts = []
        return {
            "id": self.id, "author_key": self.author_key, "author_name": self.author_name,
            "author_color": self.author_color, "author_shape": self.author_shape,
            "body": self.body, "kind": self.kind, "attachments": atts,
            "reply_to_id": self.reply_to_id, "reply_to_author": self.reply_to_author,
            "reply_to_body": self.reply_to_body, "created_at": self.created_at,
        }


class CommunityBan(Base):
    """A user banned from the community chat (by user_key)."""
    __tablename__ = "community_bans"

    user_key: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, default="")
    created_at: Mapped[str] = mapped_column(String, default=_now)

    def to_dict(self) -> dict:
        return {"user_key": self.user_key, "name": self.name, "created_at": self.created_at}


Base.metadata.create_all(_engine)


def _migrate() -> None:
    """Add columns introduced after a table first shipped (SQLite has no schema-diff;
    create_all only creates missing tables, not missing columns)."""
    from sqlalchemy import text
    with _engine.begin() as conn:
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(chat_messages)"))}
        adds = {
            "author_color": "VARCHAR DEFAULT ''", "author_shape": "VARCHAR DEFAULT ''",
            "kind": "VARCHAR DEFAULT 'msg'", "reply_to_id": "INTEGER DEFAULT 0",
            "reply_to_author": "VARCHAR DEFAULT ''", "reply_to_body": "VARCHAR DEFAULT ''",
            "attachments": "TEXT DEFAULT '[]'",
        }
        for name, decl in adds.items():
            if name not in cols:
                conn.execute(text(f"ALTER TABLE chat_messages ADD COLUMN {name} {decl}"))
        jcols = {r[1] for r in conn.execute(text("PRAGMA table_info(jobs)"))}
        if "run_name" not in jcols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN run_name VARCHAR DEFAULT ''"))


_migrate()


def recover_orphans() -> int:
    """On boot, any job left `running` belongs to a worker that died with the
    process (PLAN §7). Mark them failed so the queue starts clean."""
    db = Session()
    try:
        orphans = db.query(Job).filter(Job.status == STATUS_RUNNING).all()
        for job in orphans:
            job.status = STATUS_FAILED
            job.error = "worker restarted while running"
            job.finished_at = _now()
        if orphans:
            db.commit()
        return len(orphans)
    finally:
        db.close()

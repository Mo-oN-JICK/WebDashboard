from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import UniqueConstraint
from werkzeug.security import check_password_hash, generate_password_hash

from . import db


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    name = db.Column(db.String(120), nullable=False)
    passwordHash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default="viewer")
    isActive = db.Column(db.Boolean, nullable=False, default=True)
    createdAt = db.Column(db.DateTime(timezone=True), default=now_utc, nullable=False)
    updatedAt = db.Column(db.DateTime(timezone=True), default=now_utc, onupdate=now_utc, nullable=False)

    def set_password(self, password: str) -> None:
        self.passwordHash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.passwordHash, password)


class ProcessMaster(db.Model):
    __tablename__ = "process_master"
    id = db.Column(db.Integer, primary_key=True)
    line = db.Column(db.String(80), nullable=False, index=True)
    type = db.Column(db.String(120), nullable=False, index=True)
    processName = db.Column(db.String(200), nullable=False, index=True)
    status = db.Column(db.String(80), nullable=False, default="안정화 상태")
    isActive = db.Column(db.Boolean, nullable=False, default=True)
    createdAt = db.Column(db.DateTime(timezone=True), default=now_utc, nullable=False)
    updatedAt = db.Column(db.DateTime(timezone=True), default=now_utc, onupdate=now_utc, nullable=False)
    measurements = db.relationship("DailyMeasurement", backref="process", lazy=True)
    __table_args__ = (UniqueConstraint("line", "type", "processName", name="uq_process_identity"),)


class DailyMeasurement(db.Model):
    __tablename__ = "daily_measurement"
    id = db.Column(db.Integer, primary_key=True)
    processId = db.Column(db.Integer, db.ForeignKey("process_master.id"), nullable=False, index=True)
    measurementDate = db.Column(db.Date, nullable=False, index=True)
    totalCount = db.Column(db.Integer, nullable=False, default=0)
    ngCount = db.Column(db.Integer, nullable=False, default=0)
    etcCount = db.Column(db.Integer, nullable=False, default=0)
    clusterCount = db.Column(db.Integer, nullable=False, default=0)
    trueDefectCount = db.Column(db.Integer, nullable=False, default=0)
    missedInspectionCount = db.Column(db.Integer, nullable=False, default=0)
    overInspectionCount = db.Column(db.Integer, nullable=False, default=0)
    clusterUpperCount = db.Column(db.Integer, nullable=False, default=0)
    clusterLowerNearCount = db.Column(db.Integer, nullable=False, default=0)
    clusterLowerFarCount = db.Column(db.Integer, nullable=False, default=0)
    classCount = db.Column(db.Integer, nullable=False, default=0)
    note = db.Column(db.Text, nullable=True)
    createdBy = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    updatedBy = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    createdAt = db.Column(db.DateTime(timezone=True), default=now_utc, nullable=False)
    updatedAt = db.Column(db.DateTime(timezone=True), default=now_utc, onupdate=now_utc, nullable=False)
    __table_args__ = (UniqueConstraint("processId", "measurementDate", name="uq_process_date"),)

    @property
    def ngRate(self) -> float:
        return 0 if self.totalCount == 0 else self.ngCount / self.totalCount * 100

    @property
    def etcRate(self) -> float:
        return 0 if self.totalCount == 0 else self.etcCount / self.totalCount * 100


class StatusOption(db.Model):
    __tablename__ = "status_options"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)
    isActive = db.Column(db.Boolean, nullable=False, default=True)


class NoteTemplate(db.Model):
    __tablename__ = "note_templates"
    id = db.Column(db.Integer, primary_key=True)
    text = db.Column(db.String(200), unique=True, nullable=False)


class AppSetting(db.Model):
    __tablename__ = "app_settings"
    key = db.Column(db.String(80), primary_key=True)
    value = db.Column(db.String(200), nullable=False)


class AuditLog(db.Model):
    __tablename__ = "audit_logs"
    id = db.Column(db.Integer, primary_key=True)
    actionAt = db.Column(db.DateTime(timezone=True), default=now_utc, nullable=False, index=True)
    userId = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    username = db.Column(db.String(80), nullable=True)
    actionType = db.Column(db.String(40), nullable=False)
    targetType = db.Column(db.String(80), nullable=False)
    targetId = db.Column(db.String(80), nullable=True)
    beforeValue = db.Column(db.JSON, nullable=True)
    afterValue = db.Column(db.JSON, nullable=True)

from __future__ import annotations

import os
from datetime import date

from . import db
from .models import AppSetting, DailyMeasurement, NoteTemplate, ProcessMaster, StatusOption, User


def seed_defaults() -> None:
    for name in ["안정화 상태", "점검 중", "개선 중", "비가동", "완료"]:
        if not StatusOption.query.filter_by(name=name).first():
            db.session.add(StatusOption(name=name))
    for text in ["재학습", "설비점검", "부품교체"]:
        if not NoteTemplate.query.filter_by(text=text).first():
            db.session.add(NoteTemplate(text=text))
    defaults = {
        "ng_rate_threshold": "1.0",
        "etc_rate_threshold": "1.0",
        "ng_increase_threshold": "30",
        "total_drop_threshold": "50",
    }
    for key, value in defaults.items():
        if not AppSetting.query.get(key):
            db.session.add(AppSetting(key=key, value=value))

    admin_username = os.getenv("ADMIN_USERNAME", "admin")
    admin = User.query.filter_by(username=admin_username).first()
    if not admin:
        admin = User(username=admin_username, name=os.getenv("ADMIN_NAME", "관리자"), role="admin")
        admin.set_password(os.getenv("ADMIN_PASSWORD", "admin1234"))
        db.session.add(admin)
    if not User.query.filter_by(username="viewer").first():
        viewer = User(username="viewer", name="조회자", role="viewer")
        viewer.set_password("viewer1234")
        db.session.add(viewer)
    db.session.flush()

    samples = [
        ("RA", "FAS2.0", "RAJ Middle-Screw", "안정화 상태"),
        ("RA", "FAS2.0", "RAJ Middle-Front", "안정화 상태"),
    ]
    processes = []
    for line, typ, name, status in samples:
        proc = ProcessMaster.query.filter_by(line=line, type=typ, processName=name).first()
        if not proc:
            proc = ProcessMaster(line=line, type=typ, processName=name, status=status)
            db.session.add(proc)
            db.session.flush()
        processes.append(proc)
    data = [
        (date(2026, 7, 20), 1013, 15, 0, 115, ""),
        (date(2026, 7, 21), 5580, 28, 2, 115, "재학습"),
    ]
    for measurement_date, total, ng, etc, cluster, note in data:
        exists = DailyMeasurement.query.filter_by(processId=processes[0].id, measurementDate=measurement_date).first()
        if not exists:
            db.session.add(
                DailyMeasurement(
                    processId=processes[0].id,
                    measurementDate=measurement_date,
                    totalCount=total,
                    ngCount=ng,
                    etcCount=etc,
                    clusterCount=cluster,
                    note=note,
                    createdBy=admin.id,
                    updatedBy=admin.id,
                )
            )
    db.session.commit()

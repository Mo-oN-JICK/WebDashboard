from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from functools import wraps

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for
from sqlalchemy import desc, func
from sqlalchemy.exc import IntegrityError

from . import db
from .models import AppSetting, AuditLog, DailyMeasurement, NoteTemplate, ProcessMaster, StatusOption, User
from .services import (
    add_audit,
    dataframe_response,
    filtered_query,
    import_rows,
    measurement_dict,
    previous_period,
    rate,
    read_upload_rows,
    summarize,
    to_int,
    validate_measurement,
)

bp = Blueprint("main", __name__)
KST = timezone(timedelta(hours=9))


def current_user() -> User | None:
    uid = session.get("user_id")
    return User.query.get(uid) if uid else None


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user():
            if request.path.startswith("/api/"):
                return jsonify({"error": "로그인이 필요합니다"}), 401
            return redirect(url_for("main.login"))
        return fn(*args, **kwargs)

    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user or user.role != "admin":
            return jsonify({"error": "관리자 권한이 필요합니다"}), 403
        return fn(*args, **kwargs)

    return wrapper


@bp.app_context_processor
def inject_user():
    return {"current_user": current_user(), "now_kst": lambda: datetime.now(KST)}


@bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        user = User.query.filter_by(username=request.form.get("username", ""), isActive=True).first()
        if user and user.check_password(request.form.get("password", "")):
            session.permanent = True
            session["user_id"] = user.id
            return redirect(url_for("main.index"))
        return render_template("login.html", error="아이디 또는 비밀번호가 올바르지 않습니다")
    return render_template("login.html")


@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("main.login"))


@bp.route("/")
@login_required
def index():
    last = db.session.query(func.max(DailyMeasurement.measurementDate), func.max(DailyMeasurement.updatedAt)).first()
    return render_template(
        "index.html",
        last_date=last[0].isoformat() if last and last[0] else "-",
        last_update=last[1].astimezone(KST).strftime("%Y-%m-%d %H:%M") if last and last[1] else "-",
    )


@bp.get("/api/options")
@login_required
def options():
    processes = ProcessMaster.query.order_by(ProcessMaster.line, ProcessMaster.type, ProcessMaster.processName).all()
    return jsonify(
        {
            "lines": sorted({p.line for p in processes}),
            "types": sorted({p.type for p in processes}),
            "processes": [
                {"id": p.id, "line": p.line, "type": p.type, "processName": p.processName, "status": p.status, "isActive": p.isActive}
                for p in processes
            ],
            "statuses": [s.name for s in StatusOption.query.filter_by(isActive=True).order_by(StatusOption.name).all()],
            "noteTemplates": [n.text for n in NoteTemplate.query.order_by(NoteTemplate.text).all()],
            "settings": {s.key: s.value for s in AppSetting.query.all()},
        }
    )


@bp.get("/api/dashboard")
@login_required
def dashboard():
    summary = summarize(filtered_query(request.args))
    start = request.args.get("start")
    end = request.args.get("end")
    comparison = {}
    if start and end:
        ps, pe = previous_period(date.fromisoformat(start), date.fromisoformat(end))
        args = request.args.copy().to_dict(flat=False)
        args["start"] = ps.isoformat()
        args["end"] = pe.isoformat()
        prev = summarize(filtered_query(args))
        for key, val in summary.items():
            old = prev.get(key, 0)
            diff = round(val - old, 2)
            comparison[key] = {"previous": old, "diff": diff, "changeRate": 0 if old == 0 else round(diff / old * 100, 1)}
    return jsonify({"summary": summary, "comparison": comparison, "alerts": etc_consecutive_alerts(request.args)})


def etc_consecutive_alerts(args) -> list[dict]:
    threshold = 0.5
    setting = AppSetting.query.get("etc_consecutive_threshold_count")
    try:
        consecutive_count = max(1, int(float(setting.value if setting else "3")))
    except (TypeError, ValueError):
        consecutive_count = 3
    rows = filtered_query(args).order_by(ProcessMaster.type, ProcessMaster.line, ProcessMaster.processName, DailyMeasurement.measurementDate).all()
    alerts = []
    grouped: dict[int, list[DailyMeasurement]] = {}
    for row in rows:
        grouped.setdefault(row.processId, []).append(row)

    def append_alert(streak: list[DailyMeasurement]) -> None:
        if len(streak) < consecutive_count:
            return
        blank_rows = [item for item in streak if not (item.note or "").strip()]
        if not blank_rows:
            return
        first = streak[0]
        alerts.append(
            {
                "processId": first.processId,
                "type": first.process.type,
                "line": first.process.line,
                "processName": first.process.processName,
                "status": first.process.status,
                "threshold": threshold,
                "requiredCount": consecutive_count,
                "streakDates": [item.measurementDate.isoformat() for item in streak],
                "blankNoteDates": [item.measurementDate.isoformat() for item in blank_rows],
            }
        )

    for process_rows in grouped.values():
        streak: list[DailyMeasurement] = []
        for row in process_rows:
            if rate(row.etcCount, row.totalCount) >= threshold:
                streak.append(row)
            else:
                append_alert(streak)
                streak = []
        append_alert(streak)
    return alerts


@bp.get("/api/trends")
@login_required
def trends():
    rows = filtered_query(request.args).order_by(DailyMeasurement.measurementDate).all()
    by_date: dict[str, dict] = {}
    for row in rows:
        key = row.measurementDate.isoformat()
        item = by_date.setdefault(key, {"date": key, "totalCount": 0, "ngCount": 0, "etcCount": 0, "clusterValues": [], "notes": []})
        item["totalCount"] += row.totalCount
        item["ngCount"] += row.ngCount
        item["etcCount"] += row.etcCount
        item["clusterValues"].append(row.clusterCount)
        if row.note:
            item["notes"].append(row.note)
    data = []
    for item in by_date.values():
        total = item["totalCount"]
        data.append(
            {
                "date": item["date"],
                "totalCount": total,
                "ngCount": item["ngCount"],
                "ngRate": rate(item["ngCount"], total),
                "etcCount": item["etcCount"],
                "etcRate": rate(item["etcCount"], total),
                "clusterCount": round(sum(item["clusterValues"]) / len(item["clusterValues"]), 1) if item["clusterValues"] else 0,
                "note": ", ".join(sorted(set(item["notes"]))),
            }
        )
    return jsonify(data)


@bp.get("/api/compare/process")
@login_required
def compare_process():
    rows = filtered_query(request.args).all()
    grouped: dict[int, dict] = {}
    for row in rows:
        item = grouped.setdefault(row.processId, {"processId": row.processId, "line": row.process.line, "type": row.process.type, "processName": row.process.processName, "totalCount": 0, "ngCount": 0, "etcCount": 0, "clusters": []})
        item["totalCount"] += row.totalCount
        item["ngCount"] += row.ngCount
        item["etcCount"] += row.etcCount
        item["clusters"].append(row.clusterCount)
    data = []
    for item in grouped.values():
        total = item["totalCount"]
        item["ngRate"] = rate(item["ngCount"], total)
        item["etcRate"] = rate(item["etcCount"], total)
        item["clusterCount"] = round(sum(item["clusters"]) / len(item["clusters"]), 1) if item["clusters"] else 0
        item.pop("clusters")
        data.append(item)
    return jsonify(sorted(data, key=lambda x: x["ngRate"], reverse=True))


@bp.get("/api/compare/line")
@login_required
def compare_line():
    rows = filtered_query(request.args).all()
    grouped: dict[str, dict] = {}
    for row in rows:
        item = grouped.setdefault(row.process.line, {"line": row.process.line, "totalCount": 0, "ngCount": 0, "etcCount": 0})
        item["totalCount"] += row.totalCount
        item["ngCount"] += row.ngCount
        item["etcCount"] += row.etcCount
    for item in grouped.values():
        item["ngRate"] = rate(item["ngCount"], item["totalCount"])
        item["etcRate"] = rate(item["etcCount"], item["totalCount"])
    return jsonify(list(grouped.values()))


@bp.get("/api/measurements")
@login_required
def measurements():
    rows = filtered_query(request.args).order_by(desc(DailyMeasurement.measurementDate), ProcessMaster.line).all()
    return jsonify([measurement_dict(row) for row in rows])


@bp.post("/api/measurements")
@login_required
@admin_required
def create_measurement():
    user = current_user()
    data = request.json or {}
    total = to_int(data.get("totalCount"), "총체결")
    ng = to_int(data.get("ngCount"), "NG")
    etc = to_int(data.get("etcCount"), "Etc")
    validate_measurement(total, ng, etc)
    proc = ProcessMaster.query.get_or_404(data.get("processId"))
    measurement_date = date.fromisoformat(data["measurementDate"])
    if DailyMeasurement.query.filter_by(processId=proc.id, measurementDate=measurement_date).first():
        return jsonify({"error": "동일 공정과 동일 날짜의 데이터가 이미 있습니다", "duplicate": True}), 409
    item = DailyMeasurement(
        processId=proc.id,
        measurementDate=measurement_date,
        totalCount=total,
        ngCount=ng,
        etcCount=etc,
        clusterCount=to_int(data.get("clusterCount"), "Cluster"),
        note=data.get("note", ""),
        createdBy=user.id,
        updatedBy=user.id,
    )
    apply_extra_counts(item, data)
    db.session.add(item)
    try:
        db.session.flush()
        add_audit(user, "생성", "DailyMeasurement", item.id, None, measurement_dict(item))
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({"error": "동일 공정과 동일 날짜의 데이터가 이미 있습니다", "duplicate": True}), 409
    return jsonify(measurement_dict(item)), 201


@bp.put("/api/measurements/<int:item_id>")
@login_required
@admin_required
def update_measurement(item_id: int):
    user = current_user()
    item = DailyMeasurement.query.get_or_404(item_id)
    before = measurement_dict(item)
    data = request.json or {}
    total = to_int(data.get("totalCount", item.totalCount), "총체결")
    ng = to_int(data.get("ngCount", item.ngCount), "NG")
    etc = to_int(data.get("etcCount", item.etcCount), "Etc")
    validate_measurement(total, ng, etc)
    item.totalCount = total
    item.ngCount = ng
    item.etcCount = etc
    item.clusterCount = to_int(data.get("clusterCount", item.clusterCount), "Cluster")
    item.note = data.get("note", item.note)
    item.updatedBy = user.id
    apply_extra_counts(item, data)
    add_audit(user, "수정", "DailyMeasurement", item.id, before, measurement_dict(item))
    db.session.commit()
    return jsonify(measurement_dict(item))


@bp.delete("/api/measurements/<int:item_id>")
@login_required
@admin_required
def delete_measurement(item_id: int):
    user = current_user()
    item = DailyMeasurement.query.get_or_404(item_id)
    before = measurement_dict(item)
    add_audit(user, "삭제", "DailyMeasurement", item.id, before, None)
    db.session.delete(item)
    db.session.commit()
    return jsonify({"ok": True})


@bp.post("/api/bulk-measurements")
@login_required
@admin_required
def bulk_measurements():
    return jsonify(save_bulk_rows((request.json or {}).get("rows", [])))


@bp.post("/api/bulk-text")
@login_required
@admin_required
def bulk_text():
    data = request.json or {}
    try:
        process_id = int(data.get("processId"))
    except (TypeError, ValueError):
        return jsonify({"error": "공정을 선택하세요"}), 400
    if not ProcessMaster.query.get(process_id):
        return jsonify({"error": "공정을 선택하세요"}), 400
    return jsonify(save_bulk_rows(parse_bulk_text(data.get("text", ""), process_id)))


def save_bulk_rows(rows: list[dict]) -> dict:
    user = current_user()
    created = updated = failed = 0
    errors = []
    for row in rows:
        try:
            proc = ProcessMaster.query.get(row.get("processId"))
            if not proc:
                raise ValueError("공정이 없습니다")
            total = to_int(row.get("totalCount"), "총체결")
            ng = to_int(row.get("ngCount"), "NG")
            etc = to_int(row.get("etcCount"), "Etc")
            validate_measurement(total, ng, etc)
            measurement_date = date.fromisoformat(row["measurementDate"])
            item = DailyMeasurement.query.filter_by(processId=proc.id, measurementDate=measurement_date).first()
            if item:
                item.totalCount = total
                item.ngCount = ng
                item.etcCount = etc
                item.clusterCount = to_int(row.get("clusterCount"), "Cluster")
                item.note = row.get("note", "")
                item.updatedBy = user.id
                apply_extra_counts(item, row)
                updated += 1
            else:
                item = DailyMeasurement(
                    processId=proc.id,
                    measurementDate=measurement_date,
                    totalCount=total,
                    ngCount=ng,
                    etcCount=etc,
                    clusterCount=to_int(row.get("clusterCount"), "Cluster"),
                    note=row.get("note", ""),
                    createdBy=user.id,
                    updatedBy=user.id,
                )
                apply_extra_counts(item, row)
                db.session.add(item)
                created += 1
        except Exception as exc:
            failed += 1
            errors.append({"row": row, "reason": str(exc)})
    add_audit(user, "생성", "BulkMeasurement", None, None, {"created": created, "updated": updated, "failed": failed})
    db.session.commit()
    return {"created": created, "updated": updated, "failed": failed, "errors": errors}


def parse_bulk_text(text: str, process_id: int) -> list[dict]:
    lines = [line.rstrip("\r") for line in text.splitlines() if line.strip()]
    if not lines:
        raise ValueError("붙여넣은 데이터가 없습니다")
    matrix = [split_bulk_line(line) for line in lines]
    date_columns = [(idx, normalize_bulk_date(cell)) for idx, cell in enumerate(matrix[0]) if normalize_bulk_date(cell)]
    if not date_columns:
        raise ValueError("첫 행에서 날짜를 찾지 못했습니다")
    first_date_index = date_columns[0][0]
    dates = [date_value for _, date_value in date_columns]
    rows = [{"processId": process_id, "measurementDate": d} for d in dates]
    mapping = {
        "총체결": "totalCount",
        "총 체결": "totalCount",
        "NG": "ngCount",
        "진성": "trueDefectCount",
        "미검": "missedInspectionCount",
        "과검": "overInspectionCount",
        "Cluster": "clusterCount",
        "Cluster(Upper)": "clusterUpperCount",
        "Cluster(Lower(Near))": "clusterLowerNearCount",
        "Cluster(Lower(Far))": "clusterLowerFarCount",
        "Class": "classCount",
        "ETC": "etcCount",
        "Etc": "etcCount",
        "비고": "note",
    }
    for parts in matrix[1:]:
        label, label_width = split_bulk_label(parts, mapping)
        field = mapping.get(label)
        if not field:
            continue
        for row_index, (date_index, _) in enumerate(date_columns):
            value_index = date_index if first_date_index > 0 else date_index + label_width
            rows[row_index][field] = parts[value_index] if value_index < len(parts) else ""
    for row in rows:
        upper = to_int(row.get("clusterUpperCount", 0), "Cluster(Upper)")
        near = to_int(row.get("clusterLowerNearCount", 0), "Cluster(Lower(Near))")
        far = to_int(row.get("clusterLowerFarCount", 0), "Cluster(Lower(Far))")
        row["clusterCount"] = row.get("clusterCount") or upper + near + far
        row.setdefault("totalCount", 0)
        row.setdefault("ngCount", 0)
        row.setdefault("etcCount", 0)
        row.setdefault("note", "")
    return rows


def split_bulk_line(line: str) -> list[str]:
    if "\t" in line:
        return [cell.strip() for cell in line.split("\t")]
    return line.split()


def split_bulk_label(parts: list[str], mapping: dict[str, str]) -> tuple[str, int]:
    if len(parts) >= 2:
        two_word_label = f"{parts[0]} {parts[1]}"
        if two_word_label in mapping:
            return two_word_label, 2
    return parts[0], 1


def looks_like_date(value: str) -> bool:
    return normalize_bulk_date(value) is not None


def normalize_bulk_date(value: str) -> str | None:
    value = str(value or "").strip()
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        pass
    if len(value) == 5 and value[2] == "-":
        try:
            month, day = [int(part) for part in value.split("-")]
            parsed = date(datetime.now(KST).year, month, day)
            return parsed.isoformat()
        except (TypeError, ValueError):
            return None
    return None


def apply_extra_counts(item: DailyMeasurement, data: dict) -> None:
    for field, label in {
        "trueDefectCount": "진성",
        "missedInspectionCount": "미검",
        "overInspectionCount": "과검",
        "clusterUpperCount": "Cluster(Upper)",
        "clusterLowerNearCount": "Cluster(Lower(Near))",
        "clusterLowerFarCount": "Cluster(Lower(Far))",
        "classCount": "Class",
    }.items():
        if field in data:
            setattr(item, field, to_int(data.get(field), label))


@bp.get("/api/processes")
@login_required
def processes():
    return jsonify([{"id": p.id, "line": p.line, "type": p.type, "processName": p.processName, "status": p.status, "isActive": p.isActive} for p in ProcessMaster.query.order_by(ProcessMaster.line, ProcessMaster.type, ProcessMaster.processName).all()])


@bp.post("/api/processes")
@login_required
@admin_required
def create_process():
    data = request.json or {}
    proc = ProcessMaster(line=data["line"].strip(), type=data["type"].strip(), processName=data["processName"].strip(), status=(data.get("status") or "").strip())
    db.session.add(proc)
    db.session.flush()
    add_audit(current_user(), "생성", "ProcessMaster", proc.id, None, data)
    db.session.commit()
    return jsonify({"id": proc.id}), 201


@bp.put("/api/processes/<int:proc_id>")
@login_required
@admin_required
def update_process(proc_id: int):
    proc = ProcessMaster.query.get_or_404(proc_id)
    before = {"line": proc.line, "type": proc.type, "processName": proc.processName, "status": proc.status, "isActive": proc.isActive}
    data = request.json or {}
    for attr in ["line", "type", "processName", "status", "isActive"]:
        if attr in data:
            setattr(proc, attr, data[attr])
    add_audit(current_user(), "수정", "ProcessMaster", proc.id, before, data)
    db.session.commit()
    return jsonify({"ok": True})


@bp.delete("/api/processes/<int:proc_id>")
@login_required
@admin_required
def delete_process(proc_id: int):
    proc = ProcessMaster.query.get_or_404(proc_id)
    before = {"line": proc.line, "type": proc.type, "processName": proc.processName, "status": proc.status, "isActive": proc.isActive}
    measurements = DailyMeasurement.query.filter_by(processId=proc.id).all()
    has_data = len(measurements) > 0
    if has_data and proc.isActive:
        proc.isActive = False
        add_audit(current_user(), "삭제", "ProcessMaster", proc.id, before, {"isActive": False, "mode": "deactivate"})
        db.session.commit()
        return jsonify({"ok": True, "mode": "deactivated"})
    if has_data:
        deleted_measurements = len(measurements)
        for measurement in measurements:
            add_audit(current_user(), "삭제", "DailyMeasurement", measurement.id, measurement_dict(measurement), None)
            db.session.delete(measurement)
        add_audit(current_user(), "삭제", "ProcessMaster", proc.id, before, {"mode": "deleted_with_measurements", "deletedMeasurements": deleted_measurements})
        db.session.delete(proc)
        db.session.commit()
        return jsonify({"ok": True, "mode": "deleted", "deletedMeasurements": deleted_measurements})
    add_audit(current_user(), "삭제", "ProcessMaster", proc.id, before, None)
    db.session.delete(proc)
    db.session.commit()
    return jsonify({"ok": True, "mode": "deleted"})


@bp.get("/api/users")
@login_required
@admin_required
def users():
    return jsonify([{"id": u.id, "username": u.username, "name": u.name, "role": u.role, "isActive": u.isActive} for u in User.query.order_by(User.username).all()])


@bp.post("/api/users")
@login_required
@admin_required
def create_user():
    data = request.json or {}
    user = User(username=data["username"], name=data.get("name") or data["username"], role=data.get("role", "viewer"), isActive=True)
    user.set_password(data["password"])
    db.session.add(user)
    db.session.commit()
    return jsonify({"id": user.id}), 201


@bp.put("/api/users/<int:user_id>")
@login_required
@admin_required
def update_user(user_id: int):
    user = User.query.get_or_404(user_id)
    data = request.json or {}
    for attr in ["name", "role", "isActive"]:
        if attr in data:
            setattr(user, attr, data[attr])
    if data.get("password"):
        user.set_password(data["password"])
    db.session.commit()
    return jsonify({"ok": True})


@bp.post("/api/import")
@login_required
@admin_required
def import_file():
    file = request.files["file"]
    mode = request.form.get("duplicateMode", "overwrite")
    return jsonify(import_rows(read_upload_rows(file), mode, current_user()))


@bp.get("/api/export")
@login_required
def export_data():
    rows = [measurement_dict(r) for r in filtered_query(request.args).order_by(DailyMeasurement.measurementDate).all()]
    fmt = request.args.get("format", "xlsx")
    return dataframe_response(rows, "quality_measurements", "xlsx" if fmt == "xlsx" else "csv")


@bp.get("/api/audit-logs")
@login_required
@admin_required
def audit_logs():
    rows = AuditLog.query.order_by(desc(AuditLog.actionAt)).limit(500).all()
    return jsonify([{"id": r.id, "actionAt": r.actionAt.astimezone(KST).strftime("%Y-%m-%d %H:%M:%S"), "username": r.username, "actionType": r.actionType, "targetType": r.targetType, "targetId": r.targetId, "beforeValue": r.beforeValue, "afterValue": r.afterValue} for r in rows])


@bp.get("/api/missing")
@login_required
def missing():
    start = date.fromisoformat(request.args.get("start", date.today().isoformat()))
    end = date.fromisoformat(request.args.get("end", date.today().isoformat()))
    dates = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    rows = []
    for proc in ProcessMaster.query.filter_by(isActive=True).all():
        existing = {m.measurementDate for m in DailyMeasurement.query.filter(DailyMeasurement.processId == proc.id, DailyMeasurement.measurementDate.between(start, end)).all()}
        missed = [d for d in dates if d not in existing]
        last = DailyMeasurement.query.filter_by(processId=proc.id).order_by(desc(DailyMeasurement.measurementDate)).first()
        if missed:
            rows.append({"processId": proc.id, "line": proc.line, "type": proc.type, "processName": proc.processName, "missingCount": len(missed), "lastInputDate": last.measurementDate.isoformat() if last else "-", "missingDates": [d.isoformat() for d in missed]})
    return jsonify(rows)


@bp.post("/api/settings")
@login_required
@admin_required
def update_settings():
    for key, value in (request.json or {}).items():
        setting = AppSetting.query.get(key) or AppSetting(key=key)
        setting.value = str(value)
        db.session.add(setting)
    db.session.commit()
    return jsonify({"ok": True})

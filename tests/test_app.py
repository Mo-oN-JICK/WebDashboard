from __future__ import annotations

from datetime import date

import pytest

from app import create_app, db
from app.models import DailyMeasurement, ProcessMaster, User
from app.services import import_rows, rate, validate_measurement


@pytest.fixture()
def app():
    app = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:", "SECRET_KEY": "test"})
    with app.app_context():
        yield app


@pytest.fixture()
def client(app):
    return app.test_client()


def login(client, username="admin", password="admin1234"):
    return client.post("/login", data={"username": username, "password": password}, follow_redirects=True)


def test_rate_calculation():
    assert rate(15, 1013) == 1.48
    assert rate(2, 5580) == 0.04
    assert rate(3, 0) == 0


def test_invalid_counts_are_blocked():
    with pytest.raises(ValueError):
        validate_measurement(10, 11, 0)
    with pytest.raises(ValueError):
        validate_measurement(10, 0, 11)


def test_duplicate_process_date_is_blocked(client):
    login(client)
    proc_id = ProcessMaster.query.filter_by(processName="RAJ Middle-Screw").first().id
    payload = {"processId": proc_id, "measurementDate": "2026-07-20", "totalCount": 1, "ngCount": 0, "etcCount": 0, "clusterCount": 1}
    res = client.post("/api/measurements", json=payload)
    assert res.status_code == 409


def test_viewer_cannot_modify(client):
    login(client, "viewer", "viewer1234")
    proc_id = ProcessMaster.query.first().id
    res = client.post("/api/measurements", json={"processId": proc_id, "measurementDate": "2026-07-22", "totalCount": 1, "ngCount": 0, "etcCount": 0, "clusterCount": 1})
    assert res.status_code == 403


def test_filter_query(client):
    login(client)
    res = client.get("/api/measurements?line=RA&start=2026-07-20&end=2026-07-21")
    data = res.get_json()
    assert res.status_code == 200
    assert len(data) >= 2
    assert all(r["line"] == "RA" for r in data)


def test_period_comparison(client):
    login(client)
    res = client.get("/api/dashboard?start=2026-07-21&end=2026-07-21")
    data = res.get_json()
    assert data["summary"]["totalCount"] == 5580
    assert "totalCount" in data["comparison"]


def test_excel_import_validation(app):
    user = User.query.filter_by(username="admin").first()
    rows = [
        {
            "날짜": "2026-07-22",
            "Line": "RA",
            "Type": "FAS2.0",
            "Process": "RAJ Middle-Screw",
            "총체결": 10,
            "NG": 3,
            "Etc": 1,
            "Cluster": 115,
            "비고": "설비점검",
        },
        {
            "날짜": "bad-date",
            "Line": "RA",
            "Type": "FAS2.0",
            "Process": "RAJ Middle-Screw",
            "총체결": "x",
            "NG": 0,
            "Etc": 0,
            "Cluster": 0,
        },
    ]
    result = import_rows(rows, "overwrite", user)
    assert result["created"] == 1
    assert result["failed"] == 1


def test_bulk_text_input_stores_extra_counts(client):
    login(client)
    proc_id = ProcessMaster.query.filter_by(processName="RAJ Middle-Screw").first().id
    text = """\t2026-07-24\t2026-07-25
총체결\t100\t200
NG\t1\t2
진성\t3\t4
미검\t5\t6
과검\t7\t8
Cluster(Upper)\t9\t10
Cluster(Lower(Near))\t11\t12
Cluster(Lower(Far))\t13\t14
Class\t15\t16
ETC\t17\t18"""
    res = client.post("/api/bulk-text", json={"processId": proc_id, "text": text})
    assert res.status_code == 200
    data = res.get_json()
    assert data["failed"] == 0
    row = DailyMeasurement.query.filter_by(processId=proc_id, measurementDate=date(2026, 7, 24)).first()
    assert row.totalCount == 100
    assert row.etcCount == 17
    assert row.trueDefectCount == 3
    assert row.clusterCount == 33
    assert row.clusterLowerFarCount == 13


def test_bulk_text_accepts_spaced_total_and_single_cluster(client):
    login(client)
    proc_id = ProcessMaster.query.filter_by(processName="RAJ Middle-Screw").first().id
    text = """\t2026-07-26\t2026-07-27
총 체결\t300\t400
NG\t3\t4
Cluster\t31\t41
ETC\t5\t6"""
    res = client.post("/api/bulk-text", json={"processId": proc_id, "text": text})
    assert res.status_code == 200
    assert res.get_json()["failed"] == 0
    row = DailyMeasurement.query.filter_by(processId=proc_id, measurementDate=date(2026, 7, 26)).first()
    assert row.totalCount == 300
    assert row.etcCount == 5
    assert row.clusterCount == 31


def test_process_create_defaults_blank_status_and_delete_without_data(client):
    login(client)
    res = client.post("/api/processes", json={"type": "FAS3.0", "line": "RB", "processName": "No Data Process"})
    assert res.status_code == 201
    proc_id = res.get_json()["id"]
    proc = ProcessMaster.query.get(proc_id)
    assert proc.status == ""
    res = client.delete(f"/api/processes/{proc_id}")
    assert res.status_code == 200
    assert res.get_json()["mode"] == "deleted"
    assert ProcessMaster.query.get(proc_id) is None


def test_process_delete_with_data_deactivates(client):
    login(client)
    proc = ProcessMaster.query.filter_by(processName="RAJ Middle-Screw").first()
    res = client.delete(f"/api/processes/{proc.id}")
    assert res.status_code == 200
    assert res.get_json()["mode"] == "deactivated"
    assert ProcessMaster.query.get(proc.id).isActive is False


def test_inactive_process_delete_removes_data_and_process(client):
    login(client)
    proc = ProcessMaster.query.filter_by(processName="RAJ Middle-Screw").first()
    proc_id = proc.id
    first = client.delete(f"/api/processes/{proc_id}")
    assert first.get_json()["mode"] == "deactivated"
    second = client.delete(f"/api/processes/{proc_id}")
    assert second.status_code == 200
    assert second.get_json()["mode"] == "deleted"
    assert second.get_json()["deletedMeasurements"] >= 1
    assert DailyMeasurement.query.filter_by(processId=proc_id).count() == 0
    assert ProcessMaster.query.get(proc_id) is None

from __future__ import annotations

import os
from datetime import timedelta

from dotenv import load_dotenv
from flask import Flask
from flask_migrate import Migrate
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
migrate = Migrate()


def create_app(test_config: dict | None = None) -> Flask:
    load_dotenv()
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.getenv("SECRET_KEY", "dev-secret"),
        SQLALCHEMY_DATABASE_URI=os.getenv("DATABASE_URL", "sqlite:///quality_dashboard.db"),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        MAX_CONTENT_LENGTH=25 * 1024 * 1024,
    )
    if test_config:
        app.config.update(test_config)

    db.init_app(app)
    migrate.init_app(app, db)

    from .routes import bp

    app.register_blueprint(bp)
    with app.app_context():
        from . import models  # noqa: F401

        db.create_all()
        ensure_sqlite_schema()
        from .seed import seed_defaults

        seed_defaults()
    return app


def ensure_sqlite_schema() -> None:
    engine_name = db.engine.url.get_backend_name()
    if engine_name != "sqlite":
        return
    required = {
        "trueDefectCount": "INTEGER NOT NULL DEFAULT 0",
        "missedInspectionCount": "INTEGER NOT NULL DEFAULT 0",
        "overInspectionCount": "INTEGER NOT NULL DEFAULT 0",
        "clusterUpperCount": "INTEGER NOT NULL DEFAULT 0",
        "clusterLowerNearCount": "INTEGER NOT NULL DEFAULT 0",
        "clusterLowerFarCount": "INTEGER NOT NULL DEFAULT 0",
        "classCount": "INTEGER NOT NULL DEFAULT 0",
    }
    with db.engine.connect() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(daily_measurement)").fetchall()}
        for name, ddl in required.items():
            if name not in existing:
                conn.exec_driver_sql(f"ALTER TABLE daily_measurement ADD COLUMN {name} {ddl}")
        conn.exec_driver_sql(
            """
            DELETE FROM daily_measurement
            WHERE id NOT IN (
                SELECT MAX(id)
                FROM daily_measurement
                GROUP BY processId, measurementDate
            )
            """
        )
        conn.exec_driver_sql(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_measurement_process_date_idx
            ON daily_measurement(processId, measurementDate)
            """
        )
        conn.commit()

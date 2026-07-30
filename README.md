# 생산·품질 데이터 웹 대시보드

Excel 형태의 생산·품질 데이터를 웹에서 등록, 수정, 조회, 분석하는 Flask 기반 로컬 실행형 대시보드입니다. 데이터는 기본적으로 `instance/quality_dashboard.db` SQLite 파일에 저장되므로 브라우저를 종료하거나 PC를 재부팅해도 유지됩니다.

## 주요 기능

- 세션 기반 로그인, 관리자/조회자 권한 분리
- 공정 마스터 관리, 활성/비활성 처리
- 날짜별 측정 데이터 등록, 수정, 삭제
- 텍스트 기반 대량 입력
- NG율, Etc율 자동 계산
- 동일 공정·동일 날짜 중복 등록 방지
- 날짜, Line, Type, Process, 현황, 구분 필터
- 날짜별 추이 그래프와 PNG 저장
- 날짜별 핵심 데이터 표
- Excel/CSV 가져오기 및 내보내기
- 변경 이력 Audit Log
- 설정 기준값 기반 경고 표시
- 기본 다크 모드, 반응형 UI

## 설치

Python 3.12 이상 권장입니다.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

## 환경변수

`.env`에서 초기 관리자 계정을 바꿀 수 있습니다.

```env
SECRET_KEY=change-me-in-production
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin1234
ADMIN_NAME=관리자
```

기본 DB는 SQLite 파일입니다. 별도 DB 서버 없이 `instance/quality_dashboard.db`가 자동 생성됩니다.

## 실행

```powershell
.\.venv\Scripts\Activate.ps1
python run.py
```

브라우저에서 접속합니다.

```text
http://127.0.0.1:8000
```

초기 계정:

- 관리자: `admin / admin1234`
- 조회자: `viewer / viewer1234`

## 다른 PC로 옮겨 구축하기

프로젝트 폴더를 다른 PC로 복사하기 전에 아래 항목은 제거해도 됩니다. 이 항목들은 PC마다 새로 생성되는 실행환경 또는 임시 파일입니다.

```text
.venv/
__pycache__/
.pytest_cache/
.env
```

새 PC에서 `.env.example`을 다시 복사해 `.env`를 만들면 됩니다.

```powershell
Copy-Item .env.example .env
```

### 기존 데이터도 함께 옮길 경우

아래 파일이 실제 SQLite 데이터입니다. 기존 데이터를 유지하려면 이 파일을 함께 복사하세요.

```text
instance/quality_dashboard.db
```

또는 기존 PC에서 백업을 만든 뒤 백업 파일을 새 PC로 옮길 수 있습니다.

```powershell
.\scripts\backup.ps1
```

새 PC에서 복구:

```powershell
.\scripts\restore.ps1 -BackupFile .\backups\quality_dashboard_YYYYMMDD_HHMMSS.db
```

### 새 데이터로 시작할 경우

아래 폴더는 복사하지 않거나 삭제해도 됩니다. 앱을 다시 실행하면 필요한 폴더와 DB가 새로 생성됩니다.

```text
instance/
backups/
uploads/
exports/
```

### 새 PC에서 실행

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python run.py
```

실행한 PC에서 접속:

```text
http://127.0.0.1:8000
```

같은 네트워크의 다른 PC나 태블릿에서 접속하려면 실행 PC의 IP 주소를 사용합니다.

```text
http://실행PC_IP주소:8000
```

예:

```text
http://192.168.0.25:8000
```

Windows 방화벽이 연결을 막는 경우, Python 또는 8000번 포트의 사설 네트워크 접근을 허용해야 합니다.

## 데이터 초기화

최초 실행 시 테이블, 초기 관리자, 조회자, 기본 현황, 메모 템플릿, 샘플 공정과 샘플 데이터가 자동 생성됩니다.

완전히 초기화하려면 서버를 종료한 뒤 아래 파일을 삭제하고 다시 실행합니다.

```text
instance/quality_dashboard.db
```

## 백업

```powershell
.\scripts\backup.ps1
```

백업 파일은 `backups/quality_dashboard_YYYYMMDD_HHMMSS.db`로 저장됩니다.

## 복구

서버를 종료한 뒤 실행하세요.

```powershell
.\scripts\restore.ps1 -BackupFile .\backups\quality_dashboard_20260730_120000.db
```

## 텍스트 대량 입력 형식

데이터 입력 화면의 텍스트 대량 입력에 아래와 같은 형태를 붙여넣을 수 있습니다.

```text
	2026-07-20	2026-07-21
총체결	1013	5580
NG	15	28
진성	0	0
미검	0	0
과검	0	0
Cluster(Upper)	115	115
Cluster(Lower(Near))	0	0
Cluster(Lower(Far))	0	0
Class	0	0
ETC	0	2
```

`진성`, `미검`, `과검`, `Cluster(Upper)`, `Cluster(Lower(Near))`, `Cluster(Lower(Far))`, `Class`는 추후 활용을 위해 DB에 저장됩니다. 현재 메인 대시보드는 `날짜`, `총체결`, `NG`, `Etc`, `Etc%`, `Cluster`, `비고` 중심으로 표시합니다.

## Excel/CSV 가져오기 형식

Long Format:

| 날짜 | Line | Type | Process | 총체결 | NG | Etc | Cluster | 비고 |
|---|---|---|---|---:|---:|---:|---:|---|

Wide Format:

| Line | Type | Process | 현황 | 구분 | 2026-07-20 | 2026-07-21 |
|---|---|---|---|---|---:|---:|

Wide Format의 `구분`은 `총체결`, `NG`, `Etc`, `Etc%`, `Cluster`, `비고`를 지원합니다. 비율 항목은 저장하지 않고 서버에서 자동 계산합니다.

## 테스트

```powershell
pytest
```

테스트 범위:

- NG율, Etc율 계산
- 총체결 0인 경우 비율 0 처리
- 중복 등록 방지
- 조회자 수정 차단
- 필터 조회
- 기간 비교
- Excel 가져오기 검증
- 잘못된 숫자 및 날짜 차단
- 텍스트 대량 입력과 보관용 컬럼 저장

## 운영 참고

소규모 로컬 사용은 `python run.py`로 실행해도 됩니다. 계속 켜둘 PC라면 `instance/quality_dashboard.db`를 정기적으로 백업하세요.

Windows에서 운영용 WSGI 서버를 붙이려면 Waitress 같은 서버를 추가로 사용할 수 있습니다.

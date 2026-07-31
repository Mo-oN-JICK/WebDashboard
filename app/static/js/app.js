const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

const state = {
  options: null,
  rows: [],
  selectedMeasurements: new Set(),
  selectedProcesses: new Set(),
  alerts: [],
  alertModalGroups: [],
  trends: [],
  processCompare: [],
  page: 1,
  pageSize: 20,
  pivotDesc: false,
  activeView: "dashboard",
  datePickerMonth: null,
  pendingRangeStart: "",
  charts: {},
};

const isAdmin = window.APP_USER.role === "admin";
const labels = {
  totalCount: "총체결",
  ngCount: "NG",
  ngRate: "NG율",
  etcCount: "분류실패",
  etcRate: "분류실패%",
  avgCluster: "평균 Cluster",
  processCount: "등록 공정 수",
  dateCount: "등록 날짜 수",
};
const metricLabels = {
  totalCount: "총체결",
  ngCount: "NG",
  ngRate: "NG%",
  etcCount: "분류실패",
  etcRate: "분류실패%",
  ngEtcStack: "NG+분류실패",
  clusterCount: "Cluster",
};
const badUp = new Set(["ngCount", "ngRate", "etcCount", "etcRate"]);
const defaultStatuses = ["판정 안정", "예외 초과", "설비 점검", "비가동"];
const statusAliases = {
  "안정화 상태": "판정 안정",
  "점검 중": "설비 점검",
};

function fmt(value) {
  return Number(value ?? 0).toLocaleString("ko-KR");
}

function pct(value) {
  return `${Number(value ?? 0).toFixed(2)}%`;
}

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("#toast").append(el);
  setTimeout(() => el.remove(), 2600);
}

function acknowledgedAlerts() {
  try {
    return new Set(JSON.parse(localStorage.getItem("qualityDashboardAcknowledgedAlerts") || "[]"));
  } catch {
    return new Set();
  }
}

function saveAcknowledgedAlerts(ids) {
  localStorage.setItem("qualityDashboardAcknowledgedAlerts", JSON.stringify([...ids]));
}

function activeAlerts(alerts) {
  const acknowledged = acknowledgedAlerts();
  return alerts.filter((alert) => !acknowledged.has(alert.id));
}

function noteDate(row, warning = false) {
  const note = String(row.note || "").trim();
  if (!note && warning) return `<span class="note-date empty-alert" title="분류실패% 연속 초과, 비고 공란">${esc(row.date)}</span>`;
  if (!note) return esc(row.date);
  const warningClass = warning ? " alert-note" : "";
  return `<button type="button" class="note-date has-note${warningClass}" data-note="${esc(note)}" onmouseenter="showNoteTooltip(event, this)" onmousemove="moveNoteTooltip(event)" onmouseleave="hideNoteTooltip()" onfocus="showNoteTooltip(event, this)" onblur="hideNoteTooltip()" onclick="showNote('${encodeURIComponent(note)}')">${esc(row.date)}</button>`;
}

function showNoteTooltipText(event, note) {
  let tooltip = $("#noteTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "noteTooltip";
    tooltip.className = "note-tooltip";
    document.body.append(tooltip);
  }
  tooltip.textContent = note || "";
  tooltip.classList.add("active");
  moveNoteTooltip(event);
}

window.showNoteTooltip = (event, target) => {
  showNoteTooltipText(event, target.dataset.note || "");
};

window.moveNoteTooltip = (event) => {
  const tooltip = $("#noteTooltip");
  if (!tooltip) return;
  const margin = 14;
  const width = Math.min(320, window.innerWidth - 24);
  tooltip.style.maxWidth = `${width}px`;
  const left = Math.min(event.clientX + margin, window.innerWidth - width - 12);
  tooltip.style.left = `${Math.max(12, left)}px`;
  tooltip.style.top = `${Math.min(event.clientY + margin, window.innerHeight - tooltip.offsetHeight - 12)}px`;
};

window.hideNoteTooltip = () => {
  $("#noteTooltip")?.classList.remove("active");
};

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  if (!res.ok) {
    let error = {};
    try {
      error = await res.json();
    } catch {}
    throw new Error(error.error || "서버 오류");
  }
  return res.json();
}

function checkedValues(filterName) {
  return $$(`input[name="${filterName}Filter"]:checked`).map((input) => input.value).filter(Boolean);
}

function selectedMetrics() {
  return $$("#metricFilter input:checked").map((input) => input.value);
}

function updateMetricCount() {
  const count = selectedMetrics().length;
  const target = $("#metricCount");
  if (target) target.textContent = count ? `${count}개` : "없음";
}

function dataDateSet() {
  return new Set(state.options?.dataDates || []);
}

function isDataDate(value) {
  return dataDateSet().has(value);
}

function dataDateBounds() {
  const dates = [...dataDateSet()].sort();
  return { min: dates[0] || "", max: dates[dates.length - 1] || "" };
}

function isSelectableCalendarDate(value) {
  const { min, max } = dataDateBounds();
  if (!min || !max) return true;
  return value >= min && value <= max;
}

function datesBetween(start, end) {
  if (!start || !end) return [];
  const result = [];
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  while (cursor <= last) {
    result.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function normalizeTrendRows(rows) {
  const start = $("#start").value;
  const end = $("#end").value;
  if (!start || !end) return rows;
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return datesBetween(start, end).map((date) => {
    const row = byDate.get(date);
    if (row) return { ...row, hasData: true };
    return {
      date,
      totalCount: 0,
      ngCount: 0,
      ngRate: 0,
      etcCount: 0,
      etcRate: 0,
      clusterCount: 0,
      note: "",
      hasData: false,
    };
  });
}

function updateDateRangeLabel() {
  const start = $("#start").value;
  const end = $("#end").value;
  const label = $("#dateRangeLabel");
  if (!label) return;
  if (start && end) label.textContent = start === end ? start : `${start} ~ ${end}`;
  else if (start) label.textContent = `${start} ~`;
  else label.textContent = "전체";
}

function setDateRange(start, end, apply = true) {
  $("#start").value = start || "";
  $("#end").value = end || "";
  updateDateRangeLabel();
  renderDateRangePicker();
  if (apply) applyFiltersImmediately();
}

function syncQuickRangeSelect() {
  const select = $("#quickRange");
  if (!select) return;
  const start = $("#start").value;
  const end = $("#end").value;
  const today = isoDate(new Date());
  if (start === today && end === today) {
    select.value = "today";
    return;
  }
  for (const days of ["7", "14", "21", "28"]) {
    const date = new Date(`${today}T00:00:00`);
    date.setDate(date.getDate() - Number(days) + 1);
    if (start === isoDate(date) && end === today) {
      select.value = days;
      return;
    }
  }
  select.value = "custom";
}

function renderDateRangePicker() {
  const target = $("#dateRangePicker");
  if (!target) return;
  const selectedStart = $("#start").value;
  const selectedEnd = $("#end").value;
  const base = state.datePickerMonth
    ? new Date(state.datePickerMonth)
    : new Date(`${selectedStart || selectedEnd || isoDate(new Date())}T00:00:00`);
  const year = base.getFullYear();
  const month = base.getMonth();
  const first = new Date(year, month, 1);
  const startCell = new Date(year, month, 1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(startCell);
    day.setDate(startCell.getDate() + index);
    const value = isoDate(day);
    const inMonth = day.getMonth() === month;
    const hasData = isDataDate(value);
    const selectable = isSelectableCalendarDate(value);
    const inRange = selectedStart && selectedEnd && value >= selectedStart && value <= selectedEnd;
    const isEdge = value === selectedStart || value === selectedEnd;
    return `<button type="button" class="${inMonth ? "" : "muted-day"} ${hasData ? "data-day" : ""} ${selectable ? "" : "disabled-day"} ${inRange ? "in-range" : ""} ${isEdge ? "range-edge" : ""}" data-date="${value}" ${selectable ? "" : "disabled"}>${day.getDate()}</button>`;
  }).join("");
  target.innerHTML = `
    <div class="date-picker-head">
      <button type="button" class="ghost" data-month-step="-1">‹</button>
      <strong>${year}-${String(month + 1).padStart(2, "0")}</strong>
      <button type="button" class="ghost" data-month-step="1">›</button>
    </div>
    <div class="date-picker-state">${state.pendingRangeStart ? `시작일 ${esc(state.pendingRangeStart)} · 종료일 선택` : "시작일 선택"}</div>
    <div class="date-picker-week">${["일", "월", "화", "수", "목", "금", "토"].map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="date-picker-grid">${cells}</div>
  `;
}

function shiftDatePickerMonth(step) {
  const base = state.datePickerMonth ? new Date(state.datePickerMonth) : new Date(`${$("#start").value || isoDate(new Date())}T00:00:00`);
  base.setMonth(base.getMonth() + Number(step));
  state.datePickerMonth = new Date(base.getFullYear(), base.getMonth(), 1).toISOString();
  renderDateRangePicker();
}

function chooseRangeDate(value) {
  if (!isSelectableCalendarDate(value)) return;
  if (!state.pendingRangeStart || ($("#start").value && $("#end").value)) {
    state.pendingRangeStart = value;
    $("#quickRange").value = "custom";
    $("#start").value = value;
    $("#end").value = "";
    updateDateRangeLabel();
    renderDateRangePicker();
    return;
  }
  const start = value < state.pendingRangeStart ? value : state.pendingRangeStart;
  const end = value < state.pendingRangeStart ? state.pendingRangeStart : value;
  state.pendingRangeStart = "";
  $("#quickRange").value = "custom";
  setDateRange(start, end, true);
  $(".date-range-menu").open = false;
}

function params() {
  const search = new URLSearchParams();
  ["start", "end"].forEach((id) => {
    if ($("#" + id).value) search.set(id, $("#" + id).value);
  });
  ["type", "line", "process"].forEach((key) => {
    checkedValues(key).forEach((value) => search.append(key, value));
  });
  const query = $("#globalSearch")?.value;
  if (query) search.set("q", query);
  return search;
}

async function init() {
  $$(".admin-only").forEach((el) => {
    if (!isAdmin) el.disabled = true;
  });
  state.options = await api("/api/options");
  hydrateOptions();
  bind();
  applyUrl();
  restoreView();
  await refreshAll();
}

function hydrateOptions() {
  renderFilterOptions("type", state.options.types);
  renderFilterOptions("line", state.options.lines);
  renderFilterOptions("process", state.options.processes.map((p) => p.processName));
  renderProcessTree();
  fillProcess("[name=processId]");
  fillProcess("#bulkTextProcess");
  $("#settingsForm").querySelectorAll("input").forEach((input) => {
    input.value = state.options.settings[input.name] || "";
  });
  updateFilterCounts();
  updateMetricCount();
  updateDateRangeLabel();
  renderDateRangePicker();
}

function renderFilterOptions(name, values) {
  const target = $(`#${name}Options`);
  const unique = [...new Set(values)].filter((value) => value !== null && value !== undefined && String(value).trim() !== "").sort();
  target.innerHTML = [
    `<label class="check-option"><input type="radio" name="${name}Filter" value="" checked>전체</label>`,
    ...unique.map((value) => `<label class="check-option"><input type="radio" name="${name}Filter" value="${esc(value)}">${esc(value)}</label>`),
  ].join("");
}

function renderProcessTree() {
  const target = $("#processTree");
  if (!target || !state.options?.processes) return;
  const selectedType = checkedValues("type")[0] || "";
  const selectedLine = checkedValues("line")[0] || "";
  const selectedProcess = checkedValues("process")[0] || "";
  const grouped = {};
  state.options.processes
    .filter((process) => process.isActive)
    .forEach((process) => {
      grouped[process.type] ??= {};
      grouped[process.type][process.line] ??= [];
      grouped[process.type][process.line].push(process);
    });
  const html = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([type, lines]) => {
    const lineHtml = Object.entries(lines).sort(([a], [b]) => a.localeCompare(b)).map(([line, processes]) => {
      const processHtml = processes
        .sort((a, b) => a.processName.localeCompare(b.processName))
        .map((process) => `<button type="button" class="process-leaf ${selectedProcess === process.processName && selectedLine === process.line && selectedType === process.type ? "active" : ""}" data-type="${esc(process.type)}" data-line="${esc(process.line)}" data-process="${esc(process.processName)}">${esc(process.processName)}${process.status ? `<small>${esc(process.status)}</small>` : ""}</button>`)
        .join("");
      return `<details class="tree-line" ${selectedLine === line || selectedType === type ? "open" : ""}><summary><span class="tree-toggle" aria-hidden="true"></span><button type="button" class="${selectedLine === line && selectedType === type && !selectedProcess ? "active" : ""}" data-type="${esc(type)}" data-line="${esc(line)}">${esc(line)}</button></summary><div class="tree-children">${processHtml}</div></details>`;
    }).join("");
    return `<details class="tree-type" ${selectedType === type ? "open" : ""}><summary><span class="tree-toggle" aria-hidden="true"></span><button type="button" class="${selectedType === type && !selectedLine && !selectedProcess ? "active" : ""}" data-type="${esc(type)}">${esc(type)}</button></summary><div class="tree-children">${lineHtml}</div></details>`;
  }).join("");
  target.innerHTML = html || `<div class="empty">등록된 공정이 없습니다</div>`;
}

function applyProcessTreeFilter(dataset) {
  setRadioValue("type", dataset.type || "");
  linkedFilters();
  setRadioValue("line", dataset.line || "");
  linkedFilters();
  setRadioValue("process", dataset.process || "");
  updateFilterCounts();
  updateTrendTitle();
  applyFiltersImmediately();
}

function fillProcess(selector) {
  $(selector).innerHTML = filteredProcesses(true)
    .map((process) => `<option value="${process.id}">${esc(process.line)} / ${esc(process.type)} / ${esc(process.processName)}</option>`)
    .join("");
}

function filteredProcesses(activeOnly = false, source = state.options.processes) {
  const types = checkedValues("type");
  const lines = checkedValues("line");
  const processes = checkedValues("process");
  return source.filter((process) => (
    (!activeOnly || process.isActive)
    && (!types.length || types.includes(process.type))
    && (!lines.length || lines.includes(process.line))
    && (!processes.length || processes.includes(process.processName))
  ));
}

function refreshProcessCombos() {
  fillProcess("[name=processId]");
  fillProcess("#bulkTextProcess");
  renderProcessTree();
}

function applyFiltersImmediately(reloadData = true) {
  history.replaceState(null, "", "?" + params().toString());
  refreshProcessCombos();
  if ($("#view-processes").classList.contains("active")) loadProcesses();
  if (reloadData) refreshAll();
}

function bind() {
  $$(".top-tabs button").forEach((button) => {
    button.onclick = () => showView(button.dataset.view, button.textContent);
  });
  $("#processTree").onclick = (event) => {
    const button = event.target.closest("button[data-type]");
    if (!button) return;
    event.preventDefault();
    applyProcessTreeFilter(button.dataset);
  };
  $("#themeToggle").onclick = () => {
    document.body.classList.toggle("dark");
    $("#themeToggle").textContent = document.body.classList.contains("dark") ? "밝은 모드" : "다크 모드";
  };
  ["start", "end"].forEach((id) => {
    $("#" + id).addEventListener("change", () => {
      updateDateRangeLabel();
      applyFiltersImmediately();
    });
  });
  $("#dateRangePicker").onclick = (event) => {
    const monthButton = event.target.closest("[data-month-step]");
    if (monthButton) {
      shiftDatePickerMonth(monthButton.dataset.monthStep);
      return;
    }
    const dateButton = event.target.closest("[data-date]");
    if (dateButton) chooseRangeDate(dateButton.dataset.date);
  };
  $("#resetFilters").onclick = () => {
    state.pendingRangeStart = "";
    state.datePickerMonth = null;
    $("#quickRange").value = "7";
    quickRange("7");
    $$(`#hiddenProcessFilters input`).forEach((input) => { input.checked = false; });
    hydrateOptions();
    updateFilterCounts();
    updateTrendTitle();
    history.replaceState(null, "", location.pathname);
    refreshAll();
  };
  $("#quickRange").onchange = (event) => {
    if (event.target.value === "custom") {
      $(".date-range-menu").open = true;
      renderDateRangePicker();
      positionFilterMenu($(".date-range-menu"));
      return;
    }
    quickRange(event.target.value);
    applyFiltersImmediately();
  };
  ["type", "line", "process"].forEach((name) => {
    $(`#${name}Options`).addEventListener("change", () => {
      if (name === "type" || name === "line") linkedFilters();
      updateFilterCounts();
      updateTrendTitle();
      refreshProcessCombos();
      applyFiltersImmediately();
    });
  });
  $$(".filter-menu").forEach((details) => {
    details.addEventListener("toggle", () => {
      if (details.open) {
        $$(".filter-menu").forEach((other) => {
          if (other !== details) other.open = false;
        });
        positionFilterMenu(details);
      }
    });
  });
  window.addEventListener("resize", () => {
    const open = $(".filter-menu[open]");
    if (open) positionFilterMenu(open);
  });
  window.addEventListener("scroll", () => {
    const open = $(".filter-menu[open]");
    if (open) positionFilterMenu(open);
  }, true);
  $("#metricFilter").onchange = () => {
    updateMetricCount();
    chartTrend(state.trends);
    applyFiltersImmediately(false);
  };
  $("#processComparePercent").onchange = () => renderProcessNgEtcChart();
  $("#noticeButton").onclick = () => showAlertModal("notice");
  $("#warningButton").onclick = () => showAlertModal("warning");
  $("#closeAlertDrawer").onclick = closeAlertDrawer;
  $("#globalSearch").oninput = () => { state.page = 1; renderDataTable(); };
  $("#pageSize").onchange = (event) => { state.pageSize = Number(event.target.value); renderDataTable(); };
  $("#processSearch").oninput = loadProcesses;
  $("#exportXlsx").onclick = () => { location.href = "/api/export?format=xlsx&" + params(); };
  $("#exportCsv").onclick = () => { location.href = "/api/export?format=csv&" + params(); };
  $("#deleteSelectedMeasurements").onclick = deleteSelectedMeasurements;
  $("#exportXlsxMain").onclick = () => { location.href = "/api/export?format=xlsx&" + params(); };
  $("#saveTrendPng").onclick = () => {
    const link = document.createElement("a");
    link.href = $("#trendChart").toDataURL("image/png");
    link.download = "daily-trend.png";
    link.click();
  };
  $("#entryForm").oninput = previewRates;
  $("#entryForm").onsubmit = saveEntry;
  $("#previewBulkText").onclick = renderBulkTextPreview;
  $("#saveBulkText").onclick = saveBulkText;
  $("#newProcess").onclick = () => editProcess();
  $("#deleteSelectedProcesses").onclick = deleteSelectedProcesses;
  $("#addProcessFromEntry").onclick = () => editProcess(null, "entry");
  $("#newUser").onclick = () => editUser();
  $("#importForm").onsubmit = importFile;
  $("#settingsForm").onsubmit = saveSettings;
  $("#toggleDateOrder").onclick = () => { state.pivotDesc = !state.pivotDesc; renderPivot(); };
  $("#savePivot").onclick = savePivot;
  if ($("#minTotal")) $("#minTotal").oninput = renderProcessRank;
}

function showView(view, title) {
  state.activeView = view;
  sessionStorage.setItem("activeView", view);
  $$(".view").forEach((el) => el.classList.remove("active"));
  $("#view-" + view).classList.add("active");
  $$(".top-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#pageTitle").textContent = view === "dashboard" ? "날짜별 생산·품질 현황" : title;
  $("#pageEyebrow").textContent = title;
  if (view === "audit") loadAudit();
  if (view === "users") loadUsers();
  if (view === "processes") loadProcesses();
}

function restoreView() {
  const view = sessionStorage.getItem("activeView");
  const button = view ? $(`.top-tabs button[data-view="${view}"]`) : null;
  if (button) showView(view, button.textContent);
}

function quickRange(value) {
  const now = new Date();
  let start = "";
  let end = isoDate(now);
  if (value === "today") {
    start = end;
  } else if (["7", "14", "21", "28"].includes(value)) {
    const date = new Date(now);
    date.setDate(now.getDate() - Number(value) + 1);
    start = isoDate(date);
  } else {
    end = "";
  }
  state.pendingRangeStart = "";
  state.datePickerMonth = new Date(`${start || end || isoDate(now)}T00:00:00`).toISOString();
  setDateRange(start, end, false);
}

function linkedFilters() {
  const types = checkedValues("type");
  const lines = checkedValues("line");
  const currentLines = new Set(lines);
  const currentProcesses = new Set(checkedValues("process"));
  const typeFiltered = state.options.processes.filter((process) => !types.length || types.includes(process.type));
  renderFilterOptions("line", [...new Set(typeFiltered.map((process) => process.line))].sort());
  $$(`input[name="lineFilter"]`).forEach((input) => {
    input.checked = currentLines.size ? currentLines.has(input.value) : input.value === "";
  });
  if (!$(`input[name="lineFilter"]:checked`)) {
    $(`input[name="lineFilter"][value=""]`).checked = true;
  }
  const refreshedLines = checkedValues("line");
  const processes = typeFiltered.filter((process) => !refreshedLines.length || refreshedLines.includes(process.line));
  renderFilterOptions("process", [...new Set(processes.map((process) => process.processName))].sort());
  $$(`input[name="processFilter"]`).forEach((input) => {
    input.checked = currentProcesses.size ? currentProcesses.has(input.value) : input.value === "";
  });
  if (!$(`input[name="processFilter"]:checked`)) {
    $(`input[name="processFilter"][value=""]`).checked = true;
  }
  refreshProcessCombos();
}

function updateFilterCounts() {
  const shortLabels = { type: "Type", line: "Line", process: "Process" };
  ["type", "line", "process"].forEach((name) => {
    const count = checkedValues(name).length;
    $(`#${name}Count`).textContent = count ? `${shortLabels[name]} ${count}` : `${shortLabels[name]} 전체`;
  });
}

function updateTrendTitle() {
  const title = $("#trendTitle");
  if (!title || !state.options) return;
  const selectedProcesses = checkedValues("process");
  if (selectedProcesses.length === 0) {
    title.textContent = "날짜별 추이 그래프";
    return;
  }
  if (selectedProcesses.length > 1) {
    title.textContent = `선택 Process ${selectedProcesses.length}개 날짜별 추이 그래프`;
    return;
  }
  const selectedTypes = checkedValues("type");
  const selectedLines = checkedValues("line");
  const process = state.options.processes.find((item) => (
    item.processName === selectedProcesses[0]
    && (!selectedTypes.length || selectedTypes.includes(item.type))
    && (!selectedLines.length || selectedLines.includes(item.line))
  )) || state.options.processes.find((item) => item.processName === selectedProcesses[0]);
  if (!process) {
    title.textContent = `${selectedProcesses[0]} 날짜별 추이 그래프`;
    return;
  }
  title.innerHTML = `<span class="trend-title-row"><span class="trend-chip"><small>Line</small>${esc(process.line)}</span><span class="trend-chip"><small>Process</small>${esc(process.processName)}</span><span>날짜별 추이 그래프</span>${process.status ? `<span class="trend-chip"><small>현황</small>${esc(process.status)}</span>` : ""}</span>`;
}

function applyUrl() {
  const search = new URLSearchParams(location.search);
  ["start", "end"].forEach((id) => { $("#" + id).value = search.get(id) || ""; });
  if (!search.has("start") && !search.has("end")) {
    quickRange("7");
    $("#quickRange").value = "7";
  }
  ["type", "line", "process"].forEach((name) => {
    const values = search.getAll(name);
    $$(`input[name="${name}Filter"]`).forEach((input) => {
      input.checked = values.includes(input.value);
    });
  });
  linkedFilters();
  ["line", "process"].forEach((name) => {
    const values = search.getAll(name);
    $$(`input[name="${name}Filter"]`).forEach((input) => {
      input.checked = name === "process" && values.length === 0 ? input.value === "" : values.includes(input.value);
    });
  });
  updateFilterCounts();
  updateTrendTitle();
  updateDateRangeLabel();
  syncQuickRangeSelect();
  state.datePickerMonth = new Date(`${$("#start").value || $("#end").value || isoDate(new Date())}T00:00:00`).toISOString();
  renderDateRangePicker();
}

async function refreshAll() {
  await Promise.all([loadDashboard(), loadRows()]);
}

async function loadDashboard() {
  const [dashboard, trends, processCompare] = await Promise.all([
    api("/api/dashboard?" + params()),
    api("/api/trends?" + params()),
    api("/api/compare/process?" + params()),
  ]);
  state.trends = normalizeTrendRows(trends);
  state.processCompare = processCompare;
  state.alerts = activeAlerts(dashboard.alerts || []);
  renderDailyMain(state.trends);
  renderProcessNgEtcChart();
  renderStatusSummary();
  updateTrendTitle();
  chartTrend(state.trends);
  renderAlertButtons();
  if (state.rows.length) renderDataTable();
}

async function loadRows() {
  state.rows = await api("/api/measurements?" + params());
  const rowIds = new Set(state.rows.map((row) => Number(row.id)));
  state.selectedMeasurements = new Set([...state.selectedMeasurements].filter((id) => rowIds.has(Number(id))));
  renderDataTable();
  renderPivot();
}

async function loadMissing() {
  const rows = await api("/api/missing?" + params());
  renderTable("#missingTable", ["Line", "Type", "Process", "미입력 수", "마지막 입력일"], rows.map((row) => [
    row.line,
    row.type,
    row.processName,
    fmt(row.missingCount),
    row.lastInputDate,
  ]));
}

function renderKpis(data) {
  $("#kpis").classList.remove("skeleton");
  const order = ["totalCount", "ngCount", "etcCount", "etcRate", "avgCluster", "dateCount", "processCount", "ngRate"];
  $("#kpis").innerHTML = order.map((key) => {
    const value = data.summary[key] ?? 0;
    const comparison = data.comparison[key] || {};
    const diff = comparison.diff ?? 0;
    const cls = badUp.has(key) && diff > 0 ? "bad" : diff > 0 ? "good" : diff < 0 ? "warn" : "";
    const formatted = key.includes("Rate") ? pct(value) : fmt(value);
    const diffText = key.includes("Rate") ? pct(diff) : fmt(diff);
    return `<div class="kpi"><p>${labels[key]}</p><strong>${formatted}</strong><div class="delta ${cls}">이전 대비 ${diff > 0 ? "+" : ""}${diffText} · ${comparison.changeRate ?? 0}%</div></div>`;
  }).join("");
}

function statusBase(value) {
  const raw = String(value || "").trim();
  const direct = defaultStatuses.find((status) => raw === status || raw.startsWith(`${status} - `));
  if (direct) return direct;
  return statusAliases[raw] || statusAliases[raw.split(" - ")[0]] || "";
}

function renderStatusSummary() {
  const target = $("#statusSummary");
  if (!target || !state.options?.processes) return;
  const counts = Object.fromEntries(defaultStatuses.map((status) => [status, 0]));
  state.options.processes.filter((process) => process.isActive).forEach((process) => {
    const base = statusBase(process.status);
    if (base && counts[base] !== undefined) counts[base] += 1;
  });
  const classes = ["stable", "exception", "inspection", "idle"];
  target.innerHTML = defaultStatuses.map((status, index) => `
    <article class="status-card ${classes[index]}">
      <p>${esc(status)}</p>
      <strong>${fmt(counts[status])}</strong>
      <span>전체 활성 공정</span>
    </article>
  `).join("");
}

function selectedHierarchyLabel() {
  const process = checkedValues("process")[0];
  const line = checkedValues("line")[0];
  const type = checkedValues("type")[0];
  if (process) return `Process: ${process}`;
  if (line) return `Line: ${line}`;
  if (type) return `Type: ${type}`;
  return "전체 공정";
}

function renderProcessNgEtcChart() {
  const target = $("#processNgEtcChart");
  if (!target || !state.options?.processes) return;
  const compareMap = new Map((state.processCompare || []).map((row) => [Number(row.processId), row]));
  const rows = filteredProcesses(true).map((process) => {
    const data = compareMap.get(Number(process.id)) || {};
    const totalCount = Number(data.totalCount || 0);
    const ngCount = Number(data.ngCount || 0);
    const etcCount = Number(data.etcCount || 0);
    return {
      processName: process.processName,
      ngCount,
      etcCount,
      ngRate: totalCount ? ngCount / totalCount * 100 : 0,
      etcRate: totalCount ? etcCount / totalCount * 100 : 0,
    };
  }).sort((a, b) => (b.ngCount + b.etcCount) - (a.ngCount + a.etcCount) || a.processName.localeCompare(b.processName));
  const asPercent = $("#processComparePercent")?.checked;
  $("#processNgEtcTitle").textContent = `${selectedHierarchyLabel()} NG/분류실패 ${asPercent ? "비율" : "누적 수량"}`;
  const visibleRows = rows.slice(0, 30);
  const chartHeight = Math.max(320, Math.min(520, visibleRows.length * 18 + 260));
  target.closest(".chart-box").style.height = `${chartHeight}px`;
  chart("#processNgEtcChart", "bar", {
    labels: visibleRows.map((row) => row.processName),
    datasets: [
      { label: asPercent ? "NG%" : "NG", data: visibleRows.map((row) => asPercent ? row.ngRate : row.ngCount), backgroundColor: "#ff8a8a" },
      { label: asPercent ? "분류실패%" : "분류실패", data: visibleRows.map((row) => asPercent ? row.etcRate : row.etcCount), backgroundColor: "#ffcf6e" },
    ],
  }, {
    scales: {
      x: { stacked: false, ticks: { maxRotation: 45, minRotation: 0 } },
      y: { stacked: false, beginAtZero: true, ticks: { callback: (value) => asPercent ? `${value}%` : Number(value).toLocaleString("ko-KR") } },
    },
    plugins: {
      tooltip: {
        callbacks: {
          label: (context) => `${context.dataset.label}: ${asPercent ? pct(context.parsed.y) : fmt(context.parsed.y)}`,
        },
      },
    },
  });
}

function renderAlertButtons() {
  const noticeCount = groupAlertsByProcess(state.alerts.filter((alert) => alert.level === "notice")).length;
  const warningCount = groupAlertsByProcess(state.alerts.filter((alert) => alert.level !== "notice")).length;
  const notice = $("#noticeButton");
  const warning = $("#warningButton");
  notice.textContent = `알림 ${noticeCount}`;
  warning.textContent = `경고 ${warningCount}`;
  notice.disabled = noticeCount === 0;
  warning.disabled = warningCount === 0;
  notice.classList.toggle("active", noticeCount > 0);
  warning.classList.toggle("danger-button", warningCount > 0);
}

function showAlertModal(level = null) {
  const alerts = level ? state.alerts.filter((alert) => (level === "notice" ? alert.level === "notice" : alert.level !== "notice")) : state.alerts;
  if (!alerts.length) {
    toast("표시할 알림이 없습니다");
    return;
  }
  const title = level === "notice" ? "알림" : level === "warning" ? "경고" : "생산품질 알림";
  state.alertModalGroups = groupAlertsByProcess(alerts);
  const rows = state.alertModalGroups.map((group, groupIndex) => {
    const alert = group.alerts[0];
    const details = group.alerts.map((item) => `
      <div class="alert-detail">
        <span>${esc(item.title || "생산품질 경고")}</span>
        <small>${alertDetail(item)}</small>
      </div>
    `).join("");
    return `
    <div class="alert-item">
      <strong>${esc(alert.type)} / ${esc(alert.line)} / ${esc(alert.processName)} <em>${group.alerts.length}</em></strong>
      <div class="alert-detail-list">${details}</div>
      <div class="alert-actions"><button type="button" class="ghost" onclick="applyAlertGroupFilter(${groupIndex})">필터 적용</button><button type="button" class="primary" onclick="acknowledgeAlertGroup(${groupIndex})">확인 완료</button></div>
    </div>
  `;
  }).join("");
  $("#alertDrawerEyebrow").textContent = level === "notice" ? "알림" : "경고";
  $("#alertDrawerTitle").textContent = title;
  $("#alertDrawerBody").innerHTML = `<div class="alert-actions top"><button type="button" class="ghost" onclick="acknowledgeVisibleAlerts('${level || ""}')">현재 목록 확인 완료</button></div>${rows}`;
  $("#alertDrawer").classList.add("open");
  $("#alertDrawer").setAttribute("aria-hidden", "false");
}

function closeAlertDrawer() {
  $("#alertDrawer").classList.remove("open");
  $("#alertDrawer").setAttribute("aria-hidden", "true");
}

function groupAlertsByProcess(alerts) {
  const groups = new Map();
  alerts.forEach((alert) => {
    const key = [alert.processId ?? "", alert.type ?? "", alert.line ?? "", alert.processName ?? ""].join("|");
    if (!groups.has(key)) groups.set(key, { key, alerts: [] });
    groups.get(key).alerts.push(alert);
  });
  return [...groups.values()];
}

function alertDetail(alert) {
  if (alert.alertType === "etc_spike") {
    return `${esc(alert.previousDate)} ${pct(alert.previousEtcRate)} -> ${esc(alert.date)} ${pct(alert.etcRate)} / 증가폭 ${pct(alert.increase)}`;
  }
  if (alert.alertType === "missing_data") {
    return `마지막 입력일: ${esc(alert.lastInputDate)} / 경과일: ${alert.daysSince === null ? "미입력" : `${fmt(alert.daysSince)}일`}`;
  }
  return `비고 공란 날짜: ${(alert.blankNoteDates || []).map(esc).join(", ")}`;
}

function applyAlertObject(alert) {
  if (!alert) return;
  closeAlertDrawer();
  setRadioValue("type", alert.type);
  linkedFilters();
  setRadioValue("line", alert.line);
  linkedFilters();
  setRadioValue("process", alert.processName);
  updateFilterCounts();
  updateTrendTitle();
  applyFiltersImmediately();
}

function refreshAlertsAfterAcknowledge(message) {
  renderAlertButtons();
  chartTrend(state.trends);
  renderDailyMain(state.trends);
  if (state.rows.length) renderDataTable();
  closeAlertDrawer();
  if ($("#modal").open) $("#modal").close("acknowledged");
  toast(message);
}

function acknowledgeAlertIds(ids, message) {
  const acknowledged = acknowledgedAlerts();
  ids.forEach((id) => acknowledged.add(id));
  saveAcknowledgedAlerts(acknowledged);
  const idSet = new Set(ids);
  state.alerts = state.alerts.filter((item) => !idSet.has(item.id));
  state.alertModalGroups = [];
  refreshAlertsAfterAcknowledge(message);
}

window.applyAlertFilter = (index) => {
  applyAlertObject(state.alerts[index]);
};

window.applyAlertGroupFilter = (groupIndex) => {
  applyAlertObject(state.alertModalGroups[groupIndex]?.alerts[0]);
};

window.acknowledgeAlert = (index) => {
  const alert = state.alerts[index];
  if (!alert) return;
  acknowledgeAlertIds([alert.id], "알림을 확인 완료했습니다");
};

window.acknowledgeAlertGroup = (groupIndex) => {
  const group = state.alertModalGroups[groupIndex];
  if (!group) return;
  acknowledgeAlertIds(group.alerts.map((alert) => alert.id), "해당 공정의 알림/경고를 확인 완료했습니다");
};

window.acknowledgeAllAlerts = () => {
  const acknowledged = acknowledgedAlerts();
  state.alerts.forEach((alert) => acknowledged.add(alert.id));
  saveAcknowledgedAlerts(acknowledged);
  state.alerts = [];
  state.alertModalGroups = [];
  renderAlertButtons();
  chartTrend(state.trends);
  renderDailyMain(state.trends);
  if (state.rows.length) renderDataTable();
  closeAlertDrawer();
  if ($("#modal").open) $("#modal").close("acknowledged");
  toast("모든 알림을 확인 완료했습니다");
};

window.acknowledgeVisibleAlerts = (level) => {
  const visible = level ? state.alerts.filter((alert) => (level === "notice" ? alert.level === "notice" : alert.level !== "notice")) : state.alerts;
  const acknowledged = acknowledgedAlerts();
  visible.forEach((alert) => acknowledged.add(alert.id));
  saveAcknowledgedAlerts(acknowledged);
  const visibleIds = new Set(visible.map((alert) => alert.id));
  state.alerts = state.alerts.filter((alert) => !visibleIds.has(alert.id));
  state.alertModalGroups = [];
  renderAlertButtons();
  chartTrend(state.trends);
  renderDailyMain(state.trends);
  if (state.rows.length) renderDataTable();
  closeAlertDrawer();
  if ($("#modal").open) $("#modal").close("acknowledged");
  toast("현재 목록을 확인 완료했습니다");
};

function setRadioValue(name, value) {
  const input = $$(`input[name="${name}Filter"]`).find((item) => item.value === value) || $(`input[name="${name}Filter"][value=""]`);
  if (input) input.checked = true;
}

function alertDates() {
  return new Set(state.alerts.flatMap((alert) => alert.blankNoteDates || []));
}

function isAlertRow(row) {
  return state.alerts.some((alert) => (
    alert.type === row.type
    && alert.line === row.line
    && alert.processName === row.processName
    && (alert.blankNoteDates || []).includes(row.date)
  ));
}

function renderDailyMain(rows) {
  const dates = alertDates();
  const orderedRows = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const headers = ["구분", ...orderedRows.map((row) => noteDate(row, dates.has(row.date)))];
  const mainRows = [
    ["총체결", ...orderedRows.map((row) => num(row.totalCount))],
    ["NG", ...orderedRows.map((row) => num(row.ngCount))],
    ["분류실패", ...orderedRows.map((row) => num(row.etcCount))],
    ["분류실패%", ...orderedRows.map((row) => warnPct(row.etcRate, "etc_rate_threshold"))],
    ["Cluster", ...orderedRows.map((row) => num(row.clusterCount))],
    ["비고", ...orderedRows.map((row) => esc(row.note || ""))],
  ];
  renderTable("#dailyMainTable", headers, mainRows);
}

function chart(id, type, data, options = {}) {
  state.charts[id]?.destroy();
  const basePlugins = {
    legend: {
      position: "bottom",
      labels: {
        color: getComputedStyle(document.body).getPropertyValue("--text"),
        filter: (item, chartData) => !chartData.datasets[item.datasetIndex]?.isGuideLine,
      },
    },
    tooltip: {
      filter: (item) => !item.dataset.isGuideLine,
    },
  };
  state.charts[id] = new Chart($(id), {
    type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      ...options,
      plugins: { ...basePlugins, ...(options.plugins || {}) },
    },
  });
  return state.charts[id];
}

const noteDateHighlightPlugin = {
  id: "noteDateHighlight",
  beforeDraw(chartInstance) {
    const notes = chartInstance.options.plugins.noteDateHighlight?.notes || {};
    const alertDateSet = new Set(chartInstance.options.plugins.noteDateHighlight?.alertDates || []);
    const xScale = chartInstance.scales.x;
    if (!xScale) return;
    const ctx = chartInstance.ctx;
    ctx.save();
    alertDateSet.forEach((date) => {
      const index = chartInstance.data.labels.indexOf(date);
      if (index < 0) return;
      const x = xScale.getPixelForValue(index);
      const y = xScale.bottom - 21;
      const textWidth = ctx.measureText(date).width;
      const width = Math.max(78, textWidth + 18);
      roundRect(ctx, x - width / 2, y - 2, width, 22, 6);
      ctx.fillStyle = "rgba(255,107,107,.18)";
      ctx.fill();
      ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--bad");
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    Object.keys(notes).forEach((date) => {
      const index = chartInstance.data.labels.indexOf(date);
      if (index < 0) return;
      const x = xScale.getPixelForValue(index);
      const y = xScale.bottom - 22;
      ctx.beginPath();
      ctx.arc(x + 28, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--warn");
      ctx.fill();
      ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--panel");
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    ctx.restore();
  },
};

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

if (window.Chart) {
  Chart.register(noteDateHighlightPlugin);
}

function positionFilterMenu(details) {
  const summary = $("summary", details);
  const menu = $(".menu-options", details);
  const rect = summary.getBoundingClientRect();
  const width = details.classList.contains("process-filter-menu")
    ? Math.min(760, window.innerWidth - 24)
    : details.classList.contains("date-range-menu")
      ? Math.min(320, window.innerWidth - 24)
      : Math.max(230, rect.width);
  const maxHeight = details.classList.contains("process-filter-menu") ? 420 : 300;
  const menuHeight = Math.min(menu.scrollHeight || maxHeight, maxHeight, window.innerHeight - 24);
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${maxHeight}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - width - 12)}px`;
  menu.style.top = `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 12))}px`;
}

function chartTrend(rows) {
  const metrics = selectedMetrics();
  const byDate = Object.fromEntries(rows.map((row) => [row.date, row]));
  const noteMap = Object.fromEntries(rows.filter((row) => String(row.note || "").trim()).map((row) => [row.date, String(row.note).trim()]));
  const alertDateList = [...alertDates()];
  const chartTooltipMap = { ...noteMap };
  alertDateList.forEach((date) => {
    chartTooltipMap[date] ??= "분류실패% 연속 초과, 비고 공란";
  });
  const hasNgEtcStack = metrics.includes("ngEtcStack");
  const lineCountMetrics = metrics.filter((metric) => metric !== "ngEtcStack" && metric !== "totalCount" && !metric.includes("Rate"));
  const stackedMax = hasNgEtcStack ? Math.max(...rows.map((row) => Number(row.ngCount || 0) + Number(row.etcCount || 0)), 0) : 0;
  const lineCountMax = lineCountMetrics.length ? Math.max(...rows.flatMap((row) => lineCountMetrics.map((metric) => Number(row[metric] || 0))), 0) : 0;
  const totalMax = metrics.includes("totalCount") ? Math.max(...rows.map((row) => Number(row.totalCount || 0)), 0) : 0;
  const countMax = Math.max(stackedMax, lineCountMax);
  const countScale = countMax > 0 ? { suggestedMax: Math.ceil(countMax * 1.12) } : {};
  const totalScale = totalMax > 0 ? { suggestedMax: Math.ceil(totalMax * 1.08) } : {};
  const colors = {
    totalCount: "#5b8cff",
    ngCount: "#ff5d5d",
    ngRate: "#f97316",
    etcCount: "#ffb020",
    etcRate: "#a78bfa",
    clusterCount: "#38bdf8",
  };
  const datasets = [];
  if (metrics.includes("ngEtcStack")) {
    datasets.push(
      {
        type: "bar",
        label: "NG+분류실패 / NG",
        metricKey: "ngCount",
        data: rows.map((row) => row.ngCount ?? 0),
        backgroundColor: "rgba(255, 93, 93, .72)",
        borderColor: "#ff5d5d",
        borderWidth: 1,
        stack: "ngEtc",
        yAxisID: "stackCount",
        order: 2,
      },
      {
        type: "bar",
        label: "NG+분류실패 / 분류실패",
        metricKey: "etcCount",
        data: rows.map((row) => row.etcCount ?? 0),
        backgroundColor: "rgba(255, 176, 32, .72)",
        borderColor: "#ffb020",
        borderWidth: 1,
        stack: "ngEtc",
        yAxisID: "stackCount",
        order: 2,
      },
    );
  }
  metrics.filter((metric) => metric !== "ngEtcStack").forEach((metric) => {
    datasets.push({
      type: "line",
      label: metricLabels[metric],
      metricKey: metric,
      data: rows.map((row) => row[metric] ?? null),
      borderColor: colors[metric],
      backgroundColor: colors[metric],
      tension: 0.25,
      spanGaps: false,
      yAxisID: metric.includes("Rate") ? "pct" : metric === "totalCount" ? "total" : "count",
      order: 1,
    });
  });
  if (metrics.includes("etcRate")) {
    datasets.push({
      type: "line",
      label: "",
      isGuideLine: true,
      data: rows.map(() => 0.5),
      borderColor: "#ff3b3b",
      backgroundColor: "#ff3b3b",
      borderWidth: 2,
      borderDash: [6, 5],
      pointRadius: 0,
      tension: 0,
      yAxisID: "pct",
      order: 0,
    });
  }
  const trendChart = chart("#trendChart", "line", {
    labels: rows.map((row) => row.date),
    datasets,
  }, {
    plugins: {
      noteDateHighlight: { notes: noteMap, alertDates: alertDateList },
      tooltip: {
        filter: (item) => {
          if (item.dataset.isGuideLine) return false;
          if (hasNgEtcStack && ["ngCount", "etcCount"].includes(item.dataset.metricKey) && item.dataset.stack !== "ngEtc") return false;
          return true;
        },
        callbacks: {
          label: (context) => {
            const row = byDate[context.label];
            const metric = context.dataset.metricKey;
            const value = context.parsed.y;
            const label = context.dataset.stack === "ngEtc" ? metricLabels[metric] : context.dataset.label;
            if (row && row.hasData === false && !context.dataset.isGuideLine) return `${label}: NaN`;
            return `${label}: ${metric?.includes("Rate") ? pct(value) : fmt(value)}`;
          },
        },
      },
    },
    scales: {
      count: { position: "left", stacked: false, ...countScale, ticks: { color: "#a8b3c7" }, grid: { color: "rgba(148,163,184,.16)" } },
      stackCount: { position: "left", display: false, stacked: true, ...countScale, grid: { display: false } },
      total: { position: "right", display: metrics.includes("totalCount"), ...totalScale, ticks: { color: "#5b8cff" }, grid: { drawOnChartArea: false } },
      pct: { position: "right", ticks: { color: "#a8b3c7", callback: (value) => value + "%" }, grid: { drawOnChartArea: false } },
      x: { stacked: false, ticks: { color: "#a8b3c7" }, grid: { color: "rgba(148,163,184,.12)" } },
    },
  });
  bindTrendNoteHover(trendChart, chartTooltipMap);
  bindTrendDateClick(trendChart);
}

function bindTrendNoteHover(chartInstance, noteMap) {
  const canvas = $("#trendChart");
  canvas.onmouseleave = hideNoteTooltip;
  canvas.onmousemove = (event) => {
    const xScale = chartInstance.scales.x;
    if (!xScale) return;
    const rect = canvas.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    if (offsetY < chartInstance.chartArea.bottom - 8) {
      hideNoteTooltip();
      return;
    }
    const nearest = nearestTrendDate(chartInstance, event, 42, (date) => noteMap[date]);
    if (nearest) showNoteTooltipText(event, noteMap[nearest]);
    else hideNoteTooltip();
  };
}

function bindTrendDateClick(chartInstance) {
  const canvas = $("#trendChart");
  canvas.onclick = (event) => {
    const date = nearestTrendDate(chartInstance, event, 42);
    if (!date) return;
    editTrendDateNote(date);
  };
}

function nearestTrendDate(chartInstance, event, maxDistance = 42, predicate = null) {
  const xScale = chartInstance.scales.x;
  if (!xScale) return null;
  const rect = chartInstance.canvas.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  let nearest = null;
  let nearestDistance = Infinity;
  chartInstance.data.labels.forEach((date, index) => {
    if (predicate && !predicate(date)) return;
    const distance = Math.abs(offsetX - xScale.getPixelForValue(index));
    if (distance < nearestDistance) {
      nearest = date;
      nearestDistance = distance;
    }
  });
  return nearestDistance <= maxDistance ? nearest : null;
}

function editTrendDateNote(date) {
  if (!isAdmin) {
    toast("관리자만 비고를 수정할 수 있습니다");
    return;
  }
  const selectedProcesses = checkedValues("process");
  if (selectedProcesses.length !== 1) {
    toast("비고를 작성하려면 Process를 하나 선택하세요");
    return;
  }
  const selectedTypes = checkedValues("type");
  const selectedLines = checkedValues("line");
  const row = state.rows.find((item) => (
    item.date === date
    && item.processName === selectedProcesses[0]
    && (!selectedTypes.length || selectedTypes.includes(item.type))
    && (!selectedLines.length || selectedLines.includes(item.line))
  ));
  if (!row) {
    toast("선택한 날짜의 데이터가 없습니다");
    return;
  }
  modal(`${date} 비고 작성`, `<div class="form-grid"><label class="wide">비고<textarea name="note" rows="6">${esc(row.note)}</textarea></label></div>`, async () => {
    await api(`/api/measurements/${row.id}`, { method: "PUT", body: JSON.stringify({ note: modalData().note }) });
    toast("비고를 저장했습니다");
    refreshAll();
  });
}

function renderProcessRank() {
  const min = Number($("#minTotal").value || 0);
  const rows = (state.processCompare || []).filter((row) => row.totalCount >= min);
  chart("#processChart", "bar", {
    labels: rows.slice(0, 10).map((row) => row.processName),
    datasets: [
      { label: "NG율", data: rows.slice(0, 10).map((row) => row.ngRate), backgroundColor: "#ff5d5d" },
      { label: "분류실패%", data: rows.slice(0, 10).map((row) => row.etcRate), backgroundColor: "#ffb020" },
    ],
  });
  renderTable("#rankTable", ["순위", "Line", "Type", "Process", "총체결", "NG", "NG율", "분류실패%"], rows.map((row, index) => [
    index + 1,
    row.line,
    row.type,
    row.processName,
    fmt(row.totalCount),
    fmt(row.ngCount),
    pct(row.ngRate),
    pct(row.etcRate),
  ]));
}

function renderTable(selector, heads, rows) {
  $(selector).innerHTML = `<thead><tr>${heads.map((head) => `<th>${head}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell ?? ""}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}" class="empty">데이터가 없습니다</td></tr>`}</tbody>`;
}

function selectionSet(kind) {
  return kind === "process" ? state.selectedProcesses : state.selectedMeasurements;
}

function selectionHead(kind, ids) {
  const selected = selectionSet(kind);
  const visibleIds = ids.map(Number);
  const checked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  return `<label class="select-cell"><input type="checkbox" aria-label="모두 선택" ${checked ? "checked" : ""} onchange="toggleVisibleSelection('${kind}', this.checked, '${visibleIds.join(",")}')"></label>`;
}

function selectionCell(kind, id) {
  const checked = selectionSet(kind).has(Number(id));
  return `<label class="select-cell"><input type="checkbox" aria-label="선택" ${checked ? "checked" : ""} onchange="toggleSelection('${kind}', ${Number(id)}, this.checked)"></label>`;
}

function updateSelectionButtons() {
  const measurementButton = $("#deleteSelectedMeasurements");
  const processButton = $("#deleteSelectedProcesses");
  if (measurementButton) {
    measurementButton.textContent = `선택 삭제${state.selectedMeasurements.size ? ` (${state.selectedMeasurements.size})` : ""}`;
    measurementButton.disabled = !state.selectedMeasurements.size;
  }
  if (processButton) {
    processButton.textContent = `선택 삭제${state.selectedProcesses.size ? ` (${state.selectedProcesses.size})` : ""}`;
    processButton.disabled = !state.selectedProcesses.size;
  }
}

window.toggleSelection = (kind, id, checked) => {
  const selected = selectionSet(kind);
  if (checked) selected.add(Number(id));
  else selected.delete(Number(id));
  updateSelectionButtons();
};

window.toggleVisibleSelection = (kind, checked, idText) => {
  const selected = selectionSet(kind);
  const ids = idText ? idText.split(",").filter(Boolean).map(Number) : [];
  ids.forEach((id) => {
    if (checked) selected.add(id);
    else selected.delete(id);
  });
  if (kind === "process") loadProcesses();
  else renderDataTable();
};

function num(value) {
  return `<span class="${Number(value) === 0 ? "zero" : ""} num">${fmt(value)}</span>`;
}

function warnPct(value, key) {
  return `<span class="${Number(value) >= Number(state.options.settings[key] || 1) ? "bad" : ""}">${pct(value)}</span>`;
}

function renderDataTable() {
  const query = $("#globalSearch").value?.toLowerCase() || "";
  let rows = state.rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(state.page, pages);
  rows = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  const visibleIds = rows.map((row) => row.id);
  renderTable("#dataTable", [selectionHead("measurement", visibleIds), "날짜", "Line", "Type", "Process", "현황", "총체결", "NG", "NG율", "분류실패", "분류실패%", "Cluster", "비고", "관리"], rows.map((row) => [
    selectionCell("measurement", row.id),
    noteDate(row, isAlertRow(row)),
    row.line,
    row.type,
    row.processName,
    row.status,
    num(row.totalCount),
    num(row.ngCount),
    warnPct(row.ngRate, "ng_rate_threshold"),
    num(row.etcCount),
    warnPct(row.etcRate, "etc_rate_threshold"),
    num(row.clusterCount),
    `<button onclick="showNote('${encodeURIComponent(row.note)}')">${esc(row.note).slice(0, 18)}</button>`,
    isAdmin ? `<button onclick="editMeasurement(${row.id})">수정</button>` : "-",
  ]));
  $("#pager").innerHTML = `<button ${state.page <= 1 ? "disabled" : ""} onclick="state.page--;renderDataTable()">이전</button><span>${state.page} / ${pages}</span><button ${state.page >= pages ? "disabled" : ""} onclick="state.page++;renderDataTable()">다음</button>`;
  updateSelectionButtons();
}

window.showNote = (note) => modal("비고", decodeURIComponent(note) || "비고가 없습니다");

function renderPivot() {
  const dates = [...new Set(state.rows.map((row) => row.date))].sort((a, b) => state.pivotDesc ? b.localeCompare(a) : a.localeCompare(b));
  const groups = {};
  state.rows.forEach((row) => {
    const key = [row.line, row.type, row.processName, row.status].join("|");
    groups[key] ??= { meta: [row.line, row.type, row.processName, row.status], byDate: {} };
    groups[key].byDate[row.date] = row;
  });
  const metrics = ["총체결", "NG", "분류실패", "분류실패%", "Cluster", "비고"];
  let html = `<thead><tr>${["Line", "Type", "Process", "현황", "구분", ...dates].map((head) => `<th>${head}</th>`).join("")}</tr></thead><tbody>`;
  Object.values(groups).forEach((group) => {
    metrics.forEach((metric, index) => {
      html += `<tr>${index === 0 ? group.meta.map((value) => `<td rowspan="6">${esc(value)}</td>`).join("") : ""}<td>${metric}</td>${dates.map((day) => pivotCell(group.byDate[day], metric)).join("")}</tr>`;
    });
  });
  $("#pivotTable").innerHTML = html + "</tbody>";
}

function pivotCell(row, metric) {
  if (!row) return `<td class="zero">-</td>`;
  const map = { "총체결": row.totalCount, "NG": row.ngCount, "분류실패": row.etcCount, "분류실패%": pct(row.etcRate), "Cluster": row.clusterCount, "비고": row.note };
  const editable = isAdmin && metric !== "분류실패%";
  return `<td ${editable ? `contenteditable class="editable" data-id="${row.id}" data-metric="${metric}"` : ""}>${esc(map[metric])}</td>`;
}

async function savePivot() {
  const byId = {};
  $$("[contenteditable][data-id]").forEach((cell) => {
    const key = { "총체결": "totalCount", "NG": "ngCount", "분류실패": "etcCount", "Cluster": "clusterCount", "비고": "note" }[cell.dataset.metric];
    if (!key) return;
    byId[cell.dataset.id] ??= {};
    byId[cell.dataset.id][key] = cell.textContent.trim();
  });
  for (const [id, body] of Object.entries(byId)) {
    await api(`/api/measurements/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  toast("Excel 형태 수정값을 저장했습니다");
  refreshAll();
}

function previewRates() {
  const form = $("#entryForm");
  const total = Number(form.totalCount.value || 0);
  $("#ngPreview").textContent = pct(total ? 100 * Number(form.ngCount.value || 0) / total : 0);
  $("#etcPreview").textContent = pct(total ? 100 * Number(form.etcCount.value || 0) / total : 0);
}

async function saveEntry(event) {
  event.preventDefault();
  if (!isAdmin) return;
  try {
    await api("/api/measurements", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    toast("저장했습니다");
    event.target.reset();
    refreshAll();
  } catch (error) {
    toast(error.message);
  }
}

function editMeasurement(id) {
  const row = state.rows.find((item) => item.id === id);
  modal("측정 데이터 수정", `<div class="form-grid"><label>총체결<input name="totalCount" type="number" value="${row.totalCount}"></label><label>NG<input name="ngCount" type="number" value="${row.ngCount}"></label><label>분류실패<input name="etcCount" type="number" value="${row.etcCount}"></label><label>Cluster<input name="clusterCount" type="number" value="${row.clusterCount}"></label><label class="wide">비고<textarea name="note">${esc(row.note)}</textarea></label></div>`, async () => {
    await api(`/api/measurements/${id}`, { method: "PUT", body: JSON.stringify(modalData()) });
    toast("수정했습니다");
    refreshAll();
  });
}

async function delMeasurement(id) {
  modal("삭제 확인", "선택한 데이터 1건을 삭제합니다.", async () => {
    await api(`/api/measurements/${id}`, { method: "DELETE" });
    toast("삭제했습니다");
    refreshAll();
  });
}

async function deleteSelectedMeasurements() {
  if (!isAdmin) return;
  const ids = [...state.selectedMeasurements];
  if (!ids.length) {
    toast("삭제할 데이터를 선택하세요");
    return;
  }
  modal("선택 데이터 삭제", `선택한 데이터 ${ids.length}건을 삭제합니다.`, async () => {
    for (const id of ids) {
      await api(`/api/measurements/${id}`, { method: "DELETE" });
    }
    state.selectedMeasurements.clear();
    toast(`삭제했습니다 (${ids.length}건)`);
    refreshAll();
  });
}

function parseBulkTextLocal() {
  const lines = $("#bulkText").value.split(/\r?\n/).map((line) => line.replace(/\r$/, "")).filter((line) => line.trim());
  const matrix = lines.map(splitBulkLineLocal);
  const dateColumns = (matrix[0] || []).map((item, index) => ({ index, date: normalizeBulkDateLocal(item) })).filter((item) => item.date);
  const firstDateIndex = dateColumns[0]?.index ?? 0;
  const dates = dateColumns.map((item) => item.date);
  const rows = dates.map((day) => ({ date: day, totalCount: 0, ngCount: 0, etcCount: 0, clusterCount: 0 }));
  const keyMap = {
    "총체결": "totalCount",
    "총 체결": "totalCount",
    "NG": "ngCount",
    "ETC": "etcCount",
    "Etc": "etcCount",
    "분류실패": "etcCount",
    "Cluster": "clusterCount",
    "Cluster(Upper)": "clusterUpperCount",
    "Cluster(Lower(Near))": "clusterLowerNearCount",
    "Cluster(Lower(Far))": "clusterLowerFarCount",
  };
  matrix.slice(1).forEach((parts) => {
    const parsed = splitBulkLabelLocal(parts, keyMap);
    const key = keyMap[parsed.label];
    if (!key) return;
    rows.forEach((row, rowIndex) => {
      const valueIndex = firstDateIndex > 0 ? dateColumns[rowIndex].index : dateColumns[rowIndex].index + parsed.width;
      row[key] = Number(parts[valueIndex] || 0);
    });
  });
  rows.forEach((row) => {
    const hasSplitCluster = ["clusterUpperCount", "clusterLowerNearCount", "clusterLowerFarCount"].some((key) => Object.prototype.hasOwnProperty.call(row, key));
    if (hasSplitCluster) {
      row.clusterCount = Number(row.clusterUpperCount || 0) + Number(row.clusterLowerNearCount || 0) + Number(row.clusterLowerFarCount || 0);
    }
  });
  return rows;
}

function splitBulkLineLocal(line) {
  return line.includes("\t") ? line.split("\t").map((cell) => cell.trim()) : line.trim().split(/\s+/);
}

function normalizeBulkDateLocal(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{2}-\d{2}$/.test(text)) return `${new Date().getFullYear()}-${text}`;
  return null;
}

function splitBulkLabelLocal(parts, keyMap) {
  if (parts.length >= 2) {
    const twoWordLabel = `${parts[0]} ${parts[1]}`;
    if (keyMap[twoWordLabel]) return { label: twoWordLabel, width: 2 };
  }
  return { label: parts[0], width: 1 };
}

function renderBulkTextPreview() {
  const rows = parseBulkTextLocal();
  renderTable("#bulkTextPreview", ["날짜", "총체결", "NG", "분류실패", "Cluster"], rows.map((row) => [
    row.date,
    fmt(row.totalCount),
    fmt(row.ngCount),
    fmt(row.etcCount),
    fmt(row.clusterCount),
  ]));
}

async function saveBulkText() {
  if (!isAdmin) return;
  try {
    const result = await api("/api/bulk-text", { method: "POST", body: JSON.stringify({ processId: $("#bulkTextProcess").value, text: $("#bulkText").value }) });
    toast(`신규 ${result.created}건, 수정 ${result.updated}건, 실패 ${result.failed}건`);
    renderBulkTextPreview();
    refreshAll();
  } catch (error) {
    toast(error.message);
  }
}

async function loadProcesses() {
  const query = $("#processSearch").value?.toLowerCase() || "";
  const rows = filteredProcesses(false, await api("/api/processes"))
    .filter((row) => !query || JSON.stringify(row).toLowerCase().includes(query));
  const rowIds = new Set(rows.map((row) => Number(row.id)));
  state.selectedProcesses = new Set([...state.selectedProcesses].filter((id) => rowIds.has(Number(id))));
  const visibleIds = rows.map((row) => row.id);
  renderTable("#processTable", [selectionHead("process", visibleIds), "Type", "Line", "Process", "현황", "활성", "관리"], rows.map((row) => [
    selectionCell("process", row.id),
    row.type,
    row.line,
    row.processName,
    row.status,
    row.isActive ? "활성" : "비활성",
    isAdmin ? `<button onclick="editProcess(${row.id})">수정</button> <button onclick="toggleProcess(${row.id},${!row.isActive})">${row.isActive ? "비활성화" : "활성화"}</button>` : "-",
  ]));
  updateSelectionButtons();
}

window.editProcess = async (id, originView = null) => {
  const row = id ? (await api("/api/processes")).find((item) => item.id === id) : { line: "", type: "", processName: "", status: "" };
  modal(id ? "공정 수정" : "공정 등록", processFormHtml(row), async () => {
    const data = modalData();
    data.status = composeProcessStatus(data.statusBase, data.statusComment);
    delete data.statusBase;
    delete data.statusComment;
    await api(id ? `/api/processes/${id}` : "/api/processes", { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
    toast("저장했습니다");
    state.options = await api("/api/options");
    hydrateOptions();
    if (originView === "entry") showView("entry", "데이터 입력");
    if ($("#view-processes").classList.contains("active")) loadProcesses();
    await refreshAll();
  });
};

function splitProcessStatus(value) {
  const raw = String(value || "").trim();
  const base = defaultStatuses.find((status) => raw === status || raw.startsWith(`${status} - `));
  if (!base) return { base: raw, comment: "" };
  return { base, comment: raw === base ? "" : raw.slice(base.length + 3).trim() };
}

function composeProcessStatus(base, comment) {
  const normalizedBase = String(base || "").trim();
  const normalizedComment = String(comment || "").trim();
  if (!normalizedBase) return normalizedComment;
  return normalizedComment ? `${normalizedBase} - ${normalizedComment}` : normalizedBase;
}

function processFormHtml(row) {
  const status = splitProcessStatus(row.status);
  return `<div class="form-grid">
    <label>Type<input name="type" list="processTypeList" value="${esc(row.type)}" required></label>
    <label>Line<input name="line" list="processLineList" value="${esc(row.line)}" required></label>
    <label>Process<input name="processName" value="${esc(row.processName)}" required></label>
    <label>현황 기본항목<input name="statusBase" list="processStatusList" value="${esc(status.base)}" placeholder="직접 입력 가능"></label>
    <div class="wide status-default-box"><strong>기본항목</strong><div>${defaultStatuses.map((item) => `<button type="button" class="status-default-chip" onclick="setProcessStatusBase('${encodeURIComponent(item)}')">${esc(item)}</button>`).join("")}</div></div>
    <label class="wide">현황 코멘트<input name="statusComment" value="${esc(status.comment)}" placeholder="기본항목 뒤에 붙일 코멘트"></label>
    ${datalistHtml("processTypeList", uniqueValues(state.options.processes.map((item) => item.type)))}
    ${datalistHtml("processLineList", uniqueValues(state.options.processes.map((item) => item.line)))}
    ${statusDatalistHtml("processStatusList", uniqueValues([...defaultStatuses, ...(state.options.statuses || []), ...state.options.processes.map((item) => splitProcessStatus(item.status).base)]))}
  </div>`;
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "").map((value) => String(value).trim()))].sort();
}

function datalistHtml(id, values) {
  return `<datalist id="${id}">${values.map((value) => `<option value="${esc(value)}"></option>`).join("")}</datalist>`;
}

function statusDatalistHtml(id, values) {
  const ordered = [...defaultStatuses, ...values.filter((value) => !defaultStatuses.includes(value))];
  return `<datalist id="${id}">${ordered.map((value) => `<option value="${esc(value)}" label="${defaultStatuses.includes(value) ? "기본 항목" : "사용자 항목"}"></option>`).join("")}</datalist>`;
}

window.setProcessStatusBase = (encodedValue) => {
  const input = $('#modalForm [name="statusBase"]');
  if (input) input.value = decodeURIComponent(encodedValue);
};

window.toggleProcess = async (id, isActive) => {
  await api(`/api/processes/${id}`, { method: "PUT", body: JSON.stringify({ isActive }) });
  loadProcesses();
};

window.deleteProcess = async (id) => {
  modal("공정 삭제", "실적 데이터가 없는 공정은 삭제되고, 실적 데이터가 있는 공정은 비활성화됩니다.", async () => {
    const result = await api(`/api/processes/${id}`, { method: "DELETE" });
    toast(result.mode === "deactivated" ? "실적 데이터가 있어 비활성화했습니다" : "삭제했습니다");
    state.options = await api("/api/options");
    hydrateOptions();
    loadProcesses();
    refreshAll();
  });
};

async function deleteSelectedProcesses() {
  if (!isAdmin) return;
  const ids = [...state.selectedProcesses];
  if (!ids.length) {
    toast("삭제할 공정을 선택하세요");
    return;
  }
  modal("선택 공정 삭제", `선택한 공정 ${ids.length}개를 삭제합니다. 실적 데이터가 있는 활성 공정은 먼저 비활성화됩니다.`, async () => {
    const summary = { deleted: 0, deactivated: 0 };
    for (const id of ids) {
      const result = await api(`/api/processes/${id}`, { method: "DELETE" });
      if (result.mode === "deactivated") summary.deactivated += 1;
      else summary.deleted += 1;
    }
    state.selectedProcesses.clear();
    toast(`삭제 ${summary.deleted}건, 비활성화 ${summary.deactivated}건`);
    state.options = await api("/api/options");
    hydrateOptions();
    loadProcesses();
    refreshAll();
  });
}

async function loadUsers() {
  const rows = await api("/api/users");
  renderTable("#userTable", ["아이디", "이름", "권한", "상태", "관리"], rows.map((user) => [
    user.username,
    user.name,
    user.role === "admin" ? "관리자" : "조회자",
    user.isActive ? "활성" : "비활성",
    `<button onclick="editUser(${user.id})">수정</button>`,
  ]));
}

window.editUser = async (id) => {
  const users = id ? await api("/api/users") : [];
  const user = id ? users.find((item) => item.id === id) : { username: "", name: "", role: "viewer" };
  modal(id ? "사용자 수정" : "사용자 등록", `<div class="form-grid"><label>아이디<input name="username" value="${esc(user.username)}" ${id ? "disabled" : ""}></label><label>이름<input name="name" value="${esc(user.name)}"></label><label>권한<select name="role"><option value="viewer">조회자</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>관리자</option></select></label><label>비밀번호<input name="password" type="password" ${id ? "placeholder='변경 시 입력'" : "required"}></label></div>`, async () => {
    await api(id ? `/api/users/${id}` : "/api/users", { method: id ? "PUT" : "POST", body: JSON.stringify(modalData()) });
    toast("저장했습니다");
    loadUsers();
  });
};

async function loadAudit() {
  const rows = await api("/api/audit-logs");
  renderTable("#auditTable", ["일시", "사용자", "작업", "대상", "ID"], rows.map((row) => [
    row.actionAt,
    row.username,
    row.actionType,
    row.targetType,
    row.targetId,
  ]));
}

async function importFile(event) {
  event.preventDefault();
  const res = await fetch("/api/import", { method: "POST", body: new FormData(event.target) });
  const data = await res.json();
  $("#importResult").textContent = JSON.stringify(data, null, 2);
  toast("가져오기를 완료했습니다");
  refreshAll();
}

async function saveSettings(event) {
  event.preventDefault();
  await api("/api/settings", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
  toast("설정을 저장했습니다");
  state.options = await api("/api/options");
  refreshAll();
}

function modalData() {
  return Object.fromEntries(new FormData($("#modalForm")));
}

function modal(title, body, onOk) {
  const dialog = $("#modal");
  const form = $("#modalForm");
  const okButton = $("#modalOk");
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = body;
  okButton.disabled = false;
  $("#modalCancel").onclick = () => dialog.close("cancel");
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (!onOk) {
      dialog.close("ok");
      return;
    }
    okButton.disabled = true;
    try {
      await onOk();
      dialog.close("ok");
    } catch (error) {
      toast(error.message || "처리 중 오류가 발생했습니다");
    } finally {
      okButton.disabled = false;
    }
  };
  dialog.showModal();
}

if ($("#exportMissing")) $("#exportMissing").onclick = () => toast("누락 목록은 화면 표에서 확인할 수 있습니다");
init().catch((error) => toast(error.message));

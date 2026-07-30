const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

const state = {
  options: null,
  rows: [],
  trends: [],
  processCompare: [],
  page: 1,
  pageSize: 20,
  pivotDesc: false,
  activeView: "dashboard",
  charts: {},
};

const isAdmin = window.APP_USER.role === "admin";
const labels = {
  totalCount: "총체결",
  ngCount: "NG",
  ngRate: "NG율",
  etcCount: "Etc",
  etcRate: "Etc%",
  avgCluster: "평균 Cluster",
  processCount: "등록 공정 수",
  dateCount: "등록 날짜 수",
};
const metricLabels = {
  totalCount: "총체결",
  ngCount: "NG",
  ngRate: "NG%",
  etcCount: "Etc",
  etcRate: "Etc%",
  ngEtcStack: "NG+Etc",
  clusterCount: "Cluster",
};
const badUp = new Set(["ngCount", "ngRate", "etcCount", "etcRate"]);

function fmt(value) {
  return Number(value ?? 0).toLocaleString("ko-KR");
}

function pct(value) {
  return `${Number(value ?? 0).toFixed(2)}%`;
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
  return $$(`input[name="${filterName}Filter"]:checked`).map((input) => input.value);
}

function selectedMetrics() {
  return $$("#metricFilter input:checked").map((input) => input.value);
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
  renderFilterOptions("line", state.options.lines);
  renderFilterOptions("type", state.options.types);
  renderFilterOptions("process", state.options.processes.map((p) => p.processName));
  fillProcess("[name=processId]");
  fillProcess("#bulkTextProcess");
  $("#settingsForm").querySelectorAll("input").forEach((input) => {
    input.value = state.options.settings[input.name] || "";
  });
  updateFilterCounts();
}

function renderFilterOptions(name, values) {
  const target = $(`#${name}Options`);
  target.innerHTML = values.map((value) => (
    `<label class="check-option"><input type="checkbox" name="${name}Filter" value="${esc(value)}">${esc(value)}</label>`
  )).join("");
}

function fillProcess(selector) {
  $(selector).innerHTML = state.options.processes
    .filter((process) => process.isActive)
    .map((process) => `<option value="${process.id}">${esc(process.line)} / ${esc(process.type)} / ${esc(process.processName)}</option>`)
    .join("");
}

function bind() {
  $$(".sidebar nav button").forEach((button) => {
    button.onclick = () => showView(button.dataset.view, button.textContent);
  });
  $("#themeToggle").onclick = () => {
    document.body.classList.toggle("dark");
    $("#themeToggle").textContent = document.body.classList.contains("dark") ? "밝은 모드" : "다크 모드";
  };
  $("#applyFilters").onclick = () => {
    history.replaceState(null, "", "?" + params().toString());
    refreshAll();
  };
  $("#resetFilters").onclick = () => {
    ["start", "end"].forEach((id) => { $("#" + id).value = ""; });
    $$(`.filter-menu input[type="checkbox"]`).forEach((input) => { input.checked = false; });
    updateFilterCounts();
    updateTrendTitle();
    history.replaceState(null, "", location.pathname);
    refreshAll();
  };
  $$(".quick-buttons button").forEach((button) => {
    button.onclick = () => {
      quickRange(button.dataset.range);
      $$(".quick-buttons button").forEach((item) => item.classList.toggle("active", item === button));
    };
  });
  ["type", "line", "process"].forEach((name) => {
    $(`#${name}Options`).addEventListener("change", () => {
      if (name === "type" || name === "line") linkedFilters();
      updateFilterCounts();
      updateTrendTitle();
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
  $("#metricFilter").onchange = () => chartTrend(state.trends);
  $("#globalSearch").oninput = () => { state.page = 1; renderDataTable(); };
  $("#pageSize").onchange = (event) => { state.pageSize = Number(event.target.value); renderDataTable(); };
  $("#exportXlsx").onclick = () => { location.href = "/api/export?format=xlsx&" + params(); };
  $("#exportCsv").onclick = () => { location.href = "/api/export?format=csv&" + params(); };
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
  $("#addProcessFromEntry").onclick = () => editProcess(null, "entry");
  $("#newUser").onclick = () => editUser();
  $("#importForm").onsubmit = importFile;
  $("#settingsForm").onsubmit = saveSettings;
  $("#toggleDateOrder").onclick = () => { state.pivotDesc = !state.pivotDesc; renderPivot(); };
  $("#savePivot").onclick = savePivot;
  $("#minTotal").oninput = renderProcessRank;
}

function showView(view, title) {
  state.activeView = view;
  sessionStorage.setItem("activeView", view);
  $$(".view").forEach((el) => el.classList.remove("active"));
  $("#view-" + view).classList.add("active");
  $$(".sidebar nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#pageTitle").textContent = view === "dashboard" ? "날짜별 생산·품질 현황" : title;
  $("#pageEyebrow").textContent = title;
  if (view === "audit") loadAudit();
  if (view === "users") loadUsers();
  if (view === "processes") loadProcesses();
}

function restoreView() {
  const view = sessionStorage.getItem("activeView");
  const button = view ? $(`.sidebar nav button[data-view="${view}"]`) : null;
  if (button) showView(view, button.textContent);
}

function quickRange(value) {
  const now = new Date();
  let start = "";
  let end = now.toISOString().slice(0, 10);
  if (value === "7" || value === "30") {
    const date = new Date(now);
    date.setDate(now.getDate() - Number(value) + 1);
    start = date.toISOString().slice(0, 10);
  } else {
    end = "";
  }
  $("#start").value = start;
  $("#end").value = end;
}

function linkedFilters() {
  const types = checkedValues("type");
  const lines = checkedValues("line");
  const currentLines = new Set(lines);
  const currentProcesses = new Set(checkedValues("process"));
  const typeFiltered = state.options.processes.filter((process) => !types.length || types.includes(process.type));
  renderFilterOptions("line", [...new Set(typeFiltered.map((process) => process.line))].sort());
  $$(`input[name="lineFilter"]`).forEach((input) => { input.checked = currentLines.has(input.value); });
  const refreshedLines = checkedValues("line");
  const processes = typeFiltered.filter((process) => !refreshedLines.length || refreshedLines.includes(process.line));
  renderFilterOptions("process", [...new Set(processes.map((process) => process.processName))].sort());
  $$(`input[name="processFilter"]`).forEach((input) => { input.checked = currentProcesses.has(input.value); });
}

function updateFilterCounts() {
  ["type", "line", "process"].forEach((name) => {
    const count = checkedValues(name).length;
    $(`#${name}Count`).textContent = count ? `${count}개` : "전체";
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
  title.textContent = `[${process.line}] ${process.processName} 날짜별 추이 그래프 ${process.status || ""}`.trim();
}

function applyUrl() {
  const search = new URLSearchParams(location.search);
  ["start", "end"].forEach((id) => { $("#" + id).value = search.get(id) || ""; });
  if (!search.has("start") && !search.has("end")) {
    quickRange("7");
    const sevenDayButton = $('.quick-buttons button[data-range="7"]');
    if (sevenDayButton) sevenDayButton.classList.add("active");
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
    $$(`input[name="${name}Filter"]`).forEach((input) => { input.checked = values.includes(input.value); });
  });
  updateFilterCounts();
  updateTrendTitle();
}

async function refreshAll() {
  await Promise.all([loadDashboard(), loadRows(), loadMissing()]);
}

async function loadDashboard() {
  const [dashboard, trends, processCompare] = await Promise.all([
    api("/api/dashboard?" + params()),
    api("/api/trends?" + params()),
    api("/api/compare/process?" + params()),
  ]);
  state.trends = trends;
  state.processCompare = processCompare;
  renderDailyMain(trends);
  updateTrendTitle();
  chartTrend(trends);
  renderKpis(dashboard);
  renderProcessRank();
}

async function loadRows() {
  state.rows = await api("/api/measurements?" + params());
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

function renderDailyMain(rows) {
  renderTable("#dailyMainTable", ["날짜", "총체결", "NG", "Etc", "Etc%", "Cluster", "비고"], rows.map((row) => [
    row.date,
    num(row.totalCount),
    num(row.ngCount),
    num(row.etcCount),
    warnPct(row.etcRate, "etc_rate_threshold"),
    num(row.clusterCount),
    esc(row.note),
  ]));
}

function chart(id, type, data, options = {}) {
  state.charts[id]?.destroy();
  state.charts[id] = new Chart($(id), {
    type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { color: getComputedStyle(document.body).getPropertyValue("--text") } },
      },
      ...options,
    },
  });
}

function positionFilterMenu(details) {
  const summary = $("summary", details);
  const menu = $(".menu-options", details);
  const rect = summary.getBoundingClientRect();
  const width = Math.max(230, rect.width);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - width - 12)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
}

function chartTrend(rows) {
  const metrics = selectedMetrics();
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
        label: "NG+Etc / NG",
        data: rows.map((row) => row.ngCount ?? 0),
        backgroundColor: "rgba(255, 93, 93, .72)",
        borderColor: "#ff5d5d",
        borderWidth: 1,
        stack: "ngEtc",
        yAxisID: "count",
        order: 2,
      },
      {
        type: "bar",
        label: "NG+Etc / Etc",
        data: rows.map((row) => row.etcCount ?? 0),
        backgroundColor: "rgba(255, 176, 32, .72)",
        borderColor: "#ffb020",
        borderWidth: 1,
        stack: "ngEtc",
        yAxisID: "count",
        order: 2,
      },
    );
  }
  metrics.filter((metric) => metric !== "ngEtcStack").forEach((metric) => {
    datasets.push({
      type: "line",
      label: metricLabels[metric],
      data: rows.map((row) => row[metric] ?? null),
      borderColor: colors[metric],
      backgroundColor: colors[metric],
      tension: 0.25,
      spanGaps: false,
      yAxisID: metric.includes("Rate") ? "pct" : "count",
      order: 1,
    });
  });
  chart("#trendChart", "line", {
    labels: rows.map((row) => row.date),
    datasets,
  }, {
    scales: {
      count: { position: "left", stacked: metrics.includes("ngEtcStack"), ticks: { color: "#a8b3c7" }, grid: { color: "rgba(148,163,184,.16)" } },
      pct: { position: "right", ticks: { color: "#a8b3c7", callback: (value) => value + "%" }, grid: { drawOnChartArea: false } },
      x: { stacked: metrics.includes("ngEtcStack"), ticks: { color: "#a8b3c7" }, grid: { color: "rgba(148,163,184,.12)" } },
    },
  });
}

function renderProcessRank() {
  const min = Number($("#minTotal").value || 0);
  const rows = (state.processCompare || []).filter((row) => row.totalCount >= min);
  chart("#processChart", "bar", {
    labels: rows.slice(0, 10).map((row) => row.processName),
    datasets: [
      { label: "NG율", data: rows.slice(0, 10).map((row) => row.ngRate), backgroundColor: "#ff5d5d" },
      { label: "Etc%", data: rows.slice(0, 10).map((row) => row.etcRate), backgroundColor: "#ffb020" },
    ],
  });
  renderTable("#rankTable", ["순위", "Line", "Type", "Process", "총체결", "NG", "NG율", "Etc%"], rows.map((row, index) => [
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
  renderTable("#dataTable", ["날짜", "Line", "Type", "Process", "현황", "총체결", "NG", "NG율", "Etc", "Etc%", "Cluster", "비고", "관리"], rows.map((row) => [
    row.date,
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
    isAdmin ? `<button onclick="editMeasurement(${row.id})">수정</button> <button onclick="delMeasurement(${row.id})">삭제</button>` : "-",
  ]));
  $("#pager").innerHTML = `<button ${state.page <= 1 ? "disabled" : ""} onclick="state.page--;renderDataTable()">이전</button><span>${state.page} / ${pages}</span><button ${state.page >= pages ? "disabled" : ""} onclick="state.page++;renderDataTable()">다음</button>`;
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
  const metrics = ["총체결", "NG", "Etc", "Etc%", "Cluster", "비고"];
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
  const map = { "총체결": row.totalCount, "NG": row.ngCount, "Etc": row.etcCount, "Etc%": pct(row.etcRate), "Cluster": row.clusterCount, "비고": row.note };
  const editable = isAdmin && metric !== "Etc%";
  return `<td ${editable ? `contenteditable class="editable" data-id="${row.id}" data-metric="${metric}"` : ""}>${esc(map[metric])}</td>`;
}

async function savePivot() {
  const byId = {};
  $$("[contenteditable][data-id]").forEach((cell) => {
    const key = { "총체결": "totalCount", "NG": "ngCount", "Etc": "etcCount", "Cluster": "clusterCount", "비고": "note" }[cell.dataset.metric];
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
  modal("측정 데이터 수정", `<div class="form-grid"><label>총체결<input name="totalCount" type="number" value="${row.totalCount}"></label><label>NG<input name="ngCount" type="number" value="${row.ngCount}"></label><label>Etc<input name="etcCount" type="number" value="${row.etcCount}"></label><label>Cluster<input name="clusterCount" type="number" value="${row.clusterCount}"></label><label class="wide">비고<textarea name="note">${esc(row.note)}</textarea></label></div>`, async () => {
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

function parseBulkTextLocal() {
  const lines = $("#bulkText").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matrix = lines.map((line) => line.replace(/\t/g, " ").split(/\s+/));
  const dates = (matrix[0] || []).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
  const rows = dates.map((day) => ({ date: day, totalCount: 0, ngCount: 0, etcCount: 0, clusterCount: 0 }));
  const keyMap = { "총체결": "totalCount", "총 체결": "totalCount", "NG": "ngCount", "ETC": "etcCount", "Etc": "etcCount", "Cluster": "clusterCount", "Cluster(Upper)": "clusterCount" };
  matrix.slice(1).forEach((parts) => {
    const parsed = splitBulkLabelLocal(parts, keyMap);
    const key = keyMap[parsed.label];
    if (!key) return;
    rows.forEach((row, index) => { row[key] = Number(parsed.values[index] || 0); });
  });
  return rows;
}

function splitBulkLabelLocal(parts, keyMap) {
  if (parts.length >= 2) {
    const twoWordLabel = `${parts[0]} ${parts[1]}`;
    if (keyMap[twoWordLabel]) return { label: twoWordLabel, values: parts.slice(2) };
  }
  return { label: parts[0], values: parts.slice(1) };
}

function renderBulkTextPreview() {
  const rows = parseBulkTextLocal();
  renderTable("#bulkTextPreview", ["날짜", "총체결", "NG", "ETC", "Cluster"], rows.map((row) => [
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
  const rows = await api("/api/processes");
  renderTable("#processTable", ["Type", "Line", "Process", "현황", "활성", "관리"], rows.map((row) => [
    row.type,
    row.line,
    row.processName,
    row.status,
    row.isActive ? "활성" : "비활성",
    isAdmin ? `<button onclick="editProcess(${row.id})">수정</button> <button onclick="toggleProcess(${row.id},${!row.isActive})">${row.isActive ? "비활성화" : "활성화"}</button> <button onclick="deleteProcess(${row.id})">삭제</button>` : "-",
  ]));
}

window.editProcess = async (id, originView = null) => {
  const row = id ? (await api("/api/processes")).find((item) => item.id === id) : { line: "", type: "", processName: "", status: "" };
  modal(id ? "공정 수정" : "공정 등록", processFormHtml(row), async () => {
    await api(id ? `/api/processes/${id}` : "/api/processes", { method: id ? "PUT" : "POST", body: JSON.stringify(modalData()) });
    toast("저장했습니다");
    state.options = await api("/api/options");
    hydrateOptions();
    if (originView === "entry") showView("entry", "데이터 입력");
    if ($("#view-processes").classList.contains("active")) loadProcesses();
    await refreshAll();
  });
};

function processFormHtml(row) {
  return `<div class="form-grid">
    <label>Type<input name="type" list="processTypeList" value="${esc(row.type)}" required></label>
    <label>Line<input name="line" list="processLineList" value="${esc(row.line)}" required></label>
    <label>Process<input name="processName" value="${esc(row.processName)}" required></label>
    <label>현황<input name="status" list="processStatusList" value="${esc(row.status || "")}"></label>
    ${datalistHtml("processTypeList", uniqueValues(state.options.processes.map((item) => item.type)))}
    ${datalistHtml("processLineList", uniqueValues(state.options.processes.map((item) => item.line)))}
    ${datalistHtml("processStatusList", uniqueValues([...(state.options.statuses || []), ...state.options.processes.map((item) => item.status)]))}
  </div>`;
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "").map((value) => String(value).trim()))].sort();
}

function datalistHtml(id, values) {
  return `<datalist id="${id}">${values.map((value) => `<option value="${esc(value)}"></option>`).join("")}</datalist>`;
}

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
  return Object.fromEntries(new FormData($("#modal form")));
}

function modal(title, body, onOk) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = body;
  $("#modalOk").onclick = () => onOk && onOk();
  $("#modal").showModal();
}

$("#exportMissing").onclick = () => toast("누락 목록은 화면 표에서 확인할 수 있습니다");
init().catch((error) => toast(error.message));

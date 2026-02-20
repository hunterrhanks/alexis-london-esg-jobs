// ============================================================
// Alexis London ESG Job Board - Frontend
// ============================================================

const state = {
  jobs: [],
  total: 0,
  page: 1,
  limit: 20,
  search: "",
  source: "all",
  remote: "",
  saved: "",
  sponsorOnly: "",
  sort: "score",
  selectedJobId: null,
};

// ---- DOM References ----
const $_ = (id) => document.getElementById(id);
const $jobList = $_("jobList");
const $detailPanel = $_("detailPanel");
const $detailContent = $_("detailContent");
const $pagination = $_("pagination");
const $resultCount = $_("resultCount");
const $activeFilters = $_("activeFilters");
const $totalBadge = $_("totalBadge");
const $lastUpdated = $_("lastUpdated");
const $sponsorStats = $_("sponsorStats");
const $searchInput = $_("searchInput");
const $filterRemote = $_("filterRemote");
const $filterSource = $_("filterSource");
const $filterSort = $_("filterSort");
const $filterSaved = $_("filterSaved");
const $filterSponsor = $_("filterSponsor");
const $refreshBtn = $_("refreshBtn");
const $sidebar = $_("sidebar");
const $mobileFilterBtn = $_("mobileFilterBtn");
const $mobileDetailOverlay = $_("mobileDetailOverlay");
const $mobileDetailContent = $_("mobileDetailContent");
const $mobileBackBtn = $_("mobileBackBtn");

// ---- Utility Functions ----
function timeAgo(dateStr) {
  if (!dateStr) return "";
  const now = new Date();
  const then = new Date(dateStr);
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return then.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function truncate(text, len) {
  const clean = stripHtml(text);
  return clean.length > len ? clean.slice(0, len) + "..." : clean;
}

function getInitial(company) {
  return (company || "?").charAt(0).toUpperCase();
}

function scoreColor(score) {
  if (score >= 60) return "var(--score-high)";
  if (score >= 30) return "var(--score-mid)";
  return "var(--score-low)";
}

function isMobile() {
  return window.innerWidth <= 1200;
}

// ---- Score Ring SVG Generator ----
function scoreRingSvg(score, size, strokeWidth) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (score / 100) * circumference;
  const color = scoreColor(score);

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="score-ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${strokeWidth}"/>
      <circle class="score-ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}"
        stroke-width="${strokeWidth}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
    </svg>`;
}

// ---- API Functions ----
async function fetchJobs() {
  const params = new URLSearchParams({
    page: state.page,
    limit: state.limit,
    sort: state.sort,
  });
  if (state.search) params.set("search", state.search);
  if (state.source !== "all") params.set("source", state.source);
  if (state.remote) params.set("remote", state.remote);
  if (state.saved) params.set("saved", state.saved);
  if (state.sponsorOnly) params.set("sponsorOnly", state.sponsorOnly);

  try {
    const res = await fetch(`/api/jobs?${params}`);
    const data = await res.json();
    state.jobs = data.jobs;
    state.total = data.total;
    renderJobs();
    renderPagination();
    updateResultCount();
    updateActiveFilters();
  } catch (err) {
    console.error("Failed to fetch jobs:", err);
    $jobList.innerHTML = `
      <div class="empty-state">
        <h3>Failed to load jobs</h3>
        <p>The server may still be fetching jobs. Try refreshing in a moment.</p>
      </div>`;
  }
}

async function fetchStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    $totalBadge.textContent = `${data.total} jobs`;
    if (data.lastFetch) {
      $lastUpdated.textContent = `Last updated: ${timeAgo(data.lastFetch.fetched_at)}`;
    }
    if (data.verifiedCount !== undefined) {
      $sponsorStats.textContent = `${data.verifiedCount} verified sponsors \u00b7 Avg score: ${data.avgScore}`;
    }
  } catch (err) {
    console.error("Failed to fetch stats:", err);
  }
}

async function toggleSave(jobId, e) {
  e.stopPropagation();
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/save`, { method: "POST" });
    const data = await res.json();
    const job = state.jobs.find((j) => j.id === jobId);
    if (job) job.saved = data.saved;
    const btn = document.querySelector(`.job-card[data-id="${CSS.escape(jobId)}"] .btn-save`);
    if (btn) {
      btn.classList.toggle("saved", data.saved === 1);
      btn.innerHTML = data.saved ? bookmarkFilledSvg : bookmarkSvg;
    }
  } catch (err) {
    console.error("Failed to toggle save:", err);
  }
}

async function triggerRefresh() {
  $refreshBtn.classList.add("loading");
  $refreshBtn.disabled = true;
  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    await res.json();
    await fetchJobs();
    await fetchStats();
  } catch (err) {
    console.error("Refresh failed:", err);
  } finally {
    $refreshBtn.classList.remove("loading");
    $refreshBtn.disabled = false;
  }
}

// ---- SVG Icons ----
const bookmarkSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
const bookmarkFilledSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
const locationSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const clockSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
const briefcaseSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`;
const externalSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const shieldSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;

// ---- Render Functions ----
function renderJobs() {
  if (state.jobs.length === 0) {
    $jobList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <h3>No jobs found</h3>
        <p>Try adjusting your search or filters, or click Refresh to fetch new listings.</p>
      </div>`;
    return;
  }

  $jobList.innerHTML = state.jobs.map((job) => {
    const tags = (job.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 2);
    const isSaved = job.saved === 1;
    const isActive = job.id === state.selectedJobId;
    const score = job.match_score || 0;
    const summarySnippet = job.ai_summary ? truncate(job.ai_summary, 120) : "";

    return `
      <div class="job-card ${isActive ? "active" : ""}" data-id="${escapeAttr(job.id)}" onclick="selectJob('${escapeJs(job.id)}')">
        <div class="job-card-actions">
          <button class="btn-save ${isSaved ? "saved" : ""}" onclick="toggleSave('${escapeJs(job.id)}', event)" title="${isSaved ? "Unsave" : "Save"} job">
            ${isSaved ? bookmarkFilledSvg : bookmarkSvg}
          </button>
        </div>
        <div class="job-card-top">
          <div class="score-ring" title="Match Score: ${score}/100">
            ${scoreRingSvg(score, 44, 3)}
            <div class="score-ring-text" style="color:${scoreColor(score)}">${score}</div>
          </div>
          <div class="job-logo">
            ${job.company_logo
              ? `<img src="${escapeAttr(job.company_logo)}" alt="" onerror="this.parentElement.textContent='${getInitial(job.company)}'"/>`
              : getInitial(job.company)}
          </div>
          <div class="job-info">
            <div class="job-title">${escapeHtml(job.title)}</div>
            <div class="job-company">${escapeHtml(job.company)}</div>
            <div class="job-meta">
              <span class="job-meta-item">${locationSvg} ${escapeHtml(job.location)}</span>
              <span class="job-meta-item">${clockSvg} ${timeAgo(job.posted_at)}</span>
              ${job.salary ? `<span class="job-meta-item">${escapeHtml(job.salary)}</span>` : ""}
            </div>
            <div class="job-badges">
              ${job.verified_sponsor ? `<span class="badge badge-sponsor">${shieldSvg} Verified Sponsor</span>` : ""}
              ${!job.verified_sponsor && job.visa_sponsorship ? '<span class="badge badge-visa">Visa Sponsor</span>' : ""}
              ${job.remote ? '<span class="badge badge-remote">Remote</span>' : ""}
              <span class="badge badge-source">${escapeHtml(job.source)}</span>
              ${tags.map((t) => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join("")}
            </div>
          </div>
        </div>
        ${summarySnippet ? `<div class="job-summary">${escapeHtml(summarySnippet)}</div>` : ""}
      </div>`;
  }).join("");
}

function buildDetailHtml(job) {
  const tags = (job.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  const score = job.match_score || 0;

  return `
    <div class="detail-header">
      <div class="detail-score-row">
        <div class="detail-score-ring">
          ${scoreRingSvg(score, 56, 4)}
          <div class="score-ring-text" style="color:${scoreColor(score)};font-size:16px;font-weight:700;position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">${score}</div>
        </div>
        <div class="detail-score-label">
          <div class="score-num" style="color:${scoreColor(score)}">${score}<span style="font-size:13px;color:var(--text-muted);font-weight:400">/100</span></div>
          <div class="score-text">Match Score</div>
        </div>
      </div>

      <div class="detail-logo">
        ${job.company_logo
          ? `<img src="${escapeAttr(job.company_logo)}" alt="" onerror="this.parentElement.textContent='${getInitial(job.company)}'"/>`
          : getInitial(job.company)}
      </div>
      <div class="detail-title">${escapeHtml(job.title)}</div>
      <div class="detail-company">${escapeHtml(job.company)}</div>
      <div class="detail-meta">
        <span class="job-meta-item">${locationSvg} ${escapeHtml(job.location)}</span>
        <span class="job-meta-item">${clockSvg} ${timeAgo(job.posted_at)}</span>
        ${job.job_type ? `<span class="job-meta-item">${briefcaseSvg} ${escapeHtml(job.job_type)}</span>` : ""}
        ${job.salary ? `<span class="job-meta-item">${escapeHtml(job.salary)}</span>` : ""}
      </div>
      <div class="detail-badges">
        ${job.verified_sponsor
          ? `<span class="badge badge-sponsor">${shieldSvg} Verified UK Sponsor${job.sponsor_rating ? ` (${escapeHtml(job.sponsor_rating)}-rated)` : ""}</span>`
          : ""}
        ${!job.verified_sponsor && job.visa_sponsorship ? '<span class="badge badge-visa">Visa Sponsorship</span>' : ""}
        ${job.remote ? '<span class="badge badge-remote">Remote</span>' : ""}
        <span class="badge badge-source">${escapeHtml(job.source)}</span>
        ${tags.map((t) => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join("")}
      </div>

      ${job.ai_summary
        ? `<div class="detail-ai-summary">
            <strong>Why this fits Alexis</strong>
            ${escapeHtml(job.ai_summary)}
          </div>`
        : ""}

      <a href="${escapeAttr(job.url)}" target="_blank" rel="noopener" class="detail-apply">
        Apply on ${escapeHtml(job.source)} ${externalSvg}
      </a>
    </div>
    <div class="detail-section">
      <h4>Job Description</h4>
      <div class="detail-description">${job.description || "<p>No description available. Click Apply to view the full listing.</p>"}</div>
    </div>`;
}

function selectJob(jobId) {
  state.selectedJobId = jobId;
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;

  document.querySelectorAll(".job-card").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === jobId);
  });

  const html = buildDetailHtml(job);

  if (isMobile()) {
    $mobileDetailContent.innerHTML = html;
    $mobileDetailOverlay.classList.add("active");
    document.body.style.overflow = "hidden";
  } else {
    const detailEmpty = $detailPanel.querySelector(".detail-empty");
    detailEmpty.style.display = "none";
    $detailContent.style.display = "block";
    $detailContent.innerHTML = html;
  }
}

function renderPagination() {
  const totalPages = Math.ceil(state.total / state.limit);
  if (totalPages <= 1) { $pagination.innerHTML = ""; return; }

  let html = `<button class="page-btn" onclick="goToPage(${state.page - 1})" ${state.page === 1 ? "disabled" : ""}>&laquo;</button>`;
  const start = Math.max(1, state.page - 2);
  const end = Math.min(totalPages, state.page + 2);

  if (start > 1) {
    html += `<button class="page-btn" onclick="goToPage(1)">1</button>`;
    if (start > 2) html += `<span class="page-btn" style="border:none;cursor:default">\u2026</span>`;
  }
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === state.page ? "active" : ""}" onclick="goToPage(${i})">${i}</button>`;
  }
  if (end < totalPages) {
    if (end < totalPages - 1) html += `<span class="page-btn" style="border:none;cursor:default">\u2026</span>`;
    html += `<button class="page-btn" onclick="goToPage(${totalPages})">${totalPages}</button>`;
  }
  html += `<button class="page-btn" onclick="goToPage(${state.page + 1})" ${state.page === totalPages ? "disabled" : ""}>&raquo;</button>`;
  $pagination.innerHTML = html;
}

function updateResultCount() {
  const start = (state.page - 1) * state.limit + 1;
  const end = Math.min(state.page * state.limit, state.total);
  $resultCount.textContent = state.total === 0 ? "No jobs found" : `Showing ${start}\u2013${end} of ${state.total} jobs`;
}

function updateActiveFilters() {
  let pills = [];
  if (state.search) pills.push(pill(`"${escapeHtml(state.search)}"`, "search"));
  if (state.remote === "true") pills.push(pill("Remote Only", "remote"));
  if (state.source !== "all") pills.push(pill(escapeHtml(state.source), "source"));
  if (state.saved === "true") pills.push(pill("Saved Only", "saved"));
  if (state.sponsorOnly === "true") pills.push(pill("Verified Sponsors", "sponsorOnly"));
  $activeFilters.innerHTML = pills.join("");
}

function pill(label, key) {
  return `<span class="filter-pill">${label} <button onclick="clearFilter('${key}')">&times;</button></span>`;
}

// ---- Navigation ----
function goToPage(page) {
  const totalPages = Math.ceil(state.total / state.limit);
  if (page < 1 || page > totalPages) return;
  state.page = page;
  fetchJobs();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearFilter(key) {
  if (key === "search") { state.search = ""; $searchInput.value = ""; }
  if (key === "remote") { state.remote = ""; $filterRemote.value = ""; }
  if (key === "source") { state.source = "all"; $filterSource.value = "all"; }
  if (key === "saved") { state.saved = ""; $filterSaved.checked = false; }
  if (key === "sponsorOnly") { state.sponsorOnly = ""; $filterSponsor.checked = false; }
  state.page = 1;
  fetchJobs();
}

// ---- Escaping ----
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(str) { return escapeHtml(str); }
function escapeJs(str) {
  if (!str) return "";
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ---- Event Listeners ----
let searchTimeout;
$searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.search = $searchInput.value.trim();
    state.page = 1;
    fetchJobs();
  }, 400);
});

$filterRemote.addEventListener("change", () => { state.remote = $filterRemote.value; state.page = 1; fetchJobs(); });
$filterSource.addEventListener("change", () => { state.source = $filterSource.value; state.page = 1; fetchJobs(); });
$filterSort.addEventListener("change", () => { state.sort = $filterSort.value; state.page = 1; fetchJobs(); });
$filterSaved.addEventListener("change", () => { state.saved = $filterSaved.checked ? "true" : ""; state.page = 1; fetchJobs(); });
$filterSponsor.addEventListener("change", () => { state.sponsorOnly = $filterSponsor.checked ? "true" : ""; state.page = 1; fetchJobs(); });
$refreshBtn.addEventListener("click", triggerRefresh);

// Mobile sidebar toggle
$mobileFilterBtn.addEventListener("click", () => { $sidebar.classList.toggle("open"); });

document.addEventListener("click", (e) => {
  if ($sidebar.classList.contains("open") && !$sidebar.contains(e.target) && e.target !== $mobileFilterBtn && !$mobileFilterBtn.contains(e.target)) {
    $sidebar.classList.remove("open");
  }
});

// Mobile detail back button
$mobileBackBtn.addEventListener("click", () => {
  $mobileDetailOverlay.classList.remove("active");
  document.body.style.overflow = "";
});

// ---- Initialize ----
fetchJobs();
fetchStats();

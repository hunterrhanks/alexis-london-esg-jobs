// ============================================================
// Alexis London ESG Job Board — V4.0 Frontend
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
  status: "all",
  visaConfidence: "all",
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
const $filterStatus = $_("filterStatus");
const $filterVisa = $_("filterVisa");
const $refreshBtn = $_("refreshBtn");
const $sidebar = $_("sidebar");
const $mobileFilterBtn = $_("mobileFilterBtn");
const $mobileDetailOverlay = $_("mobileDetailOverlay");
const $mobileDetailContent = $_("mobileDetailContent");
const $mobileBackBtn = $_("mobileBackBtn");
const $visaGreenCount = $_("visaGreenCount");
const $visaYellowCount = $_("visaYellowCount");
const $visaRedCount = $_("visaRedCount");

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

function probabilityColor(prob) {
  if (prob >= 65) return "var(--visa-green)";
  if (prob >= 35) return "var(--visa-yellow)";
  return "var(--visa-red)";
}

function visaConfidenceEmoji(conf) {
  if (conf === "green") return "\u{1F7E2}";
  if (conf === "yellow") return "\u{1F7E1}";
  if (conf === "red") return "\u{1F534}";
  return "\u{26AA}";
}

function visaConfidenceLabel(conf) {
  if (conf === "green") return "High";
  if (conf === "yellow") return "Medium";
  if (conf === "red") return "Low";
  return "Unknown";
}

function statusLabel(s) {
  const map = {
    new: "New",
    to_apply: "To Apply",
    applied: "Applied",
    interviewing: "Interviewing",
    offer: "Offer",
    rejected: "Rejected",
    archived: "Archived",
  };
  return map[s] || s;
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
  if (state.status !== "all") params.set("status", state.status);
  if (state.visaConfidence !== "all") params.set("visaConfidence", state.visaConfidence);

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
    // V3.0 visa stats
    if ($visaGreenCount) $visaGreenCount.textContent = data.visaGreen || 0;
    if ($visaYellowCount) $visaYellowCount.textContent = data.visaYellow || 0;
    if ($visaRedCount) $visaRedCount.textContent = data.visaRed || 0;
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

async function updateJobStatus(jobId, newStatus) {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    const data = await res.json();
    const job = state.jobs.find((j) => j.id === jobId);
    if (job) job.status = data.status;
    // Update card badge
    const card = document.querySelector(`.job-card[data-id="${CSS.escape(jobId)}"]`);
    if (card) {
      const badge = card.querySelector(".badge-status");
      if (badge) {
        badge.className = `badge badge-status badge-status-${data.status}`;
        badge.textContent = statusLabel(data.status);
      }
    }
  } catch (err) {
    console.error("Failed to update status:", err);
  }
}

async function updateJobNotes(jobId, notes) {
  try {
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    const job = state.jobs.find((j) => j.id === jobId);
    if (job) job.notes = notes;
    // Show saved indicator
    const indicator = document.getElementById("notesSaved");
    if (indicator) {
      indicator.classList.add("show");
      setTimeout(() => indicator.classList.remove("show"), 2000);
    }
  } catch (err) {
    console.error("Failed to update notes:", err);
  }
}

async function generateOutreachKit(jobId) {
  const btn = document.getElementById("btnOutreach");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("loading");
    btn.textContent = "Generating...";
  }
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/outreach-kit`, { method: "POST" });
    const kit = await res.json();
    renderOutreachResult(kit);
  } catch (err) {
    console.error("Failed to generate outreach kit:", err);
    const container = document.getElementById("outreachResult");
    if (container) container.innerHTML = '<p style="color:var(--visa-red);font-size:13px;">Failed to generate kit. Try again.</p>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.textContent = "\u2728 Generate Outreach Kit";
    }
  }
}

function renderOutreachResult(kit) {
  const container = document.getElementById("outreachResult");
  if (!container) return;

  const bullets = (kit.resume_bullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join("");

  container.innerHTML = `
    <div class="outreach-block">
      <div class="outreach-block-label">LinkedIn Connection Message</div>
      <div class="outreach-block-content" id="linkedinMsg">${escapeHtml(kit.linkedin_message || "")}</div>
      <button class="btn-copy" onclick="copyToClipboard('linkedinMsg')">Copy</button>
    </div>
    <div class="outreach-block">
      <div class="outreach-block-label">Tailored Resume Bullets</div>
      <div class="outreach-block-content"><ul>${bullets}</ul></div>
      <button class="btn-copy" onclick="copyToClipboard(null, ${escapeAttr(JSON.stringify(kit.resume_bullets || []))})">Copy All</button>
    </div>
  `;
}

function copyToClipboard(elId, textArray) {
  let text;
  if (elId) {
    const el = document.getElementById(elId);
    text = el ? el.textContent : "";
  } else if (textArray) {
    text = textArray.map(b => `\u2022 ${b}`).join("\n");
  }
  if (text) {
    navigator.clipboard.writeText(text).then(() => {
      // Brief visual feedback
      event.target.textContent = "Copied!";
      setTimeout(() => { event.target.textContent = "Copy"; }, 1500);
    });
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
const linkedinSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`;
const starSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

// ---- V4.0: LinkedIn Search URL Generator ----
function buildLinkedInSearchUrls(company, title) {
  const titleLower = (title || "").toLowerCase();
  let department = "sustainability";
  if (/esg/i.test(titleLower)) department = "ESG";
  else if (/climate/i.test(titleLower)) department = "climate";
  else if (/environment/i.test(titleLower)) department = "environmental";
  else if (/communicat/i.test(titleLower)) department = "sustainability communications";
  else if (/report/i.test(titleLower)) department = "sustainability reporting";
  else if (/carbon/i.test(titleLower)) department = "carbon net zero";

  const cleanCompany = (company || "").replace(/[^\w\s&.-]/g, "").trim();

  return {
    recruiter: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(cleanCompany + " recruiter")}&origin=GLOBAL_SEARCH_HEADER`,
    hiringManager: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(cleanCompany + " " + department)}&origin=GLOBAL_SEARCH_HEADER`,
    department,
  };
}

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
    const prob = job.success_probability || 0;
    const visaConf = job.visa_confidence || "unknown";
    const jobStatus = job.status || "new";
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
              <span class="badge badge-status badge-status-${jobStatus}">${statusLabel(jobStatus)}</span>
              <span class="badge badge-visa-${visaConf}" title="Visa Confidence: ${visaConfidenceLabel(visaConf)}">${visaConfidenceEmoji(visaConf)} Visa</span>
              ${(job.is_bcorp && job.verified_sponsor) ? `<span class="badge badge-golden">${starSvg} Golden Opportunity</span>` : ""}
              ${job.verified_sponsor ? `<span class="badge badge-sponsor">${shieldSvg} Verified</span>` : ""}
              ${job.is_bcorp && !job.verified_sponsor ? '<span class="badge badge-bcorp">B Corp</span>' : ""}
              ${!job.verified_sponsor && job.visa_sponsorship ? '<span class="badge badge-visa">Visa Sponsor</span>' : ""}
              ${job.remote ? '<span class="badge badge-remote">Remote</span>' : ""}
              <span class="badge badge-source">${escapeHtml(job.source)}</span>
              ${tags.map((t) => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join("")}
            </div>
          </div>
        </div>
        <div class="job-probability-row">
          <span class="probability-label">Success</span>
          <div class="probability-bar">
            <div class="probability-fill" style="width:${prob}%;background:${probabilityColor(prob)}"></div>
          </div>
          <span class="probability-value" style="color:${probabilityColor(prob)}">${prob}%</span>
        </div>
        ${summarySnippet ? `<div class="job-summary">${escapeHtml(summarySnippet)}</div>` : ""}
      </div>`;
  }).join("");
}

function buildDetailHtml(job) {
  const tags = (job.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  const score = job.match_score || 0;
  const prob = job.success_probability || 0;
  const visaConf = job.visa_confidence || "unknown";
  const jobStatus = job.status || "new";
  const salaryNum = job.salary_num;

  // Visa traffic light text
  let visaTrafficText = "";
  if (visaConf === "green") {
    visaTrafficText = `<strong class="visa-traffic-text green">High Visa Confidence</strong>Verified sponsor + salary meets 2026 threshold.`;
  } else if (visaConf === "yellow") {
    visaTrafficText = `<strong class="visa-traffic-text yellow">Medium Visa Confidence</strong>Verified sponsor, but salary undisclosed or near threshold. Confirm with employer.`;
  } else if (visaConf === "red") {
    visaTrafficText = `<strong class="visa-traffic-text red">Low Visa Confidence</strong>Not found on Home Office Register. May not sponsor visas.`;
  } else {
    visaTrafficText = `<strong>Unknown</strong>Visa confidence not yet assessed.`;
  }

  return `
    <div class="detail-header">
      <!-- Visa Confidence Traffic Light -->
      <div class="visa-traffic-light ${visaConf}">
        <div class="visa-traffic-icon">${visaConfidenceEmoji(visaConf)}</div>
        <div class="visa-traffic-text">${visaTrafficText}</div>
      </div>

      <!-- Success Probability -->
      <div class="detail-probability">
        <div class="detail-probability-header">
          <span class="detail-probability-label">Success Probability</span>
          <span class="detail-probability-value" style="color:${probabilityColor(prob)}">${prob}%</span>
        </div>
        <div class="detail-probability-bar">
          <div class="detail-probability-fill" style="width:${prob}%;background:${probabilityColor(prob)}"></div>
        </div>
      </div>

      <!-- Match Score -->
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

      <!-- Visa Intel Chips -->
      <div class="detail-visa-intel">
        ${job.soc_code ? `<span class="visa-intel-chip">SOC <strong>${escapeHtml(job.soc_code)}</strong></span>` : ""}
        ${salaryNum ? `<span class="visa-intel-chip">Parsed: <strong>\u00a3${salaryNum.toLocaleString()}</strong></span>` : ""}
        <span class="visa-intel-chip">Threshold: <strong>\u00a341,700</strong></span>
        ${salaryNum && salaryNum < 41700 ? '<span class="visa-intel-chip" style="background:var(--visa-red-bg);color:var(--visa-red);border-color:#EF9A9A;">\u26a0 Below threshold</span>' : ""}
        ${salaryNum && salaryNum >= 41700 ? '<span class="visa-intel-chip" style="background:var(--visa-green-bg);color:var(--visa-green);border-color:#C8E6C9;">\u2713 Meets threshold</span>' : ""}
      </div>

      <div class="detail-badges">
        ${(job.is_bcorp && job.verified_sponsor)
          ? `<span class="badge badge-golden">${starSvg} Golden Opportunity</span>`
          : ""}
        ${job.verified_sponsor
          ? `<span class="badge badge-sponsor">${shieldSvg} Verified UK Sponsor${job.sponsor_rating ? ` (${escapeHtml(job.sponsor_rating)}-rated)` : ""}</span>`
          : ""}
        ${job.is_bcorp ? '<span class="badge badge-bcorp">B Corp Certified</span>' : ""}
        ${!job.verified_sponsor && job.visa_sponsorship ? '<span class="badge badge-visa">Visa Sponsorship</span>' : ""}
        ${job.remote ? '<span class="badge badge-remote">Remote</span>' : ""}
        <span class="badge badge-source">${escapeHtml(job.source)}</span>
        ${tags.map((t) => `<span class="badge badge-tag">${escapeHtml(t)}</span>`).join("")}
      </div>

      ${(job.is_bcorp && job.verified_sponsor)
        ? `<div class="golden-opportunity-callout">
            ${starSvg} <strong>Golden Opportunity</strong> &mdash; ${escapeHtml(job.company)} is both a certified B Corporation and a verified UK visa sponsor. This is a rare, high-alignment match for Alexis.
          </div>`
        : ""}

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

    <!-- V4.0: Find the Recruiter — LinkedIn Search -->
    ${(() => {
      const urls = buildLinkedInSearchUrls(job.company, job.title);
      return `
    <div class="recruiter-search">
      <h4>${linkedinSvg} Find the Recruiter</h4>
      <div class="recruiter-search-links">
        <a href="${escapeAttr(urls.recruiter)}" target="_blank" rel="noopener" class="btn-recruiter">
          ${linkedinSvg} Find Recruiters at ${escapeHtml(job.company)}
        </a>
        <a href="${escapeAttr(urls.hiringManager)}" target="_blank" rel="noopener" class="btn-recruiter btn-recruiter-dept">
          ${linkedinSvg} Find ${escapeHtml(urls.department)} Team
        </a>
      </div>
    </div>`;
    })()}

    <!-- CRM Section: Status + Notes -->
    <div class="detail-crm-section">
      <h4>\u{1F4CB} Application Tracker</h4>
      <div class="crm-status-row">
        <span class="crm-status-label">Status:</span>
        <select class="crm-status-select" onchange="updateJobStatus('${escapeJs(job.id)}', this.value)">
          <option value="new" ${jobStatus === "new" ? "selected" : ""}>New</option>
          <option value="to_apply" ${jobStatus === "to_apply" ? "selected" : ""}>To Apply</option>
          <option value="applied" ${jobStatus === "applied" ? "selected" : ""}>Applied</option>
          <option value="interviewing" ${jobStatus === "interviewing" ? "selected" : ""}>Interviewing</option>
          <option value="offer" ${jobStatus === "offer" ? "selected" : ""}>Offer</option>
          <option value="rejected" ${jobStatus === "rejected" ? "selected" : ""}>Rejected</option>
          <option value="archived" ${jobStatus === "archived" ? "selected" : ""}>Archived</option>
        </select>
      </div>
      <textarea class="crm-notes-area" placeholder="Add notes about this application..." onblur="updateJobNotes('${escapeJs(job.id)}', this.value)">${escapeHtml(job.notes || "")}</textarea>
      <div class="crm-notes-saved" id="notesSaved">Saved</div>
    </div>

    <!-- Outreach Kit -->
    <div class="outreach-kit">
      <h4>\u2728 AI Application Kit</h4>
      <button class="btn-outreach" id="btnOutreach" onclick="generateOutreachKit('${escapeJs(job.id)}')">
        \u2728 Generate Outreach Kit
      </button>
      <div class="outreach-result" id="outreachResult"></div>
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
  if (state.status !== "all") pills.push(pill(statusLabel(state.status), "status"));
  if (state.visaConfidence !== "all") pills.push(pill(`${visaConfidenceEmoji(state.visaConfidence)} Visa: ${visaConfidenceLabel(state.visaConfidence)}`, "visaConfidence"));
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
  if (key === "status") { state.status = "all"; $filterStatus.value = "all"; }
  if (key === "visaConfidence") { state.visaConfidence = "all"; $filterVisa.value = "all"; }
  state.page = 1;
  fetchJobs();
}

// ---- Escaping ----
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(str) { return escapeHtml(str); }
function escapeJs(str) {
  if (!str) return "";
  return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
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
$filterStatus.addEventListener("change", () => { state.status = $filterStatus.value; state.page = 1; fetchJobs(); });
$filterVisa.addEventListener("change", () => { state.visaConfidence = $filterVisa.value; state.page = 1; fetchJobs(); });
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

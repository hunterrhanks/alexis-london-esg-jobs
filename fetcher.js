const fetch = require("node-fetch");
const RSSParser = require("rss-parser");
const db = require("./db");
const sponsor = require("./sponsor");
const { scoreJobs } = require("./scorer");

const NOW = () => new Date().toISOString();
const rssParser = new RSSParser();

// ---------------------------------------------------------------------------
// ESG / sustainability keywords used to filter relevance
// ---------------------------------------------------------------------------
const ESG_CORE = [
  "esg", "sustainability", "sustainable", "climate", "carbon",
  "net zero", "net-zero", "environment", "environmental",
  "social impact", "governance", "responsible investment",
  "impact investing", "green finance", "renewable",
  "circular economy", "decarbonisation", "decarbonization",
  "energy transition", "biodiversity", "csr",
  "corporate social responsibility", "responsible business",
  "cleantech", "ghg", "emissions",
  "sdg", "sustainable development", "tcfd", "sfdr",
  "taxonomy", "double materiality", "scope 1", "scope 2", "scope 3",
  "csrd", "gri reporting", "sustainability reporting",
  "esg consulting", "esg advisory", "esg analyst",
  "sustainability consultant", "climate risk", "climate consulting",
  "green bond", "sustainable finance",
  "non-profit", "nonprofit", "ngo", "charity",
  "social enterprise", "b corp", "purpose-driven",
  "impact assessment", "stakeholder engagement",
  "dei", "diversity equity inclusion",
  "corporate governance", "stewardship",
  "responsible", "ethical investment", "impact",
];

function isESGRelated(title, description, tags) {
  const text = `${title} ${description} ${tags}`.toLowerCase();
  return ESG_CORE.some((kw) => text.includes(kw));
}

// ---------------------------------------------------------------------------
// Role priority: higher = more relevant to Alexis's career goals
// ---------------------------------------------------------------------------
const ROLE_PRIORITY_PATTERNS = [
  { re: /sustainability\s+consultant/i, priority: 100 },
  { re: /esg\s+analyst/i, priority: 95 },
  { re: /esg\s+consult/i, priority: 90 },
  { re: /sustainability\s+analyst/i, priority: 88 },
  { re: /climate\s+consult/i, priority: 85 },
  { re: /sustainability\s+manager/i, priority: 80 },
  { re: /esg\s+manager/i, priority: 78 },
  { re: /esg\s+advisor/i, priority: 75 },
  { re: /sustainability\s+director/i, priority: 72 },
  { re: /sustainability\s+lead/i, priority: 70 },
  { re: /climate\s+risk/i, priority: 68 },
  { re: /esg/i, priority: 50 },
  { re: /sustainability/i, priority: 48 },
  { re: /climate/i, priority: 40 },
  { re: /environment/i, priority: 35 },
  { re: /consult/i, priority: 20 },
  { re: /advisory/i, priority: 20 },
  { re: /impact/i, priority: 15 },
];

function getRolePriority(title) {
  for (const { re, priority } of ROLE_PRIORITY_PATTERNS) {
    if (re.test(title)) return priority;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Enrich a raw job with sponsor verification + role priority
// ---------------------------------------------------------------------------
function enrichJob(rawJob) {
  // Sponsor check
  const sponsorResult = sponsor.checkSponsor(rawJob.company);
  rawJob.verified_sponsor = sponsorResult.verified ? 1 : 0;
  rawJob.sponsor_rating = sponsorResult.verified ? sponsorResult.rating : null;

  // If verified sponsor, also mark visa_sponsorship
  if (sponsorResult.verified) {
    rawJob.visa_sponsorship = 1;
  }

  // Role priority
  rawJob.role_priority = getRolePriority(rawJob.title);

  // Defaults for new fields (scoring happens later)
  rawJob.match_score = rawJob.match_score || 0;
  rawJob.ai_summary = rawJob.ai_summary || null;

  return rawJob;
}

// ---------------------------------------------------------------------------
// Source 1: Remotive (remote ESG / sustainability / consulting jobs)
//   Rate limit: 2 requests per minute
// ---------------------------------------------------------------------------
async function fetchRemotive() {
  // Prioritised search order: ESG-specific first, then broader
  const searches = [
    "sustainability consultant",
    "esg analyst",
    "esg",
    "sustainability",
    "climate",
    "consulting",
  ];
  const seen = new Set();
  const jobs = [];

  for (const query of searches) {
    console.log(`  [Remotive] Searching "${query}"...`);
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=50`;

    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      for (const job of data.jobs || []) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);

        const loc = (job.candidate_required_location || "").toLowerCase();
        const isGlobal = loc.includes("worldwide") || loc.includes("anywhere") || loc === "";
        const isUK = loc.includes("uk") || loc.includes("united kingdom") || loc.includes("europe") || loc.includes("london") || loc.includes("emea");

        if (!isGlobal && !isUK) continue;

        // For broad queries, require ESG relevance
        if ((query === "consulting") && !isESGRelated(job.title, job.description || "", job.category || "")) continue;

        jobs.push(enrichJob({
          id: `remotive-${job.id}`,
          title: job.title,
          company: job.company_name,
          location: job.candidate_required_location || "Remote - Worldwide",
          description: job.description || "",
          url: job.url,
          source: "Remotive",
          tags: job.category || "",
          job_type: job.job_type || "",
          remote: 1,
          visa_sponsorship: 0,
          salary: job.salary || null,
          company_logo: job.company_logo || null,
          posted_at: job.publication_date || NOW(),
          fetched_at: NOW(),
        }));
      }
    } catch (err) {
      console.error(`  [Remotive] Error searching "${query}":`, err.message);
    }

    await sleep(31000);
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Source 2: Jobicy (free API, no key needed, good UK coverage)
// ---------------------------------------------------------------------------
async function fetchJobicy() {
  const jobs = [];
  const seen = new Set();

  const geos = ["uk", "anywhere"];
  for (const geo of geos) {
    console.log(`  [Jobicy] Fetching geo="${geo}"...`);
    const url = `https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}`;

    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      for (const job of data.jobs || []) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);

        const title = decodeEntities(job.jobTitle || "");
        const company = decodeEntities(job.companyName || "");
        const desc = job.jobDescription || "";
        const industry = job.jobIndustry ? job.jobIndustry.join(", ") : "";

        if (!isESGRelated(title, desc, industry)) continue;

        jobs.push(enrichJob({
          id: `jobicy-${job.id}`,
          title,
          company,
          location: job.jobGeo || "Remote",
          description: desc,
          url: job.url || "",
          source: "Jobicy",
          tags: industry,
          job_type: job.jobType ? job.jobType.join(", ") : "",
          remote: 1,
          visa_sponsorship: 0,
          salary: formatJobicySalary(job),
          company_logo: job.companyLogo || null,
          posted_at: job.pubDate || NOW(),
          fetched_at: NOW(),
        }));
      }
    } catch (err) {
      console.error(`  [Jobicy] Error fetching geo="${geo}":`, err.message);
    }

    await sleep(2000);
  }

  return jobs;
}

function formatJobicySalary(job) {
  if (job.annualSalaryMin && job.annualSalaryMax) {
    const cur = job.salaryCurrency || "USD";
    return `${cur} ${Number(job.annualSalaryMin).toLocaleString()} - ${Number(job.annualSalaryMax).toLocaleString()}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source 3: Arbeitnow (visa sponsorship filter)
// ---------------------------------------------------------------------------
async function fetchArbeitnow() {
  const jobs = [];
  let page = 1;
  const maxPages = 10;

  while (page <= maxPages) {
    const url = `https://www.arbeitnow.com/api/job-board-api?visa_sponsorship=true&page=${page}`;
    console.log(`  [Arbeitnow] Fetching page ${page}...`);

    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json();
      if (!data.data || data.data.length === 0) break;

      for (const job of data.data) {
        const loc = (job.location || "").toLowerCase();
        const isLondon = loc.includes("london");
        const isUK = loc.includes("uk") || loc.includes("united kingdom") || loc.includes("england") || loc.includes("britain");
        const isRemote = job.remote === true;
        const tagsStr = (job.tags || []).join(", ");

        if (!isLondon && !isUK && !isRemote) continue;

        jobs.push(enrichJob({
          id: `arbeitnow-${job.slug}`,
          title: job.title,
          company: job.company_name,
          location: job.location || (isRemote ? "Remote" : "Unknown"),
          description: job.description || "",
          url: job.url,
          source: "Arbeitnow",
          tags: tagsStr,
          job_type: (job.job_types || []).join(", "),
          remote: isRemote ? 1 : 0,
          visa_sponsorship: 1,
          salary: null,
          company_logo: null,
          posted_at: job.created_at ? new Date(job.created_at * 1000).toISOString() : NOW(),
          fetched_at: NOW(),
        }));
      }
    } catch (err) {
      console.error(`  [Arbeitnow] Page ${page} error:`, err.message);
      break;
    }

    page++;
    await sleep(1000);
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Source 4: Reed.co.uk (optional key)
// ---------------------------------------------------------------------------
async function fetchReed(apiKey) {
  if (!apiKey) {
    console.log("  [Reed] Skipped - no API key configured");
    return [];
  }

  // Prioritised searches
  const searches = [
    "sustainability consultant", "esg analyst",
    "esg consultant", "sustainability analyst",
    "climate consulting", "environmental consultant",
    "esg advisory", "sustainability manager",
  ];
  const seen = new Set();
  const jobs = [];

  for (const query of searches) {
    console.log(`  [Reed] Searching "${query}"...`);
    const url = `https://www.reed.co.uk/api/1.0/search?keywords=${encodeURIComponent(query)}&locationName=London&distancefromlocation=15`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(apiKey + ":").toString("base64")}` },
      });
      if (!res.ok) continue;
      const data = await res.json();

      for (const job of data.results || []) {
        if (seen.has(job.jobId)) continue;
        seen.add(job.jobId);

        jobs.push(enrichJob({
          id: `reed-${job.jobId}`,
          title: job.jobTitle,
          company: job.employerName,
          location: job.locationName || "London",
          description: job.jobDescription || "",
          url: job.jobUrl,
          source: "Reed",
          tags: "",
          job_type: job.contractType || "",
          remote: 0,
          visa_sponsorship: 0,
          salary: job.minimumSalary ? `£${Number(job.minimumSalary).toLocaleString()} - £${Number(job.maximumSalary || 0).toLocaleString()}` : null,
          company_logo: null,
          posted_at: job.date || NOW(),
          fetched_at: NOW(),
        }));
      }
    } catch (err) {
      console.error(`  [Reed] Error:`, err.message);
    }

    await sleep(2000);
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Source 5: Adzuna (optional keys)
// ---------------------------------------------------------------------------
async function fetchAdzuna(appId, appKey) {
  if (!appId || !appKey) {
    console.log("  [Adzuna] Skipped - no API keys configured");
    return [];
  }

  const searches = [
    "sustainability consultant", "esg analyst",
    "esg", "climate consulting", "environmental consultant",
  ];
  const seen = new Set();
  const jobs = [];

  for (const query of searches) {
    console.log(`  [Adzuna] Searching "${query}"...`);
    const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=50&what=${encodeURIComponent(query)}&where=london&content-type=application/json`;

    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      for (const job of data.results || []) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);

        jobs.push(enrichJob({
          id: `adzuna-${job.id}`,
          title: job.title,
          company: (job.company && job.company.display_name) || "Unknown",
          location: (job.location && job.location.display_name) || "London",
          description: job.description || "",
          url: job.redirect_url,
          source: "Adzuna",
          tags: job.category ? job.category.label : "",
          job_type: job.contract_time || "",
          remote: 0,
          visa_sponsorship: 0,
          salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(job.salary_max || 0).toLocaleString()}` : null,
          company_logo: null,
          posted_at: job.created || NOW(),
          fetched_at: NOW(),
        }));
      }
    } catch (err) {
      console.error(`  [Adzuna] Error:`, err.message);
    }

    await sleep(1500);
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Source 6: GreenJobs.co.uk RSS feed
// ---------------------------------------------------------------------------
async function fetchGreenJobsRSS() {
  console.log("  [GreenJobs] Fetching RSS feed...");
  const jobs = [];

  try {
    const res = await fetch("https://www.greenjobs.co.uk/jobboard/xmlfeeds/jobfeed.asp?type=RSS", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ESGJobBoard/1.0)" },
    });
    if (!res.ok) throw new Error(`Status code ${res.status}`);
    const xml = await res.text();
    const feed = await rssParser.parseString(xml);

    for (const item of feed.items || []) {
      const title = item.title || "";
      const desc = item.contentSnippet || item.content || "";
      const loc = (desc + " " + title).toLowerCase();
      const isLondon = loc.includes("london");
      const isRemote = loc.includes("remote");

      jobs.push(enrichJob({
        id: `greenjobs-${hashString(item.link || item.title)}`,
        title,
        company: extractCompanyFromDesc(desc),
        location: isLondon ? "London" : isRemote ? "Remote" : "United Kingdom",
        description: item.content || desc,
        url: item.link || "",
        source: "GreenJobs",
        tags: "ESG, Sustainability, Environment",
        job_type: "",
        remote: isRemote ? 1 : 0,
        visa_sponsorship: 0,
        salary: null,
        company_logo: null,
        posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : NOW(),
        fetched_at: NOW(),
      }));
    }
  } catch (err) {
    console.error("  [GreenJobs] RSS error:", err.message);
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Master fetch - runs all sources, then scores
// ---------------------------------------------------------------------------
async function fetchAllJobs(config = {}) {
  console.log("\n=== Starting job fetch ===\n");

  // Step 1: Load the UK sponsor register
  await sponsor.ensureLoaded();

  const results = { total: 0, sources: {} };
  let allJobs = [];

  // Step 2: Fetch from all sources
  const sources = [
    { name: "Jobicy", fn: () => fetchJobicy() },
    { name: "Arbeitnow", fn: () => fetchArbeitnow() },
    { name: "GreenJobs", fn: () => fetchGreenJobsRSS() },
    { name: "Remotive", fn: () => fetchRemotive() },
    { name: "Reed", fn: () => fetchReed(config.reedApiKey) },
    { name: "Adzuna", fn: () => fetchAdzuna(config.adzunaAppId, config.adzunaAppKey) },
  ];

  for (const source of sources) {
    try {
      const jobs = await source.fn();
      allJobs = allJobs.concat(jobs);
      results.sources[source.name] = jobs.length;
      db.logFetch(source.name, jobs.length, "success");
      console.log(`  [${source.name}] Found ${jobs.length} jobs\n`);
    } catch (err) {
      console.error(`  [${source.name}] Failed:`, err.message);
      db.logFetch(source.name, 0, `error: ${err.message}`);
    }
  }

  // Step 3: Score all jobs (heuristic or AI)
  if (allJobs.length > 0) {
    console.log(`  [Scorer] Scoring ${allJobs.length} jobs...`);
    const scoredJobs = await scoreJobs(allJobs, config.anthropicKey);

    // Step 4: Save to database
    const count = db.upsertJobs(scoredJobs);
    results.total = count;
    console.log(`  [DB] Saved ${count} scored jobs`);

    const verified = scoredJobs.filter(j => j.verified_sponsor === 1).length;
    console.log(`  [Sponsor] ${verified} jobs from verified UK visa sponsors`);
  }

  console.log(`\n=== Fetch complete: ${results.total} total jobs ===\n`);
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function decodeEntities(str) {
  return str.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(num))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, "\u2013")
    .replace(/&#8217;/g, "\u2019");
}

function extractCompanyFromDesc(desc) {
  const match = desc.match(/(?:at|with|for|by)\s+([A-Z][A-Za-z\s&.]+?)(?:\s+in\s|\s*[,.]|\s+is\s)/);
  return match ? match[1].trim() : "See listing";
}

module.exports = { fetchAllJobs };

const fetch = require("node-fetch");
const RSSParser = require("rss-parser");
const db = require("./db");
const sponsor = require("./sponsor");
const { scoreJobs } = require("./scorer");

const NOW = () => new Date().toISOString();
const rssParser = new RSSParser();

// ---------------------------------------------------------------------------
// ESG / sustainability keywords — tiered for precision filtering
// ---------------------------------------------------------------------------

// TIER 1: Strongly ESG-specific — a single match anywhere = ESG-relevant
const ESG_STRONG = [
  "esg", "sustainability", "sustainable development", "climate change",
  "carbon", "net zero", "net-zero", "decarbonisation", "decarbonization",
  "energy transition", "circular economy", "cleantech", "ghg", "emissions",
  "sdg", "tcfd", "sfdr", "csrd", "gri reporting", "gri standards",
  "scope 1", "scope 2", "scope 3", "double materiality", "taxonomy regulation",
  "green bond", "green finance", "sustainable finance",
  "climate risk", "climate consulting", "climate adaptation", "climate mitigation",
  "esg consulting", "esg advisory", "esg analyst", "esg reporting",
  "esg communications", "sustainability communications",
  "sustainability consultant", "sustainability reporting",
  "sustainability disclosure", "non-financial reporting", "integrated reporting",
  "responsible investment", "impact investing",
  "biodiversity", "nature-based", "just transition",
  "csr", "corporate social responsibility",
  "social impact", "impact assessment",
  "b corp", "science-based targets", "sbti",
];

// TIER 2: Ambiguous — these appear in non-ESG contexts ("responsible for...", "business impact")
// Only count if they appear in the TITLE, or if 3+ appear together in the description
const ESG_WEAK = [
  "impact", "responsible", "governance", "environmental",
  "stewardship", "ethical", "purpose-driven", "stakeholder engagement",
  "renewable", "dei", "diversity equity inclusion",
  "corporate governance", "responsible business",
  "non-profit", "nonprofit", "ngo", "charity", "social enterprise",
  "ethical investment",
];

function isESGRelated(title, description, tags) {
  const titleLower = (title || "").toLowerCase();
  const allText = `${titleLower} ${(description || "").toLowerCase()} ${(tags || "").toLowerCase()}`;

  // Rule 1: Any STRONG keyword anywhere → relevant
  if (ESG_STRONG.some((kw) => allText.includes(kw))) return true;

  // Rule 2: A WEAK keyword in the TITLE → relevant (title is intentional)
  if (ESG_WEAK.some((kw) => titleLower.includes(kw))) return true;

  // Rule 3: 3+ WEAK keywords in the full text → likely ESG context
  const weakHits = ESG_WEAK.filter((kw) => allText.includes(kw));
  if (weakHits.length >= 3) return true;

  return false;
}

/**
 * Stricter ESG filter for The Muse — this source has high noise because broad
 * categories ("Business Operations", "Management") return many non-ESG roles.
 * Require at least one STRONG ESG keyword in title or tags, OR 2+ STRONG in description.
 */
function isMuseESGRelevant(title, description, tags) {
  const titleLower = (title || "").toLowerCase();
  const tagsLower = (tags || "").toLowerCase();
  const descLower = (description || "").toLowerCase();

  // Title or tags contain a strong ESG keyword → pass
  if (ESG_STRONG.some((kw) => titleLower.includes(kw) || tagsLower.includes(kw))) return true;

  // Description has 2+ strong ESG keywords → pass (confirms ESG is core to the role)
  const strongDescHits = ESG_STRONG.filter((kw) => descLower.includes(kw));
  if (strongDescHits.length >= 2) return true;

  return false;
}

/**
 * Search-based ESG filter — used for Jooble, Reed, Adzuna and other sources
 * where search queries are ESG-targeted but API snippets/descriptions may be
 * too short for the standard isESGRelated() check.
 * We trust the search context + verify the role title looks like a plausible
 * ESG/consulting/comms position.
 */
// ESG-relevant role words — narrow to consulting/comms/ESG titles
const ESG_ROLE_WORDS = /consultant|consult|advisor|advisory|analyst|communicat|report|strateg|sustainab|esg|climate|carbon|environment|csr|planner|engagement/i;

function isSearchESGRelevant(title, snippet, searchKeywords) {
  // Rule 1: Title or snippet has a strong ESG keyword → always pass
  if (isESGRelated(title, snippet, "")) return true;

  // Rule 2: The search was ESG-targeted AND the title contains an ESG-adjacent
  // role word (consulting, analyst, communications, etc.) → trust the search
  const searchHasESG = ESG_STRONG.some((kw) => searchKeywords.toLowerCase().includes(kw));
  if (searchHasESG && ESG_ROLE_WORDS.test(title)) return true;

  return false;
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
    console.log("  [Reed] Skipped - no API key configured (get one free at reed.co.uk/developers)");
    return [];
  }

  // Prioritised searches — ESG consulting + communications focus
  const searches = [
    "sustainability consultant", "esg analyst",
    "esg consultant", "sustainability analyst",
    "climate consulting", "environmental consultant",
    "esg advisory", "sustainability manager",
    "sustainability communications", "ESG communications",
    "sustainability reporting", "CSR communications",
    "carbon consultant", "net zero consultant",
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
      if (!res.ok) {
        console.error(`  [Reed] HTTP ${res.status} for "${query}"`);
        continue;
      }
      const data = await res.json();

      for (const job of data.results || []) {
        if (seen.has(job.jobId)) continue;
        seen.add(job.jobId);

        const title = job.jobTitle || "";
        const desc = job.jobDescription || "";

        // ESG relevance check — searches are targeted but Reed can return
        // broad matches (e.g. "consultant" matching non-ESG consulting roles)
        if (!isSearchESGRelevant(title, desc, query)) continue;

        jobs.push(enrichJob({
          id: `reed-${job.jobId}`,
          title,
          company: job.employerName,
          location: job.locationName || "London",
          description: desc,
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

      console.log(`  [Reed] "${query}": ${(data.results || []).length} raw → ${jobs.length} total kept`);
    } catch (err) {
      console.error(`  [Reed] Error for "${query}":`, err.message);
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
    console.log("  [Adzuna] Skipped - no API keys configured (get free keys at developer.adzuna.com)");
    return [];
  }

  // Prioritised searches — ESG consulting + communications focus
  const searches = [
    "sustainability consultant", "esg analyst",
    "esg consultant", "sustainability analyst",
    "esg", "climate consulting", "environmental consultant",
    "sustainability communications", "ESG communications",
    "sustainability reporting", "carbon consultant",
    "CSR consultant", "net zero",
  ];
  const seen = new Set();
  const jobs = [];

  for (const query of searches) {
    console.log(`  [Adzuna] Searching "${query}"...`);
    const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=50&what=${encodeURIComponent(query)}&where=london&content-type=application/json`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  [Adzuna] HTTP ${res.status} for "${query}"`);
        continue;
      }
      const data = await res.json();

      for (const job of data.results || []) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);

        const title = job.title || "";
        const desc = job.description || "";
        const catLabel = job.category ? job.category.label : "";

        // ESG relevance check — searches are targeted but Adzuna can return
        // broad matches. Use same trust filter as Jooble/Reed.
        if (!isSearchESGRelevant(title, desc + " " + catLabel, query)) continue;

        jobs.push(enrichJob({
          id: `adzuna-${job.id}`,
          title,
          company: (job.company && job.company.display_name) || "Unknown",
          location: (job.location && job.location.display_name) || "London",
          description: desc,
          url: job.redirect_url,
          source: "Adzuna",
          tags: catLabel,
          job_type: job.contract_time || "",
          remote: 0,
          visa_sponsorship: 0,
          salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(job.salary_max || 0).toLocaleString()}` : null,
          company_logo: null,
          posted_at: job.created || NOW(),
          fetched_at: NOW(),
        }));
      }

      console.log(`  [Adzuna] "${query}": ${(data.results || []).length} raw → ${jobs.length} total kept`);
    } catch (err) {
      console.error(`  [Adzuna] Error for "${query}":`, err.message);
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
// Source 7: Jooble (aggregator — indexes LinkedIn, Indeed, Glassdoor & 70+ boards)
//   Requires free API key from https://jooble.org/api/about
// ---------------------------------------------------------------------------
async function fetchJooble(apiKey) {
  if (!apiKey) {
    console.log("  [Jooble] Skipped - no API key configured (get one free at jooble.org/api/about)");
    return [];
  }

  const searches = [
    { keywords: "sustainability consultant", location: "London" },
    { keywords: "ESG analyst", location: "London" },
    { keywords: "ESG consultant", location: "London" },
    { keywords: "sustainability analyst", location: "London" },
    { keywords: "climate consulting", location: "London" },
    { keywords: "environmental consultant", location: "London" },
    { keywords: "sustainability communications", location: "London" },
    { keywords: "ESG communications", location: "London" },
    { keywords: "sustainability reporting", location: "London" },
    { keywords: "sustainability manager", location: "United Kingdom" },
    { keywords: "ESG advisory", location: "United Kingdom" },
    { keywords: "CSR communications", location: "United Kingdom" },
  ];

  const seen = new Set();
  const jobs = [];

  for (const search of searches) {
    console.log(`  [Jooble] Searching "${search.keywords}" in ${search.location}...`);
    const url = `https://jooble.org/api/${apiKey}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: search.keywords,
          location: search.location,
          page: 1,
          ResultOnPage: 50,
        }),
      });

      if (!res.ok) {
        console.error(`  [Jooble] HTTP ${res.status} for "${search.keywords}"`);
        continue;
      }

      const data = await res.json();

      for (const job of data.jobs || []) {
        const jobKey = job.id || hashString(job.link || job.title + job.company);
        if (seen.has(jobKey)) continue;
        seen.add(jobKey);

        const loc = (job.location || "").toLowerCase();
        const isLondon = loc.includes("london");
        const isUK = loc.includes("uk") || loc.includes("united kingdom") || loc.includes("england");
        const isRemote = loc.includes("remote");

        // Jooble aggregates broadly — filter by location AND ESG relevance
        if (!isLondon && !isUK && !isRemote) continue;

        const title = (job.title || "").replace(/<[^>]*>/g, "").trim();
        const snippet = (job.snippet || "").replace(/<[^>]*>/g, "").trim();

        // Jooble-specific ESG check: snippets are short so we combine
        // standard ESG check with search-keyword trust for relevant role titles
        if (!isSearchESGRelevant(title, snippet, search.keywords)) continue;

        jobs.push(enrichJob({
          id: `jooble-${jobKey}`,
          title,
          company: job.company || "See listing",
          location: job.location || search.location,
          description: snippet,
          url: job.link || "",
          source: "Jooble",
          tags: "",
          job_type: job.type || "",
          remote: isRemote ? 1 : 0,
          visa_sponsorship: 0,
          salary: job.salary || null,
          company_logo: null,
          posted_at: job.updated || NOW(),
          fetched_at: NOW(),
        }));
      }

      console.log(`  [Jooble] "${search.keywords}": ${(data.jobs || []).length} raw → ${jobs.length} total kept`);
    } catch (err) {
      console.error(`  [Jooble] Error for "${search.keywords}":`, err.message);
    }

    await sleep(1500);
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Source 8: The Muse (professional/consulting roles, strong brand coverage)
//   Free API — no key required (500 req/hr), optional key for 3600 req/hr
// ---------------------------------------------------------------------------
async function fetchMuse(apiKey) {
  // The Muse has no ESG/sustainability category, so we fetch from relevant
  // categories in London, then keyword-filter for ESG relevance.
  // We use a STRICT title check for broad categories to avoid noise.
  const categories = [
    "Business Operations",
    "Science and Engineering",
    "Data and Analytics",
    "Management",
    "Corporate",
    "Project Management",
    "Communications",
    "Marketing and PR",
  ];

  const seen = new Set();
  const jobs = [];

  // Strategy 1: Fetch London jobs from each category
  for (const category of categories) {
    const params = new URLSearchParams({
      page: "0",
      location: "London, United Kingdom",
      category: category,
    });
    if (apiKey) params.set("api_key", apiKey);

    console.log(`  [Muse] Fetching "${category}" in London...`);
    const url = `https://www.themuse.com/api/public/jobs?${params}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  [Muse] HTTP ${res.status} for "${category}"`);
        continue;
      }
      const data = await res.json();

      for (const job of data.results || []) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);

        const title = job.name || "";
        const desc = job.contents || "";
        const company = job.company ? job.company.name : "Unknown";
        const catNames = (job.categories || []).map(c => c.name).join(", ");
        const locations = (job.locations || []).map(l => l.name).join(", ");

        // Strict ESG relevance for The Muse — require title-level signal
        // or strong ESG match (not just weak desc keywords like "impact")
        if (!isMuseESGRelevant(title, desc, catNames)) continue;

        jobs.push(enrichJob({
          id: `muse-${job.id}`,
          title,
          company,
          location: locations || "London, United Kingdom",
          description: desc,
          url: (job.refs && job.refs.landing_page) || "",
          source: "The Muse",
          tags: catNames,
          job_type: (job.levels || []).map(l => l.name).join(", "),
          remote: locations.toLowerCase().includes("remote") ? 1 : 0,
          visa_sponsorship: 0,
          salary: null,
          company_logo: null,
          posted_at: job.publication_date || NOW(),
          fetched_at: NOW(),
        }));
      }
    } catch (err) {
      console.error(`  [Muse] Error for "${category}":`, err.message);
    }

    await sleep(1200);
  }

  // Strategy 2: Also fetch "Flexible / Remote" location for broader reach
  for (const category of ["Business Operations", "Science and Engineering", "Management", "Communications"]) {
    const params = new URLSearchParams({
      page: "0",
      location: "Flexible / Remote",
      category: category,
    });
    if (apiKey) params.set("api_key", apiKey);

    console.log(`  [Muse] Fetching "${category}" remote...`);
    const url = `https://www.themuse.com/api/public/jobs?${params}`;

    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      for (const job of data.results || []) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);

        const title = job.name || "";
        const desc = job.contents || "";
        const company = job.company ? job.company.name : "Unknown";
        const catNames = (job.categories || []).map(c => c.name).join(", ");
        const locations = (job.locations || []).map(l => l.name).join(", ");

        if (!isMuseESGRelevant(title, desc, catNames)) continue;

        jobs.push(enrichJob({
          id: `muse-${job.id}`,
          title,
          company,
          location: locations || "Remote",
          description: desc,
          url: (job.refs && job.refs.landing_page) || "",
          source: "The Muse",
          tags: catNames,
          job_type: (job.levels || []).map(l => l.name).join(", "),
          remote: 1,
          visa_sponsorship: 0,
          salary: null,
          company_logo: null,
          posted_at: job.publication_date || NOW(),
          fetched_at: NOW(),
        }));
      }
    } catch (err) {
      console.error(`  [Muse] Error remote "${category}":`, err.message);
    }

    await sleep(1200);
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
    { name: "Jooble", fn: () => fetchJooble(config.joobleApiKey) },
    { name: "The Muse", fn: () => fetchMuse(config.museApiKey) },
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

    // Step 3b: Quality gate — drop jobs with zero relevance score
    // These passed the keyword filter but scored 0 on the heuristic (no ESG
    // title match, no ESG depth terms, no consulting context). Keeping them
    // would dilute the board with noise.
    const MIN_SCORE = 3;
    const qualityJobs = scoredJobs.filter(j => j.match_score >= MIN_SCORE);
    const dropped = scoredJobs.length - qualityJobs.length;
    if (dropped > 0) {
      console.log(`  [Quality] Dropped ${dropped} jobs scoring below ${MIN_SCORE} (not ESG-relevant)`);
    }

    // Step 4: Save to database
    const count = db.upsertJobs(qualityJobs);
    results.total = count;
    console.log(`  [DB] Saved ${count} scored jobs`);

    const verified = qualityJobs.filter(j => j.verified_sponsor === 1).length;
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

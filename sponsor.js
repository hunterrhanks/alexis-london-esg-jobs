// ============================================================
// UK Government Register of Licensed Sponsors
// Downloads and caches the official CSV, builds a fast lookup
// ============================================================

const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const CACHE_PATH = path.join(DATA_DIR, "sponsor_cache.json");
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

// GOV.UK publication page - we extract the latest CSV URL from here
const GOV_PAGE = "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers";

// Direct CSV (fallback - this URL changes when gov.uk publishes updates)
const FALLBACK_CSV = "https://assets.publishing.service.gov.uk/media/6998222ba58a315dbe72c06e/2026-02-20_-_Worker_and_Temporary_Worker.csv";

let sponsorSet = null; // Set of normalised company names
let sponsorMap = null; // Map: normalised name -> { name, city, rating, route }

// Common abbreviations → official register names (will be normalised at lookup time)
const ALIASES = {
  "pwc": "PricewaterhouseCoopers LLP",
  "ey": "Ernst & Young LLP",
  "bain": "Bain & Company",
  "wsp": "WSP Group Limited",
  "arup": "Ove Arup & Partners International Limited",
  "mott macdonald": "Mott MacDonald Limited",
  "mckinsey": "McKinsey & Company Inc. United Kingdom",
  "bcg": "The Boston Consulting Group UK LLP",
};

/**
 * Normalise a company name for fuzzy matching.
 * Strips Ltd/Limited/LLP/PLC/Inc, lowercases, collapses whitespace.
 */
function normalise(name) {
  return name
    .toLowerCase()
    .replace(/[""'']/g, "")
    .replace(/\b(ltd|limited|llp|plc|inc|corp|corporation|gmbh|ag|group|holdings|uk)\b/gi, "")
    .replace(/[^a-z0-9\s&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the GOV.UK Sponsor Register CSV into a Map.
 * CSV format: "Organisation Name","Town/City","County","Type & Rating","Route"
 */
function parseCSV(raw) {
  const map = new Map();
  const lines = raw.split("\n");

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parser for this specific format (quoted fields with commas)
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        if (inQuotes && c + 1 < line.length && line[c + 1] === '"') {
          current += '"';
          c++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());

    const orgName = fields[0] || "";
    const city = fields[1] || "";
    const rating = fields[3] || "";
    const route = fields[4] || "";

    if (!orgName) continue;

    const key = normalise(orgName);
    if (!key) continue;

    // Only keep Skilled Worker route entries (most relevant for ESG roles)
    // But store all for completeness
    if (!map.has(key)) {
      map.set(key, {
        name: orgName,
        city,
        rating: rating.includes("A rating") ? "A" : rating.includes("B rating") ? "B" : "Unknown",
        routes: [route],
      });
    } else {
      const existing = map.get(key);
      if (!existing.routes.includes(route)) {
        existing.routes.push(route);
      }
    }
  }

  return map;
}

/**
 * Download the sponsor register CSV from GOV.UK.
 */
async function downloadRegister() {
  console.log("  [Sponsor] Downloading UK Sponsor Register...");

  try {
    const res = await fetch(FALLBACK_CSV, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ESGJobBoard/1.0)" },
      timeout: 60000,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    console.log(`  [Sponsor] Downloaded ${(csv.length / 1024 / 1024).toFixed(1)} MB`);
    return csv;
  } catch (err) {
    console.error("  [Sponsor] Download failed:", err.message);
    return null;
  }
}

/**
 * Load the sponsor register, using a file cache to avoid re-downloading.
 */
async function loadSponsorRegister() {
  // Check if we have a recent cache
  if (fs.existsSync(CACHE_PATH)) {
    try {
      const stat = fs.statSync(CACHE_PATH);
      const age = Date.now() - stat.mtimeMs;
      if (age < CACHE_MAX_AGE_MS) {
        const cached = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
        sponsorMap = new Map(cached.entries);
        sponsorSet = new Set(cached.entries.map(([k]) => k));
        console.log(`  [Sponsor] Loaded ${sponsorMap.size} sponsors from cache`);
        return;
      }
    } catch (err) {
      console.error("  [Sponsor] Cache read error:", err.message);
    }
  }

  // Download fresh
  const csv = await downloadRegister();
  if (!csv) {
    sponsorMap = new Map();
    sponsorSet = new Set();
    return;
  }

  sponsorMap = parseCSV(csv);
  sponsorSet = new Set(sponsorMap.keys());

  // Cache to file
  try {
    const cacheData = { entries: [...sponsorMap.entries()], updatedAt: new Date().toISOString() };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData));
    console.log(`  [Sponsor] Cached ${sponsorMap.size} sponsors to disk`);
  } catch (err) {
    console.error("  [Sponsor] Cache write error:", err.message);
  }
}

// Generic/placeholder company names that should never match the sponsor register
const GENERIC_COMPANY_NAMES = new Set([
  "unknown", "see listing", "confidential", "not disclosed",
  "anonymous", "various", "multiple", "tbc", "tba",
  "not specified", "undisclosed", "company", "employer",
  "hiring company", "top company", "leading company",
]);

/**
 * Check if a company name appears in the sponsor register.
 * Returns { verified, rating, routes } or { verified: false }.
 */
function checkSponsor(companyName) {
  if (!sponsorSet || !companyName) return { verified: false };

  let key = normalise(companyName);
  if (!key) return { verified: false };

  // Skip generic/placeholder company names (e.g. Adzuna "Unknown")
  if (GENERIC_COMPANY_NAMES.has(key)) return { verified: false };

  // Check alias map first (e.g. "PwC" → "pricewaterhousecoopers")
  if (ALIASES[key]) {
    key = normalise(ALIASES[key]);
  }

  // Exact match
  if (sponsorMap.has(key)) {
    const entry = sponsorMap.get(key);
    return {
      verified: true,
      rating: entry.rating,
      routes: entry.routes,
      officialName: entry.name,
    };
  }

  // Partial match: require the shorter name to be at least 60% of the longer name's length
  // to avoid false positives like "arup" matching "santharupan"
  if (key.length >= 5) {
    for (const [sponsorKey, entry] of sponsorMap) {
      if (sponsorKey.length >= 5) {
        const shorter = key.length <= sponsorKey.length ? key : sponsorKey;
        const longer = key.length > sponsorKey.length ? key : sponsorKey;
        if (shorter.length / longer.length >= 0.5 && (longer.includes(shorter))) {
          return {
            verified: true,
            rating: entry.rating,
            routes: entry.routes,
            officialName: entry.name,
            fuzzyMatch: true,
          };
        }
      }
    }
  }

  return { verified: false };
}

/**
 * Ensure the register is loaded (lazy init).
 */
async function ensureLoaded() {
  if (!sponsorSet) {
    await loadSponsorRegister();
  }
}

module.exports = { loadSponsorRegister, checkSponsor, ensureLoaded, normalise };

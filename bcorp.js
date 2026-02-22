// ============================================================
// B Corporation Directory — V4.0
// Cross-references companies against UK B Corp directory.
// If a company is both a B Corp AND a Verified Sponsor,
// the job earns a "Golden Opportunity" badge.
// ============================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const BCORP_CACHE = path.join(DATA_DIR, "bcorp_cache.json");
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

let bcorpSet = null;

// Normalise company name for matching (mirrors sponsor.js logic)
function normalise(name) {
  return name
    .toLowerCase()
    .replace(/["\u201C\u201D'\u2018\u2019]/g, "")
    .replace(/\b(ltd|limited|llp|plc|inc|corp|corporation|gmbh|ag|group|holdings|uk)\b/gi, "")
    .replace(/[^a-z0-9\s&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// UK B Corporation Directory (curated, updated February 2026)
//
// Certified B Corps operating in the UK, focusing on sectors relevant to
// ESG job searches: consulting, finance, energy, communications, and
// professional services. The B Corp certification is verified by B Lab.
//
// To update: check https://www.bcorporation.net/en-us/find-a-b-corp/
// ---------------------------------------------------------------------------
const UK_BCORPS = [
  // ---- Sustainability Consulting & Advisory ----
  "Anthesis Group", "Anthesis",
  "Corporate Citizenship",
  "Futerra", "Futerra Sustainability Communications",
  "Salterbaxter",
  "Article 13",
  "Eunomia Research & Consulting", "Eunomia",
  "BioRegional", "Bioregional Development Group",
  "Carbon Intelligence",
  "Greenstone",
  "South Pole", "South Pole Group",
  "Volans",
  "SystemIQ",
  "Julie's Bicycle",
  "Ashden",
  "Plan Vivo",
  "Global Action Plan",
  "Change by Degrees",
  "Carnstone Partners", "Carnstone",
  "Sancroft International", "Sancroft",
  "Ricardo", "Ricardo Energy & Environment",
  "Cundall", "Cundall Johnston & Partners",
  "Elementa Consulting", "Elementa",
  "Hoare Lea",
  "Useful Simple Projects",
  "Metabolic",
  "Avieco",
  "Forum for the Future",
  "BSR",
  "The Good Economy",
  "Turley",
  "Thirdway",
  "Temple Group",
  "Action Sustainability",
  "Greenomy",
  "Longevity Partners",
  "Accenture Development Partnerships",

  // ---- Communications, Design & Creative ----
  "Seismic",
  "Radley Yeldar",
  "Context", "Context Group",
  "Flag",
  "The Crowd",
  "Leap Design",
  "Wholegrain Digital",
  "Reason Digital",
  "Torchbox",
  "Do Nation",
  "Positive News",
  "Don't Cry Wolf",
  "Fieldcraft Studios",
  "Nice and Serious",

  // ---- Financial Services & Impact Investment ----
  "Triodos Bank", "Triodos",
  "EQ Investors",
  "Abundance Investment", "Abundance",
  "Castlefield",
  "Big Issue Invest",
  "Bridges Fund Management", "Bridges Ventures",
  "Finance Earth",
  "Social Finance",
  "Big Society Capital",
  "Ethex",
  "Impax Asset Management", "Impax",
  "Wheb Asset Management", "WHEB",
  "Shared Interest",

  // ---- Energy & Utilities ----
  "Good Energy",
  "Octopus Energy",
  "OVO Energy",
  "Ecotricity",
  "Bulb", "Bulb Energy",
  "Ripple Energy",
  "Pure Planet",

  // ---- Built Environment & Engineering ----
  "Willmott Dixon",
  "Max Fordham",
  "Buro Happold",
  "Igloo Regeneration",
  "Expedition Engineering",
  "Architype",
  "Feilden Clegg Bradley Studios",

  // ---- Recruitment & HR ----
  "Acre", "Acre Resources",
  "Allen & York",
  "Escape the City",
  "Bruntwood",

  // ---- Consumer, Food & Retail ----
  "innocent", "innocent drinks",
  "The Body Shop",
  "Patagonia",
  "Cook Trading", "COOK",
  "Abel & Cole",
  "Pukka Herbs",
  "Ella's Kitchen",
  "Danone", "Danone UK",
  "Ben & Jerry's",
  "Tony's Chocolonely",
  "Lush", "Lush Cosmetics",
  "Fairphone",
  "Toast Ale",
  "Oddbox",
  "Riverford",
  "The Big Issue",
  "Who Gives A Crap",
  "Allbirds",
  "Divine Chocolate",
  "Cafedirect",
  "Traidcraft",

  // ---- Tech & Software ----
  "Ecosia",
  "Provenance",
  "Wagestream",
  "Social Value Portal",
  "OpenCorporates",
  "CoGo",
  "Goodbox",

  // ---- Media ----
  "Guardian Media Group", "The Guardian",
  "Ethical Consumer",
  "Green Building Press",

  // ---- Other Notable UK B Corps ----
  "Nourish",
  "Social Enterprise UK",
  "UnLtd",
  "Power to Change",
  "Interface",
  "Naturesave Insurance",
  "Green Building Store",
  "Suma Wholefoods", "Suma",
  "Better Food",
  "Pact Coffee",
  "graze",
];

// ---------------------------------------------------------------------------
// Load / cache
// ---------------------------------------------------------------------------
async function loadBCorpDirectory() {
  // Check cache
  if (fs.existsSync(BCORP_CACHE)) {
    try {
      const stat = fs.statSync(BCORP_CACHE);
      if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE) {
        const cached = JSON.parse(fs.readFileSync(BCORP_CACHE, "utf-8"));
        bcorpSet = new Set(cached.names.map((n) => normalise(n)));
        console.log(`  [BCorp] Loaded ${bcorpSet.size} B Corps from cache`);
        return;
      }
    } catch (err) {
      console.error("  [BCorp] Cache read error:", err.message);
    }
  }

  // Use the embedded directory
  console.log("  [BCorp] Loading UK B Corp directory...");
  bcorpSet = new Set(UK_BCORPS.map((n) => normalise(n)));

  // Cache to disk
  try {
    fs.writeFileSync(
      BCORP_CACHE,
      JSON.stringify({
        names: UK_BCORPS,
        updatedAt: new Date().toISOString(),
        count: bcorpSet.size,
      })
    );
    console.log(`  [BCorp] Loaded ${bcorpSet.size} UK B Corps`);
  } catch (err) {
    console.error("  [BCorp] Cache write error:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Check if a company is a certified B Corp
// ---------------------------------------------------------------------------
function checkBCorp(companyName) {
  if (!bcorpSet || !companyName) return false;

  const key = normalise(companyName);
  if (!key || key.length < 3) return false;

  // Exact normalised match
  if (bcorpSet.has(key)) return true;

  // Partial match: shorter name contained in longer, with 60% length ratio
  if (key.length >= 5) {
    for (const bcKey of bcorpSet) {
      if (bcKey.length >= 5) {
        const shorter = key.length <= bcKey.length ? key : bcKey;
        const longer = key.length > bcKey.length ? key : bcKey;
        if (shorter.length / longer.length >= 0.6 && longer.includes(shorter)) {
          return true;
        }
      }
    }
  }

  return false;
}

async function ensureLoaded() {
  if (!bcorpSet) {
    await loadBCorpDirectory();
  }
}

module.exports = { checkBCorp, ensureLoaded };

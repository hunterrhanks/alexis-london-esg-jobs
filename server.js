require("dotenv").config();
const express = require("express");
const path = require("path");
const cron = require("node-cron");
const db = require("./db");
const { fetchAllJobs } = require("./fetcher");
const { sendDailyDigest } = require("./mailer");
const { generateOutreachKit, SOC_GOING_RATES, GENERAL_THRESHOLD } = require("./scorer");

const app = express();
const PORT = process.env.PORT || 3000;

// Load optional API keys from environment
const config = {
  reedApiKey: process.env.REED_API_KEY || null,
  adzunaAppId: process.env.ADZUNA_APP_ID || null,
  adzunaAppKey: process.env.ADZUNA_APP_KEY || null,
  anthropicKey: process.env.ANTHROPIC_API_KEY || null,
  joobleApiKey: process.env.JOOBLE_API_KEY || null,
  museApiKey: process.env.MUSE_API_KEY || null,
};

// Initialize database
db.initialize();

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---- API Routes ----

// Get jobs with search/filter/pagination
app.get("/api/jobs", (req, res) => {
  try {
    const { search, source, remote, saved, sponsorOnly, sort, page, limit, status, visaConfidence } = req.query;
    const result = db.getJobs({
      search,
      source,
      remote,
      saved,
      sponsorOnly,
      sort: sort || "score",
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
      visaConfidence,
    });
    res.json(result);
  } catch (err) {
    console.error("GET /api/jobs error:", err);
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

// Toggle save/bookmark a job
app.post("/api/jobs/:id/save", (req, res) => {
  try {
    const saved = db.toggleSave(req.params.id);
    res.json({ saved });
  } catch (err) {
    console.error("POST /api/jobs/:id/save error:", err);
    res.status(500).json({ error: "Failed to toggle save" });
  }
});

// Get dashboard stats
app.get("/api/stats", (req, res) => {
  try {
    const stats = db.getStats();
    res.json(stats);
  } catch (err) {
    console.error("GET /api/stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Trigger a manual refresh
app.post("/api/refresh", async (req, res) => {
  try {
    console.log("Manual refresh triggered");
    const results = await fetchAllJobs(config);
    res.json({ message: "Refresh complete", results });
  } catch (err) {
    console.error("POST /api/refresh error:", err);
    res.status(500).json({ error: "Refresh failed" });
  }
});

// ---- V3.0: CRM Endpoints ----

// Update job application status
app.post("/api/jobs/:id/status", (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status is required" });
    const updated = db.updateStatus(req.params.id, status);
    if (updated === null) return res.status(404).json({ error: "Job not found" });
    res.json({ status: updated });
  } catch (err) {
    console.error("POST /api/jobs/:id/status error:", err);
    res.status(400).json({ error: err.message });
  }
});

// Update job notes
app.post("/api/jobs/:id/notes", (req, res) => {
  try {
    const { notes } = req.body;
    const updated = db.updateNotes(req.params.id, notes || "");
    if (updated === null) return res.status(404).json({ error: "Job not found" });
    res.json({ notes: updated });
  } catch (err) {
    console.error("POST /api/jobs/:id/notes error:", err);
    res.status(500).json({ error: "Failed to update notes" });
  }
});

// Generate AI outreach kit for a job
app.post("/api/jobs/:id/outreach-kit", async (req, res) => {
  try {
    const job = db.getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const kit = await generateOutreachKit(job, config.anthropicKey);
    res.json(kit);
  } catch (err) {
    console.error("POST /api/jobs/:id/outreach-kit error:", err);
    res.status(500).json({ error: "Failed to generate outreach kit" });
  }
});

// Get visa intelligence data (SOC rates, thresholds)
app.get("/api/visa-intel", (req, res) => {
  res.json({
    generalThreshold: GENERAL_THRESHOLD,
    socRates: SOC_GOING_RATES,
  });
});

// ---- Daily Scheduled Fetch (6:00 AM London time) ----
cron.schedule("0 6 * * *", async () => {
  console.log(`\n[CRON] Daily fetch at ${new Date().toISOString()}`);
  try {
    await fetchAllJobs(config);
    // Send daily digest email after fetch completes
    await sendDailyDigest();
  } catch (err) {
    console.error("[CRON] Daily fetch failed:", err);
  }
}, {
  timezone: "Europe/London",
});

// ---- Start Server ----
app.listen(PORT, async () => {
  console.log(`\n  Alexis London ESG Job Board V4.0 running at http://localhost:${PORT}\n`);

  // Fetch jobs on first startup if database is empty
  const stats = db.getStats();
  if (stats.total === 0) {
    console.log("  Database empty - running initial job fetch...");
    await fetchAllJobs(config);
  }
});

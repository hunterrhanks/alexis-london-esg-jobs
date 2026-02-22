const Database = require("better-sqlite3");
const path = require("path");

// DATA_DIR allows Render (or other hosts) to point at a persistent disk
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "jobs.db");

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  return db;
}

function initialize() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT,
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      tags TEXT,
      job_type TEXT,
      remote INTEGER DEFAULT 0,
      visa_sponsorship INTEGER DEFAULT 0,
      salary TEXT,
      company_logo TEXT,
      posted_at TEXT,
      fetched_at TEXT NOT NULL,
      saved INTEGER DEFAULT 0,
      verified_sponsor INTEGER DEFAULT 0,
      sponsor_rating TEXT,
      match_score INTEGER DEFAULT 0,
      ai_summary TEXT,
      role_priority INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
    CREATE INDEX IF NOT EXISTS idx_jobs_saved ON jobs(saved);
    CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(match_score DESC);

    CREATE TABLE IF NOT EXISTS fetch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      job_count INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);

  // Migrate: add new columns if they don't exist yet (safe for existing DBs)
  const columns = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  const migrations = [
    ["verified_sponsor", "ALTER TABLE jobs ADD COLUMN verified_sponsor INTEGER DEFAULT 0"],
    ["sponsor_rating", "ALTER TABLE jobs ADD COLUMN sponsor_rating TEXT"],
    ["match_score", "ALTER TABLE jobs ADD COLUMN match_score INTEGER DEFAULT 0"],
    ["ai_summary", "ALTER TABLE jobs ADD COLUMN ai_summary TEXT"],
    ["role_priority", "ALTER TABLE jobs ADD COLUMN role_priority INTEGER DEFAULT 0"],
    // V3.0 migrations
    ["status", "ALTER TABLE jobs ADD COLUMN status TEXT DEFAULT 'new'"],
    ["notes", "ALTER TABLE jobs ADD COLUMN notes TEXT"],
    ["soc_code", "ALTER TABLE jobs ADD COLUMN soc_code TEXT"],
    ["salary_num", "ALTER TABLE jobs ADD COLUMN salary_num INTEGER"],
    ["visa_confidence", "ALTER TABLE jobs ADD COLUMN visa_confidence TEXT DEFAULT 'unknown'"],
    ["success_probability", "ALTER TABLE jobs ADD COLUMN success_probability INTEGER DEFAULT 0"],
    // V4.0 migrations
    ["is_bcorp", "ALTER TABLE jobs ADD COLUMN is_bcorp INTEGER DEFAULT 0"],
  ];
  for (const [col, sql] of migrations) {
    if (!columns.includes(col)) {
      db.exec(sql);
      console.log(`  [DB] Migrated: added column "${col}"`);
    }
  }

  // Ensure the score index exists
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(match_score DESC)");
  } catch (e) { /* already exists */ }

  db.close();
}

function upsertJobs(jobs) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO jobs (
      id, title, company, location, description, url, source, tags,
      job_type, remote, visa_sponsorship, salary, company_logo,
      posted_at, fetched_at, verified_sponsor, sponsor_rating,
      match_score, ai_summary, role_priority,
      status, notes, soc_code, salary_num, visa_confidence, success_probability,
      is_bcorp
    ) VALUES (
      @id, @title, @company, @location, @description, @url, @source, @tags,
      @job_type, @remote, @visa_sponsorship, @salary, @company_logo,
      @posted_at, @fetched_at, @verified_sponsor, @sponsor_rating,
      @match_score, @ai_summary, @role_priority,
      COALESCE((SELECT status FROM jobs WHERE id = @id), @status),
      COALESCE((SELECT notes FROM jobs WHERE id = @id), @notes),
      @soc_code, @salary_num, @visa_confidence, @success_probability,
      @is_bcorp
    )
  `);

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run({
        id: row.id,
        title: row.title,
        company: row.company,
        location: row.location,
        description: row.description,
        url: row.url,
        source: row.source,
        tags: row.tags,
        job_type: row.job_type,
        remote: row.remote,
        visa_sponsorship: row.visa_sponsorship,
        salary: row.salary,
        company_logo: row.company_logo,
        posted_at: row.posted_at,
        fetched_at: row.fetched_at,
        verified_sponsor: row.verified_sponsor || 0,
        sponsor_rating: row.sponsor_rating || null,
        match_score: row.match_score || 0,
        ai_summary: row.ai_summary || null,
        role_priority: row.role_priority || 0,
        status: row.status || "new",
        notes: row.notes || null,
        soc_code: row.soc_code || null,
        salary_num: row.salary_num || null,
        visa_confidence: row.visa_confidence || "unknown",
        success_probability: row.success_probability || 0,
        is_bcorp: row.is_bcorp || 0,
      });
    }
  });

  tx(jobs);
  db.close();
  return jobs.length;
}

function getJobs({ search, source, remote, saved, sponsorOnly, sort, page, limit, status, visaConfidence }) {
  const db = getDb();
  const conditions = [];
  const params = {};

  if (search) {
    conditions.push("(title LIKE @search OR company LIKE @search OR description LIKE @search OR tags LIKE @search)");
    params.search = `%${search}%`;
  }

  if (source && source !== "all") {
    conditions.push("source = @source");
    params.source = source;
  }

  if (remote === "true") {
    conditions.push("remote = 1");
  }

  if (saved === "true") {
    conditions.push("saved = 1");
  }

  if (sponsorOnly === "true") {
    conditions.push("verified_sponsor = 1");
  }

  if (status && status !== "all") {
    conditions.push("status = @status");
    params.status = status;
  }

  if (visaConfidence && visaConfidence !== "all") {
    conditions.push("visa_confidence = @visaConfidence");
    params.visaConfidence = visaConfidence;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  let orderBy = "match_score DESC, posted_at DESC"; // default: sort by score
  if (sort === "date") orderBy = "posted_at DESC";
  if (sort === "company") orderBy = "company ASC";
  if (sort === "title") orderBy = "title ASC";
  if (sort === "score") orderBy = "match_score DESC, posted_at DESC";
  if (sort === "visa") orderBy = "visa_confidence ASC, match_score DESC";
  if (sort === "probability") orderBy = "success_probability DESC, match_score DESC";

  const offset = ((page || 1) - 1) * (limit || 20);
  const lim = limit || 20;

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM jobs ${where}`).get(params);
  const rows = db.prepare(`SELECT * FROM jobs ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`).all({
    ...params,
    limit: lim,
    offset,
  });

  db.close();
  return { jobs: rows, total: countRow.total, page: page || 1, limit: lim };
}

function toggleSave(jobId) {
  const db = getDb();
  db.prepare("UPDATE jobs SET saved = CASE WHEN saved = 1 THEN 0 ELSE 1 END WHERE id = @id").run({ id: jobId });
  const row = db.prepare("SELECT saved FROM jobs WHERE id = @id").get({ id: jobId });
  db.close();
  return row ? row.saved : 0;
}

/**
 * Get top N new jobs by match score, fetched in the last 24h.
 * Used for the daily email digest.
 */
function getTopNewJobs(n = 5) {
  const db = getDb();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM jobs
    WHERE fetched_at >= @cutoff
    ORDER BY match_score DESC, posted_at DESC
    LIMIT @n
  `).all({ cutoff, n });
  db.close();
  return rows;
}

function logFetch(source, jobCount, status) {
  const db = getDb();
  db.prepare("INSERT INTO fetch_log (source, fetched_at, job_count, status) VALUES (@source, @fetched_at, @job_count, @status)").run({
    source,
    fetched_at: new Date().toISOString(),
    job_count: jobCount,
    status,
  });
  db.close();
}

// ---- V3.0: CRM Functions ----

const VALID_STATUSES = ["new", "to_apply", "applied", "interviewing", "offer", "rejected", "archived"];

function updateStatus(jobId, status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  const db = getDb();
  db.prepare("UPDATE jobs SET status = @status WHERE id = @id").run({ id: jobId, status });
  const row = db.prepare("SELECT status FROM jobs WHERE id = @id").get({ id: jobId });
  db.close();
  return row ? row.status : null;
}

function updateNotes(jobId, notes) {
  const db = getDb();
  db.prepare("UPDATE jobs SET notes = @notes WHERE id = @id").run({ id: jobId, notes });
  const row = db.prepare("SELECT notes FROM jobs WHERE id = @id").get({ id: jobId });
  db.close();
  return row ? row.notes : null;
}

function getJobById(jobId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM jobs WHERE id = @id").get({ id: jobId });
  db.close();
  return row || null;
}

function getStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as c FROM jobs").get().c;
  const sources = db.prepare("SELECT source, COUNT(*) as c FROM jobs GROUP BY source").all();
  const lastFetch = db.prepare("SELECT * FROM fetch_log ORDER BY fetched_at DESC LIMIT 1").get();
  const verifiedCount = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE verified_sponsor = 1").get().c;
  const avgScore = db.prepare("SELECT ROUND(AVG(match_score)) as avg FROM jobs WHERE match_score > 0").get().avg || 0;
  // V3.0 stats
  const statusCounts = db.prepare("SELECT status, COUNT(*) as c FROM jobs GROUP BY status").all();
  const visaGreen = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE visa_confidence = 'green'").get().c;
  const visaYellow = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE visa_confidence = 'yellow'").get().c;
  const visaRed = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE visa_confidence = 'red'").get().c;
  // V4.0: B Corp stats
  const bcorpCount = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE is_bcorp = 1").get().c;
  const goldenCount = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE is_bcorp = 1 AND verified_sponsor = 1").get().c;
  db.close();
  return { total, sources, lastFetch, verifiedCount, avgScore, statusCounts, visaGreen, visaYellow, visaRed, bcorpCount, goldenCount };
}

module.exports = {
  initialize, upsertJobs, getJobs, toggleSave, getStats, getTopNewJobs, logFetch,
  updateStatus, updateNotes, getJobById, VALID_STATUSES,
};

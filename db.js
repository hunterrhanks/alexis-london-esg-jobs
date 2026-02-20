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
      match_score, ai_summary, role_priority
    ) VALUES (
      @id, @title, @company, @location, @description, @url, @source, @tags,
      @job_type, @remote, @visa_sponsorship, @salary, @company_logo,
      @posted_at, @fetched_at, @verified_sponsor, @sponsor_rating,
      @match_score, @ai_summary, @role_priority
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
      });
    }
  });

  tx(jobs);
  db.close();
  return jobs.length;
}

function getJobs({ search, source, remote, saved, sponsorOnly, sort, page, limit }) {
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

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  let orderBy = "match_score DESC, posted_at DESC"; // default: sort by score
  if (sort === "date") orderBy = "posted_at DESC";
  if (sort === "company") orderBy = "company ASC";
  if (sort === "title") orderBy = "title ASC";
  if (sort === "score") orderBy = "match_score DESC, posted_at DESC";

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

function getStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as c FROM jobs").get().c;
  const sources = db.prepare("SELECT source, COUNT(*) as c FROM jobs GROUP BY source").all();
  const lastFetch = db.prepare("SELECT * FROM fetch_log ORDER BY fetched_at DESC LIMIT 1").get();
  const verifiedCount = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE verified_sponsor = 1").get().c;
  const avgScore = db.prepare("SELECT ROUND(AVG(match_score)) as avg FROM jobs WHERE match_score > 0").get().avg || 0;
  db.close();
  return { total, sources, lastFetch, verifiedCount, avgScore };
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

module.exports = { initialize, upsertJobs, getJobs, toggleSave, getStats, getTopNewJobs, logFetch };

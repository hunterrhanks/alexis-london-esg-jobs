// ============================================================
// Job Match Scoring + AI Summary Engine
//
// Produces a 1-100 match score and a 2-sentence "Why this fits
// Alexis" summary for every job. Uses the Anthropic Claude API
// when a key is available, otherwise falls back to a
// deterministic heuristic scorer.
// ============================================================

const fetch = require("node-fetch");

// ---------------------------------------------------------------------------
// Weights for the heuristic scorer
// ---------------------------------------------------------------------------
const ROLE_PRIORITY_TERMS = [
  { pattern: /sustainability\s+consultant/i, weight: 25, label: "Sustainability Consultant" },
  { pattern: /esg\s+analyst/i, weight: 23, label: "ESG Analyst" },
  { pattern: /esg\s+consult/i, weight: 22, label: "ESG Consulting" },
  { pattern: /sustainability\s+analyst/i, weight: 21, label: "Sustainability Analyst" },
  { pattern: /climate\s+consult/i, weight: 20, label: "Climate Consulting" },
  { pattern: /sustainability\s+manager/i, weight: 19, label: "Sustainability Manager" },
  { pattern: /esg\s+manager/i, weight: 18, label: "ESG Manager" },
  { pattern: /esg\s+advisor/i, weight: 17, label: "ESG Advisory" },
  { pattern: /sustainability\s+director/i, weight: 16, label: "Sustainability Director" },
  { pattern: /climate\s+risk/i, weight: 15, label: "Climate Risk" },
  { pattern: /sustainability/i, weight: 12, label: "Sustainability" },
  { pattern: /\besg\b/i, weight: 12, label: "ESG" },
  { pattern: /climate/i, weight: 10, label: "Climate" },
  { pattern: /carbon/i, weight: 9, label: "Carbon" },
  { pattern: /net.zero/i, weight: 9, label: "Net Zero" },
  { pattern: /environment/i, weight: 8, label: "Environment" },
  { pattern: /consult/i, weight: 5, label: "Consulting" },
  { pattern: /advisory/i, weight: 5, label: "Advisory" },
  { pattern: /impact/i, weight: 4, label: "Impact" },
  { pattern: /governance/i, weight: 4, label: "Governance" },
];

const ESG_DEEP_TERMS = [
  "tcfd", "sfdr", "csrd", "gri", "scope 1", "scope 2", "scope 3",
  "double materiality", "taxonomy", "sdg", "green bond",
  "decarbonisation", "decarbonization", "circular economy",
  "energy transition", "biodiversity", "stakeholder engagement",
  "responsible investment", "impact investing",
];

const VISA_SIGNAL_TERMS = [
  "visa sponsor", "sponsorship", "skilled worker visa",
  "right to work", "will sponsor", "visa support",
  "relocation support", "relocation package", "international candidates",
  "work permit",
];

// ---------------------------------------------------------------------------
// Heuristic scorer (no API key needed)
// ---------------------------------------------------------------------------
function computeHeuristicScore(job) {
  let score = 0;
  let reasons = [];

  const titleLower = (job.title || "").toLowerCase();
  const descLower = stripHtml(job.description || "").toLowerCase();
  const allText = `${titleLower} ${descLower}`;

  // 1. Role priority match (0-25 points)
  let rolePts = 0;
  let roleLabel = "";
  for (const term of ROLE_PRIORITY_TERMS) {
    if (term.pattern.test(job.title || "")) {
      if (term.weight > rolePts) {
        rolePts = term.weight;
        roleLabel = term.label;
      }
    }
  }
  score += rolePts;
  if (roleLabel) reasons.push(`Title matches "${roleLabel}"`);

  // 2. ESG depth in description (0-20 points)
  let esgDepthPts = 0;
  const esgHits = [];
  for (const term of ESG_DEEP_TERMS) {
    if (allText.includes(term)) {
      esgDepthPts += 3;
      esgHits.push(term.toUpperCase());
    }
  }
  esgDepthPts = Math.min(esgDepthPts, 20);
  score += esgDepthPts;
  if (esgHits.length > 0) reasons.push(`References ${esgHits.slice(0, 3).join(", ")}`);

  // 3. Verified sponsor (0-20 points)
  if (job.verified_sponsor === 1) {
    score += 20;
    reasons.push("Verified UK visa sponsor");
  } else if (job.visa_sponsorship === 1) {
    score += 10;
    reasons.push("Listed as visa-sponsoring");
  }

  // 4. Visa signals in description (0-10 points)
  let visaPts = 0;
  for (const term of VISA_SIGNAL_TERMS) {
    if (allText.includes(term)) {
      visaPts += 3;
    }
  }
  visaPts = Math.min(visaPts, 10);
  score += visaPts;
  if (visaPts > 0 && !reasons.some(r => r.includes("visa"))) {
    reasons.push("Description mentions visa/sponsorship support");
  }

  // 5. London location bonus (0-10 points)
  const locLower = (job.location || "").toLowerCase();
  if (locLower.includes("london")) {
    score += 10;
    reasons.push("Based in London");
  } else if (locLower.includes("uk") || locLower.includes("united kingdom")) {
    score += 7;
    reasons.push("Based in UK");
  } else if (job.remote === 1) {
    score += 5;
    reasons.push("Remote-friendly");
  }

  // 6. Consulting/advisory bonus (0-5 points) - title
  if (/consult|advisory|advisor/i.test(job.title || "")) {
    score += 5;
    if (!reasons.some(r => r.includes("Consult") || r.includes("Advisory"))) {
      reasons.push("Consulting/advisory role");
    }
  }

  // 7. Salary transparency bonus (0-5 points)
  if (job.salary) {
    score += 5;
    reasons.push("Salary disclosed");
  }

  // Cap at 100
  score = Math.min(score, 100);

  return { score, reasons };
}

/**
 * Generate a 2-sentence AI summary using the heuristic reasons.
 */
function generateHeuristicSummary(job, score, reasons) {
  const name = "Alexis";
  const title = job.title || "this role";
  const company = job.company || "this company";

  // Build the first sentence about ESG fit
  let sentence1 = "";
  if (score >= 70) {
    sentence1 = `This ${title} role at ${company} is a strong match for ${name}'s ESG consulting career goals`;
  } else if (score >= 40) {
    sentence1 = `This ${title} position at ${company} aligns with ${name}'s interest in ESG and sustainability`;
  } else {
    sentence1 = `This ${title} role at ${company} has some relevance to ${name}'s ESG career path`;
  }

  // Add ESG specifics
  const esgReasons = reasons.filter(r =>
    r.includes("References") || r.includes("Title matches")
  );
  if (esgReasons.length > 0) {
    sentence1 += `, with ${esgReasons[0].toLowerCase()}`;
  }
  sentence1 += ".";

  // Build the second sentence about visa likelihood
  let sentence2 = "";
  if (reasons.some(r => r.includes("Verified UK visa sponsor"))) {
    sentence2 = `${company} is a verified UK visa sponsor on the Home Office register, making visa support highly likely.`;
  } else if (reasons.some(r => r.includes("visa") || r.includes("sponsorship") || r.includes("Visa"))) {
    sentence2 = `The listing signals visa sponsorship availability, which is encouraging for US citizens seeking London relocation.`;
  } else if (job.remote === 1) {
    sentence2 = `As a remote role, it may not require visa sponsorship initially, though relocation could be explored later.`;
  } else {
    sentence2 = `Visa sponsorship status is not explicitly stated — ${name} should confirm this directly with the employer.`;
  }

  return `${sentence1} ${sentence2}`;
}

// ---------------------------------------------------------------------------
// Claude API scorer (when ANTHROPIC_API_KEY is set)
// ---------------------------------------------------------------------------
async function computeAIScore(job, apiKey) {
  const plainDesc = stripHtml(job.description || "").slice(0, 3000);

  const prompt = `You are scoring a job listing for Alexis, a US citizen with ESG consulting experience who wants to relocate to London on a Skilled Worker visa.

Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Remote: ${job.remote ? "Yes" : "No"}
Verified UK Visa Sponsor: ${job.verified_sponsor ? "Yes" : "No"}
Source: ${job.source}
Salary: ${job.salary || "Not disclosed"}

Description excerpt:
${plainDesc}

Score this job 1-100 based on:
- Role relevance to ESG consulting / sustainability analyst work (40%)
- Likelihood of visa sponsorship for a US citizen (30%)
- London-based or UK-accessible location (15%)
- Career growth & impact potential (15%)

Then write EXACTLY 2 sentences:
Sentence 1: Why this role fits Alexis's ESG career goals (mention specific ESG themes from the description).
Sentence 2: The likelihood of visa support based on the text and sponsor verification status.

Respond in this exact JSON format only, no other text:
{"score": <number>, "summary": "<two sentences>"}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`API ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Math.max(1, Math.min(100, parseInt(parsed.score) || 50)),
      summary: parsed.summary || "",
    };
  } catch (err) {
    console.error(`  [Scorer] AI scoring failed for "${job.title}":`, err.message);
    return null; // fall back to heuristic
  }
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------
async function scoreJob(job, anthropicKey) {
  // Try AI scoring first if key is available
  if (anthropicKey) {
    const aiResult = await computeAIScore(job, anthropicKey);
    if (aiResult) {
      return {
        match_score: aiResult.score,
        ai_summary: aiResult.summary,
      };
    }
  }

  // Fallback to heuristic
  const { score, reasons } = computeHeuristicScore(job);
  const summary = generateHeuristicSummary(job, score, reasons);
  return {
    match_score: score,
    ai_summary: summary,
  };
}

/**
 * Score a batch of jobs, with rate limiting for AI calls.
 */
async function scoreJobs(jobs, anthropicKey) {
  const results = [];

  for (const job of jobs) {
    const { match_score, ai_summary } = await scoreJob(job, anthropicKey);
    results.push({ ...job, match_score, ai_summary });

    // Rate limit AI calls
    if (anthropicKey) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return results;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = { scoreJob, scoreJobs, computeHeuristicScore };

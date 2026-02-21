// ============================================================
// Job Match Scoring + AI Summary Engine — V3.0
//
// Now includes:
//  • 2026 Skilled Worker Visa salary intelligence
//  • SOC 2020 code mapping for ESG roles
//  • Visa Confidence traffic light (green / yellow / red)
//  • Success Probability composite score
//  • AI Outreach Kit (LinkedIn message + resume bullets)
// ============================================================

const fetch = require("node-fetch");

// ---------------------------------------------------------------------------
// 2026 Skilled Worker Visa — Salary Thresholds
// Source: GOV.UK Immigration Rules Appendix Skilled Worker (Feb 2026)
// ---------------------------------------------------------------------------
const GENERAL_THRESHOLD = 41700; // £41,700 general minimum

// SOC 2020 going rates (standard / new entrant)
const SOC_GOING_RATES = {
  "2431": { title: "Management consultants", standard: 50200, newEntrant: 36000 },
  "2152": { title: "Environment professionals", standard: 37200, newEntrant: 31400 },
  "2151": { title: "Conservation professionals", standard: 36000, newEntrant: 29800 },
  "3545": { title: "Data analysts", standard: 34900, newEntrant: 28600 },
  "2425": { title: "Actuaries, economists, statisticians", standard: 43600, newEntrant: 33400 },
  "2424": { title: "Business & financial project mgmt", standard: 41700, newEntrant: 33100 },
  "2423": { title: "Management consultants & analysts", standard: 41700, newEntrant: 33100 },
  "2136": { title: "Programmers & software developers", standard: 45100, newEntrant: 34200 },
  "2463": { title: "Environmental health professionals", standard: 35400, newEntrant: 29000 },
};

// Map job title keywords → likely SOC codes
const SOC_TITLE_MAP = [
  { pattern: /sustainability\s+consultant/i, soc: "2431", label: "Management consultants" },
  { pattern: /esg\s+consultant/i, soc: "2431", label: "Management consultants" },
  { pattern: /climate\s+consultant/i, soc: "2431", label: "Management consultants" },
  { pattern: /management\s+consultant/i, soc: "2431", label: "Management consultants" },
  { pattern: /esg\s+analyst/i, soc: "3545", label: "Data analysts" },
  { pattern: /sustainability\s+analyst/i, soc: "3545", label: "Data analysts" },
  { pattern: /data\s+analyst/i, soc: "3545", label: "Data analysts" },
  { pattern: /climate\s+analyst/i, soc: "3545", label: "Data analysts" },
  { pattern: /environment(al)?\s+(professional|officer|manager|specialist|advisor)/i, soc: "2152", label: "Environment professionals" },
  { pattern: /sustainability\s+(manager|director|lead|officer|head)/i, soc: "2152", label: "Environment professionals" },
  { pattern: /esg\s+(manager|director|lead|officer|head)/i, soc: "2152", label: "Environment professionals" },
  { pattern: /conservation/i, soc: "2151", label: "Conservation professionals" },
  { pattern: /biodiversity/i, soc: "2151", label: "Conservation professionals" },
  { pattern: /ecolog/i, soc: "2151", label: "Conservation professionals" },
  { pattern: /environmental\s+health/i, soc: "2463", label: "Environmental health professionals" },
  { pattern: /esg\s+advisor/i, soc: "2431", label: "Management consultants" },
  { pattern: /climate\s+risk/i, soc: "2425", label: "Actuaries, economists, statisticians" },
  { pattern: /sustainability\s+report/i, soc: "2431", label: "Management consultants" },
  { pattern: /project\s+manager/i, soc: "2424", label: "Business & financial project mgmt" },
  { pattern: /consult/i, soc: "2431", label: "Management consultants" },
  { pattern: /advisory/i, soc: "2431", label: "Management consultants" },
];

// ---------------------------------------------------------------------------
// Salary parsing — extract numeric GBP annual figure from free-text strings
// ---------------------------------------------------------------------------
function parseSalary(salaryStr) {
  if (!salaryStr) return null;
  const text = salaryStr.replace(/,/g, "").toLowerCase();

  // Try to find GBP amounts: £60,000, £45k, GBP 50000
  const gbpMatch = text.match(/[£](\d+(?:\.\d+)?)\s*k?\b/g)
    || text.match(/gbp\s*(\d+(?:\.\d+)?)\s*k?\b/gi);

  if (gbpMatch) {
    const nums = gbpMatch.map(m => {
      const cleaned = m.replace(/[£gbp\s]/gi, "");
      let val = parseFloat(cleaned);
      if (val < 500) val *= 1000; // "45k" → 45000
      return val;
    }).filter(n => n > 0);

    if (nums.length >= 2) return Math.round((nums[0] + nums[1]) / 2); // midpoint
    if (nums.length === 1) return Math.round(nums[0]);
  }

  // Try USD / EUR amounts and rough-convert
  const usdMatch = text.match(/(?:usd|\$)\s*(\d+(?:\.\d+)?)\s*k?\b/gi);
  if (usdMatch) {
    const nums = usdMatch.map(m => {
      const cleaned = m.replace(/[usd$\s]/gi, "");
      let val = parseFloat(cleaned);
      if (val < 500) val *= 1000;
      return val * 0.79; // rough USD→GBP
    }).filter(n => n > 0);
    if (nums.length >= 2) return Math.round((nums[0] + nums[1]) / 2);
    if (nums.length === 1) return Math.round(nums[0]);
  }

  const eurMatch = text.match(/(?:eur|€)\s*(\d+(?:\.\d+)?)\s*k?\b/gi);
  if (eurMatch) {
    const nums = eurMatch.map(m => {
      const cleaned = m.replace(/[eur€\s]/gi, "");
      let val = parseFloat(cleaned);
      if (val < 500) val *= 1000;
      return val * 0.85; // rough EUR→GBP
    }).filter(n => n > 0);
    if (nums.length >= 2) return Math.round((nums[0] + nums[1]) / 2);
    if (nums.length === 1) return Math.round(nums[0]);
  }

  // Bare number fallback
  const bareMatch = text.match(/(\d{4,6})/g);
  if (bareMatch) {
    const nums = bareMatch.map(Number).filter(n => n >= 15000 && n <= 300000);
    if (nums.length >= 2) return Math.round((nums[0] + nums[nums.length - 1]) / 2);
    if (nums.length === 1) return nums[0];
  }

  return null;
}

// ---------------------------------------------------------------------------
// SOC code inference from job title
// ---------------------------------------------------------------------------
function inferSOCCode(title) {
  for (const { pattern, soc, label } of SOC_TITLE_MAP) {
    if (pattern.test(title)) {
      return { soc, label };
    }
  }
  return { soc: null, label: null };
}

// ---------------------------------------------------------------------------
// Visa Confidence calculation
//  🟢 green  = Verified Sponsor + salary ≥ going rate (or ≥ £42k if no SOC)
//  🟡 yellow = Verified Sponsor but salary unknown or below threshold
//  🔴 red    = Not on sponsor register
// ---------------------------------------------------------------------------
function computeVisaConfidence(job) {
  const isVerified = job.verified_sponsor === 1;
  const salaryNum = job.salary_num || parseSalary(job.salary);

  if (!isVerified) {
    return { confidence: "red", reason: "Company not found on Home Office Register of Licensed Sponsors" };
  }

  // Verified sponsor — check salary
  const socInfo = job.soc_code ? SOC_GOING_RATES[job.soc_code] : null;
  const threshold = socInfo ? Math.max(socInfo.newEntrant, GENERAL_THRESHOLD) : GENERAL_THRESHOLD;

  if (!salaryNum) {
    return { confidence: "yellow", reason: `Verified sponsor but salary undisclosed — confirm ≥ £${threshold.toLocaleString()} threshold` };
  }

  if (salaryNum >= threshold) {
    const label = socInfo ? `SOC ${job.soc_code} (${socInfo.title})` : "general threshold";
    return { confidence: "green", reason: `Verified sponsor + salary £${salaryNum.toLocaleString()} meets ${label} minimum of £${threshold.toLocaleString()}` };
  }

  // Below threshold
  const shortfall = threshold - salaryNum;
  return {
    confidence: "yellow",
    reason: `Verified sponsor but salary £${salaryNum.toLocaleString()} is £${shortfall.toLocaleString()} below the £${threshold.toLocaleString()} threshold — may qualify as new entrant (lower rate: £${socInfo ? socInfo.newEntrant.toLocaleString() : "varies"})`,
  };
}

// ---------------------------------------------------------------------------
// Success Probability — composite of Match Score + Visa Confidence
// ---------------------------------------------------------------------------
function computeSuccessProbability(matchScore, visaConfidence) {
  // Match Score contributes 60%, Visa Confidence contributes 40%
  const visaMultiplier = { green: 1.0, yellow: 0.55, red: 0.15, unknown: 0.3 };
  const visaScore = (visaMultiplier[visaConfidence] || 0.3) * 100;
  return Math.round(matchScore * 0.6 + visaScore * 0.4);
}

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
  const socInfo = job.soc_code ? SOC_GOING_RATES[job.soc_code] : null;
  const salaryInfo = job.salary_num
    ? `£${job.salary_num.toLocaleString()} (threshold: £${socInfo ? Math.max(socInfo.newEntrant, GENERAL_THRESHOLD).toLocaleString() : GENERAL_THRESHOLD.toLocaleString()})`
    : "Not disclosed";

  const prompt = `You are scoring a job listing for Alexis, a US citizen with ESG consulting experience who wants to relocate to London on a Skilled Worker visa.

Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Remote: ${job.remote ? "Yes" : "No"}
Verified UK Visa Sponsor: ${job.verified_sponsor ? "Yes" : "No"}
Visa Confidence: ${job.visa_confidence || "unknown"}
Source: ${job.source}
Salary: ${salaryInfo}
SOC Code: ${job.soc_code || "Not mapped"}${socInfo ? ` (${socInfo.title})` : ""}

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
// AI Outreach Kit — generates LinkedIn message + 3 resume bullets
// ---------------------------------------------------------------------------
async function generateOutreachKit(job, apiKey) {
  if (!apiKey) {
    return generateHeuristicOutreachKit(job);
  }

  const plainDesc = stripHtml(job.description || "").slice(0, 2000);

  const prompt = `Generate an outreach kit for Alexis, a US citizen with ESG consulting experience relocating to London, applying for:

Job Title: ${job.title}
Company: ${job.company}
Key ESG themes from listing: ${plainDesc.slice(0, 500)}

Produce EXACTLY this JSON (no other text):
{
  "linkedin_message": "<a 3-4 sentence personalised LinkedIn connection message to the hiring manager, mentioning the specific role and 1-2 ESG themes from the listing>",
  "resume_bullets": [
    "<achievement-oriented bullet using metrics, tailored to this role's ESG focus>",
    "<achievement-oriented bullet highlighting relevant consulting/analytical skills>",
    "<achievement-oriented bullet showing cross-cultural or international experience>"
  ]
}`;

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
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`  [Outreach] AI kit failed for "${job.title}":`, err.message);
    return generateHeuristicOutreachKit(job);
  }
}

function generateHeuristicOutreachKit(job) {
  const title = job.title || "this role";
  const company = job.company || "your company";

  return {
    linkedin_message: `Hi, I'm Alexis — a US-based ESG consultant exploring opportunities in London. I was excited to see the ${title} role at ${company} and would love to learn more about the team's sustainability priorities. I bring hands-on experience in ESG strategy, stakeholder engagement, and reporting frameworks. Would you be open to a brief chat?`,
    resume_bullets: [
      `Led ESG materiality assessments for Fortune 500 clients, identifying top sustainability risks and aligning reporting with GRI and TCFD frameworks.`,
      `Developed data-driven sustainability dashboards that reduced client carbon reporting time by 40%, enabling faster regulatory compliance.`,
      `Coordinated cross-border ESG due diligence projects spanning US and European markets, supporting $200M+ in sustainable investment decisions.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Main scoring function — V3.0 with visa intelligence
// ---------------------------------------------------------------------------
async function scoreJob(job, anthropicKey) {
  // Step 1: Infer SOC code from title
  const { soc, label: socLabel } = inferSOCCode(job.title);
  job.soc_code = soc;

  // Step 2: Parse salary
  job.salary_num = parseSalary(job.salary);

  // Step 3: Compute visa confidence
  const { confidence, reason: visaReason } = computeVisaConfidence(job);
  job.visa_confidence = confidence;
  job.visa_reason = visaReason; // not stored in DB but useful for summaries

  // Step 4: Get match score (AI or heuristic)
  let match_score, ai_summary;

  if (anthropicKey) {
    const aiResult = await computeAIScore(job, anthropicKey);
    if (aiResult) {
      match_score = aiResult.score;
      ai_summary = aiResult.summary;
    }
  }

  if (match_score === undefined) {
    const { score, reasons } = computeHeuristicScore(job);
    match_score = score;
    ai_summary = generateHeuristicSummary(job, score, reasons);
  }

  // Step 5: Compute success probability
  const success_probability = computeSuccessProbability(match_score, confidence);

  return {
    match_score,
    ai_summary,
    soc_code: soc,
    salary_num: job.salary_num,
    visa_confidence: confidence,
    success_probability,
  };
}

/**
 * Score a batch of jobs, with rate limiting for AI calls.
 */
async function scoreJobs(jobs, anthropicKey) {
  const results = [];

  for (const job of jobs) {
    const scored = await scoreJob(job, anthropicKey);
    results.push({ ...job, ...scored });

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

module.exports = {
  scoreJob,
  scoreJobs,
  computeHeuristicScore,
  parseSalary,
  inferSOCCode,
  computeVisaConfidence,
  computeSuccessProbability,
  generateOutreachKit,
  SOC_GOING_RATES,
  GENERAL_THRESHOLD,
};

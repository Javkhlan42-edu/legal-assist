import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NO_INFO_RESPONSE = 'Мэдээлэл олдсонгүй.';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAny(haystack, needles = []) {
  const normalizedHaystack = normalizeText(haystack);
  return needles.some((needle) => normalizedHaystack.includes(normalizeText(needle)));
}

function parseCliArgs(argv) {
  const args = {
    configPath: resolve(__dirname, 'chat-regression.prompts.json'),
    apiUrlOverride: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--config') {
      const value = argv[index + 1];
      if (value) {
        args.configPath = resolve(process.cwd(), value);
        index += 1;
      }
      continue;
    }

    if (arg === '--api') {
      const value = argv[index + 1];
      if (value) {
        args.apiUrlOverride = value;
        index += 1;
      }
    }
  }

  return args;
}

function isNoInfoAnswer(answer) {
  const normalized = normalizeText(answer);
  const noInfo = normalizeText(NO_INFO_RESPONSE);
  return (
    normalized === noInfo || normalized.startsWith(`${noInfo}.`) || normalized.startsWith(noInfo)
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function collectTextForForbiddenChecks(responseJson) {
  const answer = String(responseJson?.answer ?? '');
  const relatedLawTitles = Array.isArray(responseJson?.relatedLaws)
    ? responseJson.relatedLaws.map((law) => String(law?.title ?? ''))
    : [];
  const sourceTitles = Array.isArray(responseJson?.sources)
    ? responseJson.sources.map((source) => String(source?.title ?? ''))
    : [];

  return [answer, ...relatedLawTitles, ...sourceTitles].join(' | ');
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function roundMetric(value) {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function readServerQuality(responseJson) {
  const quality = responseJson?.quality;
  if (!quality || typeof quality !== 'object') {
    return null;
  }

  return {
    retrievalAccuracy: Number(quality.retrievalAccuracy ?? 0),
    citationCorrectness: Number(quality.citationCorrectness ?? 0),
    answerFaithfulness: Number(quality.answerFaithfulness ?? 0),
    responseLatency: Number(quality.responseLatency ?? 0),
    overall: Number(quality.overall ?? 0),
    issues: Array.isArray(quality.issues) ? quality.issues.map(String) : [],
  };
}

function computeLocalQuality(responseJson, test, latencyBudget, forbiddenTerms) {
  const answer = String(responseJson?.answer ?? '');
  const relatedLawCount = Array.isArray(responseJson?.relatedLaws)
    ? responseJson.relatedLaws.length
    : 0;
  const sourceCount = Array.isArray(responseJson?.sources) ? responseJson.sources.length : 0;
  const noInfo = isNoInfoAnswer(answer);
  const issues = [];

  const mustContainScore =
    Array.isArray(test.mustContainAny) && test.mustContainAny.length > 0
      ? containsAny(answer, test.mustContainAny)
        ? 1
        : 0.35
      : 0.75;

  const retrievalAccuracy = test.expectNoInfo
    ? noInfo
      ? 1
      : 0
    : relatedLawCount > 0 || sourceCount > 0
      ? 0.75
      : mustContainScore * 0.65;

  const citationCorrectness =
    test.expectNoInfo || responseJson?.sourcesUsed === 0
      ? 0.75
      : sourceCount > 0 || relatedLawCount > 0
        ? 0.85
        : 0.45;

  const combinedText = collectTextForForbiddenChecks(responseJson);
  const hasForbidden = forbiddenTerms.length > 0 && containsAny(combinedText, forbiddenTerms);
  const hasInternalLeak = /\bretrieval\b|\brerank\b|\bchunk\b|\bscore\b|контекстэд\s+давтагдсан/i.test(
    answer,
  );
  if (hasForbidden) issues.push('forbidden_term');
  if (hasInternalLeak) issues.push('internal_word_leak');
  if (noInfo && test.mustNotBeNoInfo) issues.push('unexpected_no_info');

  const answerFaithfulness =
    mustContainScore * 0.45 +
    (hasForbidden ? 0 : 0.3) +
    (hasInternalLeak ? 0 : 0.15) +
    (answer.length >= 80 ? 0.1 : 0);

  const latencyMs = Number(responseJson?.usage?.latencyMs ?? 0);
  const responseLatency =
    latencyBudget > 0 && latencyMs > 0 ? Math.min(1, latencyBudget / latencyMs) : 0.75;

  const overall =
    retrievalAccuracy * 0.3 +
    citationCorrectness * 0.25 +
    answerFaithfulness * 0.3 +
    responseLatency * 0.15;

  return {
    retrievalAccuracy: roundMetric(retrievalAccuracy),
    citationCorrectness: roundMetric(citationCorrectness),
    answerFaithfulness: roundMetric(answerFaithfulness),
    responseLatency: roundMetric(responseLatency),
    overall: roundMetric(overall),
    issues,
  };
}

function mergeQualityThresholds(defaults, overrides) {
  return {
    retrievalAccuracy: Number(overrides?.retrievalAccuracy ?? defaults?.retrievalAccuracy ?? 0),
    citationCorrectness: Number(overrides?.citationCorrectness ?? defaults?.citationCorrectness ?? 0),
    answerFaithfulness: Number(overrides?.answerFaithfulness ?? defaults?.answerFaithfulness ?? 0),
    responseLatency: Number(overrides?.responseLatency ?? defaults?.responseLatency ?? 0),
    overall: Number(overrides?.overall ?? defaults?.overall ?? 0),
  };
}

async function callChat(apiUrl, message, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };

  if (process.env.CHAT_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.CHAT_AUTH_TOKEN}`;
  }

  if (process.env.CHAT_API_COOKIE) {
    headers.Cookie = process.env.CHAT_API_COOKIE;
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let responseJson;

    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = { raw: responseText };
    }

    return {
      status: response.status,
      json: responseJson,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function callChatWithRetries(apiUrl, message, timeoutMs, maxRetries, retryDelayMs) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await callChat(apiUrl, message, timeoutMs);
    if (response.status !== 429 || attempt >= maxRetries) {
      return {
        ...response,
        attempts: attempt + 1,
      };
    }

    console.log(
      `  Rate limit hit (429). Waiting ${retryDelayMs}ms before retry ${attempt + 2}/${maxRetries + 1}...`,
    );
    await sleep(retryDelayMs);
  }

  return {
    status: 429,
    json: {},
    attempts: maxRetries + 1,
  };
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const configRaw = await readFile(cli.configPath, 'utf-8');
  const config = JSON.parse(configRaw);

  const apiUrl =
    cli.apiUrlOverride ||
    process.env.CHAT_API_URL ||
    config.apiUrl ||
    'http://localhost:3001/v1/chat';

  const timeoutMs = Number.parseInt(process.env.CHAT_REGRESSION_TIMEOUT_MS || '30000', 10);
  const defaultMaxLatencyMs = Number.parseInt(
    process.env.CHAT_REGRESSION_MAX_LATENCY_MS || '0',
    10,
  );
  const rateLimitRetries = Number.parseInt(process.env.CHAT_REGRESSION_429_RETRIES || '1', 10);
  const rateLimitRetryDelayMs = Number.parseInt(
    process.env.CHAT_REGRESSION_429_DELAY_MS || '62000',
    10,
  );
  const betweenTestDelayMs = Number.parseInt(process.env.CHAT_REGRESSION_DELAY_MS || '250', 10);
  const tests = Array.isArray(config.tests) ? config.tests : [];
  const globalForbidden = Array.isArray(config.globalMustNotContainAny)
    ? config.globalMustNotContainAny
    : [];
  const defaultMinQuality = mergeQualityThresholds(
    {
      retrievalAccuracy: 0,
      citationCorrectness: 0,
      answerFaithfulness: 0,
      responseLatency: 0,
      overall: 0,
    },
    config.minQuality,
  );

  if (tests.length < 10) {
    console.warn(`Warning: regression suite has only ${tests.length} tests (recommended: 10-20).`);
  }

  let passed = 0;
  let failed = 0;
  const failedCases = [];
  const qualityTotals = {
    retrievalAccuracy: 0,
    citationCorrectness: 0,
    answerFaithfulness: 0,
    responseLatency: 0,
    overall: 0,
  };
  let qualityCount = 0;

  console.log(`Chat regression started. API: ${apiUrl}`);
  console.log(`Total tests: ${tests.length}`);
  console.log('');

  for (let index = 0; index < tests.length; index += 1) {
    const test = tests[index];
    const label = `${index + 1}. ${test.id}`;
    const issues = [];
    let status = 0;
    let responseJson = {};
    let attempts = 0;

    try {
      const response = await callChatWithRetries(
        apiUrl,
        test.message,
        timeoutMs,
        rateLimitRetries,
        rateLimitRetryDelayMs,
      );
      status = response.status;
      responseJson = response.json;
      attempts = response.attempts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`Request failed: ${message}`);
    }

    if (status !== 200) {
      issues.push(`Expected HTTP 200, got ${status || 'no response'}`);
    }

    const answer = String(responseJson?.answer ?? '');
    const noInfo = isNoInfoAnswer(answer);

    if (test.expectNoInfo && !noInfo) {
      issues.push(`Expected strict no-info answer, got: ${answer.slice(0, 160)}`);
    }

    if (test.mustNotBeNoInfo && noInfo) {
      issues.push('Unexpected no-info answer for this prompt');
    }

    if (Array.isArray(test.mustContainAny) && test.mustContainAny.length > 0) {
      if (!containsAny(answer, test.mustContainAny)) {
        issues.push(
          `Answer must include one of: ${test.mustContainAny.join(', ')} (got: ${answer.slice(0, 200)})`,
        );
      }
    }

    const forbiddenTerms = [
      ...globalForbidden,
      ...(Array.isArray(test.mustNotContainAny) ? test.mustNotContainAny : []),
    ];

    if (forbiddenTerms.length > 0) {
      const combinedText = collectTextForForbiddenChecks(responseJson);
      if (containsAny(combinedText, forbiddenTerms)) {
        issues.push(`Found forbidden term in answer/sources: ${forbiddenTerms.join(', ')}`);
      }
    }

    if (Number.isFinite(test.minRelatedLaws)) {
      const relatedLawCount = Array.isArray(responseJson?.relatedLaws)
        ? responseJson.relatedLaws.length
        : 0;
      if (relatedLawCount < test.minRelatedLaws) {
        issues.push(
          `Expected at least ${test.minRelatedLaws} related laws, got ${relatedLawCount}`,
        );
      }
    }

    const latencyBudget = Number.isFinite(test.maxLatencyMs)
      ? Number(test.maxLatencyMs)
      : defaultMaxLatencyMs;
    const latencyMs = Number(responseJson?.usage?.latencyMs ?? 0);
    if (latencyBudget > 0 && latencyMs > latencyBudget) {
      issues.push(`Expected latency <= ${latencyBudget}ms, got ${latencyMs}ms`);
    }

    const quality =
      readServerQuality(responseJson) ||
      computeLocalQuality(responseJson, test, latencyBudget, forbiddenTerms);
    const minQuality = mergeQualityThresholds(defaultMinQuality, test.minQuality);

    for (const [metric, threshold] of Object.entries(minQuality)) {
      if (threshold > 0 && Number(quality[metric]) < threshold) {
        issues.push(
          `Expected quality.${metric} >= ${threshold}, got ${Number(quality[metric]).toFixed(3)}`,
        );
      }
    }

    for (const metric of Object.keys(qualityTotals)) {
      qualityTotals[metric] += Number(quality[metric] ?? 0);
    }
    qualityCount += 1;

    if (issues.length === 0) {
      passed += 1;
      if (attempts > 1) {
        console.log(
          `[PASS] ${label} (attempts=${attempts}, q=${quality.overall.toFixed(3)}, latency=${latencyMs}ms)`,
        );
      } else {
        console.log(`[PASS] ${label} (q=${quality.overall.toFixed(3)}, latency=${latencyMs}ms)`);
      }
    } else {
      failed += 1;
      failedCases.push({ id: test.id, issues });
      console.log(`[FAIL] ${label}`);
      for (const issue of issues) {
        console.log(`  - ${issue}`);
      }
    }

    if (betweenTestDelayMs > 0 && index < tests.length - 1) {
      await sleep(betweenTestDelayMs);
    }
  }

  console.log('');
  console.log(`Regression summary: ${passed} passed, ${failed} failed, total ${tests.length}`);
  if (qualityCount > 0) {
    console.log(
      `Quality avg: retrieval=${(qualityTotals.retrievalAccuracy / qualityCount).toFixed(3)}, ` +
        `citation=${(qualityTotals.citationCorrectness / qualityCount).toFixed(3)}, ` +
        `faithfulness=${(qualityTotals.answerFaithfulness / qualityCount).toFixed(3)}, ` +
        `latency=${(qualityTotals.responseLatency / qualityCount).toFixed(3)}, ` +
        `overall=${(qualityTotals.overall / qualityCount).toFixed(3)}`,
    );
  }

  if (failedCases.length > 0) {
    console.log('');
    console.log('Failed case IDs:');
    for (const failedCase of failedCases) {
      console.log(`- ${failedCase.id}`);
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Regression runner failed: ${message}`);
  process.exit(1);
});

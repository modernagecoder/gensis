// server/services/gemini.js
// Google Gemini client (Generative Language REST API).
// - Primary model: gemini-3.8-flash (override with GEMINI_MODEL)
// - Rotates through fallback flash models on 503 (overload) / 429 (per-model quota)
// - Joins all non-thought text parts, reports finishReason on empty/truncated output

const PRIMARY_MODEL = () => (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();

const FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
];

// Models that returned 404 for this key (retired / not enabled) — skipped for the rest of the process
const unavailable = new Set();

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function getGeminiModel() {
  return PRIMARY_MODEL();
}

function modelOrder(requested) {
  const first = requested && requested.startsWith('gemini') ? requested : PRIMARY_MODEL();
  return [first, ...FALLBACK_MODELS.filter(m => m !== first)].filter(m => !unavailable.has(m));
}

// Gemini 3.x accepts thinkingLevel; 2.5 uses thinkingBudget.
function thinkingConfigFor(model, level) {
  if (!level) return undefined;
  if (/gemini-2\./.test(model)) return { thinkingBudget: level === 'high' ? -1 : 1024 };
  return { thinkingLevel: level };
}

function parseRetryDelayMs(body) {
  const m = String(body).match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

/**
 * Call Gemini generateContent.
 * @param {string} system - system instruction
 * @param {string} user - user message
 * @param {object} opts - { model, temperature, max_tokens, json_mode, timeoutMs, thinking, deadlineMs }
 * @returns {Promise<string>} response text
 */
export async function callGemini(system, user, opts = {}) {
  const {
    model,
    temperature = 0.4,
    max_tokens = 16384,
    json_mode = false,
    timeoutMs = 120000,
    thinking = 'low',
    // total wall-clock budget across all retries/models
    deadlineMs = Math.max(timeoutMs * 2, 180000),
  } = opts;

  const apiKey = (opts.apiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured in server environment');

  const started = Date.now();
  const models = modelOrder(model);
  let lastError = null;
  let dropThinking = false;

  // Up to 3 passes over the model list; backoff grows between passes (503 overload spikes are common)
  for (let pass = 0; pass < 3; pass++) {
    for (const m of models) {
      // Lite models are a last resort: only after the full-size models failed a whole pass
      if (pass === 0 && m.includes('-lite') && m !== models[0]) continue;
      const remaining = deadlineMs - (Date.now() - started);
      if (remaining < 5000) {
        throw new Error(`Gemini deadline exceeded after ${Date.now() - started}ms (last error: ${lastError?.message || 'none'})`);
      }

      const generationConfig = {
        temperature,
        maxOutputTokens: max_tokens,
        ...(json_mode ? { responseMimeType: 'application/json' } : {}),
      };
      const tc = dropThinking ? undefined : thinkingConfigFor(m, thinking);
      if (tc) generationConfig.thinkingConfig = tc;

      const body = {
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
      const t0 = Date.now();

      try {
        const res = await fetch(`${API_BASE}/${m}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const raw = await res.text();
        clearTimeout(timer);

        if (res.ok) {
          const data = JSON.parse(raw);
          const cand = data.candidates?.[0];
          const text = (cand?.content?.parts || [])
            .filter(p => !p.thought && typeof p.text === 'string')
            .map(p => p.text)
            .join('');
          const finish = cand?.finishReason || 'UNKNOWN';
          const usage = data.usageMetadata || {};

          if (text.trim()) {
            console.log(`[Gemini] ✓ ${m} ${Date.now() - t0}ms finish=${finish} out=${usage.candidatesTokenCount ?? '?'} thoughts=${usage.thoughtsTokenCount ?? 0}`);
            if (typeof opts.onModel === 'function') opts.onModel(m);
            if (finish === 'MAX_TOKENS') {
              console.warn(`[Gemini] ${m} output truncated at maxOutputTokens=${max_tokens}`);
            }
            return text.trim();
          }

          lastError = new Error(`${m} returned empty text (finishReason=${finish}, thoughts=${usage.thoughtsTokenCount ?? 0}, blockReason=${data.promptFeedback?.blockReason || 'none'})`);
          console.warn(`[Gemini] ${lastError.message}`);
          continue;
        }

        lastError = new Error(`${m} HTTP ${res.status}: ${raw.slice(0, 200).replace(/\s+/g, ' ')}`);
        console.warn(`[Gemini] ${lastError.message}`);

        if (res.status === 400 && /thinking/i.test(raw) && !dropThinking) {
          // Model doesn't accept this thinking config — retry the same model without it
          dropThinking = true;
          models.splice(models.indexOf(m) + 1, 0, m);
          continue;
        }
        if (res.status === 401 || res.status === 403 || /API key not valid/i.test(raw)) {
          throw new Error(`Gemini auth failed (HTTP ${res.status}): check GEMINI_API_KEY`);
        }
        if (res.status === 429) {
          const wait = parseRetryDelayMs(raw);
          // Short retryDelay: worth waiting; long one: move on to the next model's quota
          if (wait && wait <= 15000 && pass === 1) await sleep(wait);
          continue;
        }
        if (res.status >= 500) {
          await sleep(1500 + pass * 2500);
          continue;
        }
        if (res.status === 404) unavailable.add(m);
        // Other 4xx (e.g. 404 model not found): try the next model
      } catch (err) {
        clearTimeout(timer);
        if (/auth failed/.test(err.message)) throw err;
        lastError = err.name === 'AbortError' ? new Error(`${m} timed out after ${Date.now() - t0}ms`) : err;
        console.warn(`[Gemini] ${lastError.message}`);
      }
    }
    await sleep(5000 * (pass + 1));
  }

  throw new Error(`Gemini API unavailable (${lastError?.message || 'unknown error'})`);
}

// Optional plain-language explanation of the computed analysis, written by Claude.
// The signal itself is always computed deterministically in analysis.js; the model only explains it.
import { config } from './config.js';

// Load the SDK during startup when AI is on. Loading it on the first request made `node --watch`
// (npm run server) restart the server mid-request, so that request came back empty.
const preloaded = config.anthropicKey ? await import('@anthropic-ai/sdk').catch(() => null) : null;
const loadSdk = async () => (preloaded ?? await import('@anthropic-ai/sdk')).default;

const cache = new Map();
let lastCall = { state: 'untested', detail: null, at: null };

/** Honest AI availability: configured or not, and what happened on the last real call. It never probes the API. */
export function aiStatus() {
  if (!aiEnabled()) return { configured: false, state: 'not-configured', detail: 'No ANTHROPIC_API_KEY is set.', model: null, at: null };
  return { configured: true, model: config.anthropicModel, ...lastCall };
}
const note = (state, detail = null) => { lastCall = { state, detail, at: Date.now() }; };

/** One request to Claude. Throws a readable error, and records the result for aiStatus(). */
export async function aiComplete({ system, user, maxTokens = 16000, client: injected }) {
  if (!aiEnabled() && !injected) throw Object.assign(new Error('AI is off: no ANTHROPIC_API_KEY is set.'), { status: 501, code: 'ai_off' });
  let msg;
  try {
    const client = injected || new (await loadSdk())({ apiKey: config.anthropicKey });
    msg = await client.messages.create({ model: config.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  } catch (e) {
    const err = toAiError(e);
    note('error', err.message);
    throw err;
  }
  if (msg.stop_reason === 'refusal') {
    note('error', 'The model declined this request.');
    throw Object.assign(new Error('The model declined this request.'), { status: 502, code: 'ai_refused' });
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) {
    note('error', 'The model returned no text.');
    throw Object.assign(new Error('The model returned no text.'), { status: 502, code: 'ai_empty' });
  }
  note('ok');
  return { text, model: config.anthropicModel };
}

export function aiEnabled() {
  return Boolean(config.anthropicKey);
}

// Turns an Anthropic API failure into a message a user can act on, without raw API JSON.
export function toAiError(e) {
  const status = e?.status;
  const detail = e?.error?.error?.message || '';
  const fail = (message, httpStatus, code) => Object.assign(new Error(message), { status: httpStatus, code });
  if (status === 400 && /credit balance/i.test(detail)) {
    return fail('AI explanations are unavailable: the Anthropic account for this API key is out of credits. Add credits under Plans & Billing in the Anthropic Console. Signals, backtests and paper trading are not affected.', 402, 'ai_no_credits');
  }
  if (status === 401 || status === 403) return fail('AI explanations are unavailable: Anthropic rejected the API key. Check ANTHROPIC_API_KEY.', 502, 'ai_auth');
  if (status === 429) return fail('AI explanations are rate limited by Anthropic. Try again in a minute.', 429, 'ai_rate_limited');
  return fail(`AI explanation failed${detail ? `: ${detail}` : '. Try again shortly.'}`, 502, 'ai_failed');
}

export async function explain(symbol, interval, analysis) {
  if (!aiEnabled()) return null;
  const key = `${symbol}:${interval}:${analysis.asOfCandleClose}`;
  if (cache.has(key)) return cache.get(key);
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey: config.anthropicKey });
  const facts = {
    symbol, interval, price: analysis.price, signal: analysis.signal, compositeScore: analysis.score.toFixed(3),
    confidencePct: analysis.confidence, agreementPct: analysis.agreementPct,
    indicators: analysis.components.map((c) => ({ name: c.name, value: Number(c.value.toFixed(4)), reading: c.reading, score: Number(c.score.toFixed(2)) })),
    history: analysis.evidence,
  };
  let msg;
  try {
    msg = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 16000,
      system: 'You explain crypto technical-analysis readings to a retail user. Use only the numbers provided. Never predict prices, never promise returns, never tell the user to trade. Say plainly when the historical hit rate is close to the baseline or the sample is small. 4 to 6 short sentences, no headings, no bullet points.',
      messages: [{ role: 'user', content: `Explain this research reading:\n${JSON.stringify(facts)}` }],
    });
    note('ok');
  } catch (e) {
    const err = toAiError(e);
    note('error', err.message);
    throw err;
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const out = { text, model: config.anthropicModel, generatedAt: Date.now() };
  cache.set(key, out);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}

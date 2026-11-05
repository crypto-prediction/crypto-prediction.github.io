// Optional plain-language explanation of the computed analysis, written by Claude.
// The signal itself is always computed deterministically in analysis.js; the model only explains it.
import { config } from './config.js';

const cache = new Map();

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
  const { default: Anthropic } = await import('@anthropic-ai/sdk'); // loaded only when AI is turned on
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
      max_tokens: 400,
      system: 'You explain crypto technical-analysis readings to a retail user. Use only the numbers provided. Never predict prices, never promise returns, never tell the user to trade. Say plainly when the historical hit rate is close to the baseline or the sample is small. 4 to 6 short sentences, no headings, no bullet points.',
      messages: [{ role: 'user', content: `Explain this research reading:\n${JSON.stringify(facts)}` }],
    });
  } catch (e) {
    throw toAiError(e);
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const out = { text, model: config.anthropicModel, generatedAt: Date.now() };
  cache.set(key, out);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}

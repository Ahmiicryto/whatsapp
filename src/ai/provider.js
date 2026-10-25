import { config } from "../config.js";
import { requestJson } from "../lib/http.js";
import { query } from "../db/pool.js";
import { monthKey } from "../lib/time.js";
import { logger } from "../logger.js";

export class AiUnavailable extends Error {}

function resolve(store) {
  const s = store?.settings?.ai || {};
  if (s.enabled === false) throw new AiUnavailable("AI is turned off for this store");
  const provider = s.provider === "gemini" ? "gemini" : "openai";
  const key = provider === "gemini" ? store?.apiKeys?.gemini || config.gemini.apiKey : store?.apiKeys?.openai || config.openai.apiKey;
  if (!key) throw new AiUnavailable(`No ${provider} API key configured`);
  const model = s.model || (provider === "gemini" ? config.gemini.model : config.openai.model);
  return { provider, key, model };
}

export function aiAvailable(store) {
  try {
    resolve(store);
    return true;
  } catch {
    return false;
  }
}

async function logUsage(store, feature, provider, model, usage, started, ok, error) {
  const inTok = usage?.input || 0;
  const outTok = usage?.output || 0;
  try {
    await query(
      `INSERT INTO ai_logs (store_id, feature, provider, model, input_tokens, output_tokens, latency_ms, ok, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [store?.id ?? null, feature, provider, model, inTok, outTok, Date.now() - started, ok, error?.slice(0, 500) ?? null]
    );
    if (store?.accountId && (inTok || outTok)) {
      await query(
        `INSERT INTO usage_counters (account_id, month, ai_tokens) VALUES ($1,$2,$3)
         ON CONFLICT (account_id, month) DO UPDATE SET ai_tokens = usage_counters.ai_tokens + EXCLUDED.ai_tokens`,
        [store.accountId, monthKey(), inTok + outTok]
      );
    }
  } catch (err) {
    logger.warn({ err: err.message }, "ai usage log failed");
  }
}

async function callOpenAI({ key, model }, { system, user, schema, schemaName, maxTokens }) {
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_completion_tokens: maxTokens,
  };
  // Reasoning models spend completion tokens on thinking; keep it short and leave room for the answer.
  if (/^(gpt-5|o\d)/.test(model)) {
    body.reasoning_effort = "low";
    body.max_completion_tokens = maxTokens * 4;
  }
  if (schema) body.response_format = { type: "json_schema", json_schema: { name: schemaName || "result", strict: true, schema } };
  const res = await requestJson(`${config.openai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body,
    timeoutMs: 60000,
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${res.json?.error?.message || ""}`);
  const choice = res.json.choices?.[0];
  return {
    text: choice?.message?.content || "",
    usage: { input: res.json.usage?.prompt_tokens || 0, output: res.json.usage?.completion_tokens || 0 },
  };
}

async function callGemini({ key, model }, { system, user, schema, maxTokens }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, ...(schema ? { responseMimeType: "application/json" } : {}) },
  };
  if (schema) body.systemInstruction.parts.push({ text: `Respond only with JSON matching this JSON schema: ${JSON.stringify(schema)}` });
  const res = await requestJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: "POST", body, timeoutMs: 60000 }
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${res.json?.error?.message || ""}`);
  const cand = res.json.candidates?.[0];
  return {
    text: (cand?.content?.parts || []).map((p) => p.text || "").join(""),
    usage: { input: res.json.usageMetadata?.promptTokenCount || 0, output: res.json.usageMetadata?.candidatesTokenCount || 0 },
  };
}

async function call(store, feature, opts) {
  const r = resolve(store);
  const started = Date.now();
  try {
    const out = r.provider === "gemini" ? await callGemini(r, opts) : await callOpenAI(r, opts);
    await logUsage(store, feature, r.provider, r.model, out.usage, started, true);
    return out.text;
  } catch (err) {
    await logUsage(store, feature, r.provider, r.model, null, started, false, err.message);
    throw err;
  }
}

/** Structured output call. `schema` is a strict JSON schema (all props required, additionalProperties false). */
export async function aiJson(store, feature, { system, user, schema, maxTokens = 800 }) {
  const text = await call(store, feature, { system, user, schema, schemaName: feature.replace(/\W/g, "_"), maxTokens });
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned);
}

export async function aiText(store, feature, { system, user, maxTokens = 800 }) {
  return (await call(store, feature, { system, user, maxTokens })).trim();
}

/** Voice note -> text (OpenAI only). */
export async function transcribe(store, buffer, mime) {
  const key = store?.apiKeys?.openai || config.openai.apiKey;
  if (!key) throw new AiUnavailable("No OpenAI key for transcription");
  const started = Date.now();
  const form = new FormData();
  const ext = mime?.includes("ogg") ? "ogg" : mime?.includes("mpeg") ? "mp3" : mime?.includes("mp4") ? "m4a" : "ogg";
  form.append("file", new Blob([buffer], { type: mime || "audio/ogg" }), `voice.${ext}`);
  form.append("model", config.openai.transcribeModel);
  const res = await requestJson(`${config.openai.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    timeoutMs: 60000,
  });
  await logUsage(store, "transcribe", "openai", config.openai.transcribeModel, null, started, res.ok, res.ok ? null : JSON.stringify(res.json));
  if (!res.ok) throw new Error(`Transcription failed ${res.status}`);
  return res.json.text || "";
}

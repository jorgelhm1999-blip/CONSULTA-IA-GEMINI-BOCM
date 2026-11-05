import { cacheGet, cacheSet, digest, singleFlight } from './bocm-cache.js';
import { CRITERIOS_BOCM } from './criterios-bocm.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MIN_CALL_INTERVAL_MS = 1500;
let nextCallAt = 0;

async function paceCall() {
  const now = Date.now();
  const startAt = Math.max(now, nextCallAt);
  nextCallAt = startAt + MIN_CALL_INTERVAL_MS;
  if (startAt > now) await new Promise(resolve => setTimeout(resolve, startAt - now));
}

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resultados: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cve: { type: 'string' },
          decision: { type: 'string', enum: ['principal', 'complementario', 'excluir', 'revisar'] },
          categoria: { type: 'string' },
          objeto_real: { type: 'string' },
          relacion_directa: { type: 'boolean' },
          motivo: { type: 'string' },
          municipio: { type: 'string' },
          resumen: { type: 'string' }
        },
        required: ['cve', 'decision', 'categoria', 'objeto_real', 'relacion_directa', 'motivo', 'municipio', 'resumen']
      }
    }
  },
  required: ['resultados']
};

function outputText(response) {
  const parts = [];
  for (const candidate of response?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('').trim();
}

function friendlyGeminiError(status, data) {
  const message = data?.error?.message || '';
  if (status === 429) return quotaDetails(data).message;
  if (status === 400 && /api key/i.test(message)) return 'La clave de Gemini no es válida o no está autorizada para esta API.';
  if (status === 403) return 'Gemini ha rechazado la petición. Revisa la clave, el proyecto y que la API esté habilitada.';
  return message || `La revisión de Gemini falló (${status}).`;
}

async function callGemini(input, stage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en Vercel.');

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: `${CRITERIOS_BOCM}\n\nETAPA ACTUAL: ${stage}` }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: resultSchema
    }
  });

  async function attemptModel(modelName, delays) {
    const url = `${API_BASE}/${encodeURIComponent(modelName)}:generateContent`;
    let lastError;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      await paceCall();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: requestBody
        });

        const raw = await response.text();
        let data;
        try { data = raw ? JSON.parse(raw) : {}; }
        catch {
          if (response.ok) throw new Error('Gemini devolvió una respuesta no válida.');
          data = {};
        }

        if (!response.ok) {
          const error = new Error(friendlyGeminiError(response.status, data));
          error.status = response.status;
          error.model = modelName;
          if (response.status === 429) error.quota = quotaDetails(data);
          throw error;
        }

        const text = outputText(data);
        if (!text) throw new Error('Gemini no devolvió la clasificación esperada.');
        try {
          const parsed = JSON.parse(text);
          parsed.model = modelName;
          parsed.usage = data.usageMetadata || {};
          console.info(JSON.stringify({ event: 'gemini_usage', model: modelName, ...parsed.usage }));
          return parsed;
        }
        catch { throw new Error('Gemini devolvió una clasificación que no pudo interpretarse como JSON.'); }
      } catch (error) {
        lastError = error?.name === 'AbortError'
          ? new Error('Gemini tardó demasiado en responder.')
          : error;
        const transient = error?.name === 'AbortError' || [500, 502, 503, 504].includes(error?.status);
        if (!transient || attempt === delays.length - 1) break;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('Gemini no pudo completar la revisión.');
  }

  try {
    return await attemptModel(model, [0]);
  } catch (error) {
    // A 503 indicates model capacity; a project-wide 429 must not switch models.
    if (error.status !== 503 || !fallbackModel || fallbackModel === model) throw error;
    console.warn(`Gemini ${model} sin capacidad (503). Probando ${fallbackModel}.`);
    return attemptModel(fallbackModel, [0]);
  }
}

function compactRecord(record, includeBody = false) {
  const base = {
    cve: record.cve,
    seccion: record.section || '',
    departamento: record.department || '',
    organismo: record.organization || '',
    titulo: record.title || ''
  };
  if (includeBody) base.texto = String(record.body || '');
  return base;
}


const STAGE = 'Revisión única con el texto completo de cada anuncio. Clasifica TODOS los CVE por su acto y objeto real. No excluyas por el título. Devuelve principal, complementario, excluir o revisar; usa revisar cuando falte información suficiente. Redacta el resumen final de los seleccionados.';
const DECISIONS = new Set(['principal', 'complementario', 'excluir', 'revisar']);
const modelNames = () => [...new Set([process.env.GEMINI_MODEL || DEFAULT_MODEL,
  process.env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL])].filter(Boolean);

export function decisionKey(record, model) {
  return `decision:${digest({ version: 3, model, criteria: CRITERIOS_BOCM, stage: STAGE,
    record: compactRecord(record, true), schema: resultSchema })}`;
}

export function quotaDetails(data) {
  const details = data?.error?.details || [];
  const violations = details.flatMap(item => item.violations || []).map(item => ({
    metric: item.quotaMetric || '', id: item.quotaId || '', value: item.quotaValue || ''
  }));
  const labels = new Set();
  for (const item of violations) {
    const value = `${item.metric} ${item.id}`;
    if (/per.?day|daily/i.test(value)) labels.add('RPD (peticiones por día)');
    else if (/token/i.test(value)) labels.add('TPM (tokens por minuto)');
    else if (/per.?minute/i.test(value)) labels.add('RPM (peticiones por minuto)');
  }
  const retry = details.find(item => item.retryDelay)?.retryDelay;
  const retrySeconds = typeof retry === 'string' ? Number.parseFloat(retry) : Number(retry?.seconds);
  return { violations, retryAfterSeconds: Number.isFinite(retrySeconds) ? Math.ceil(retrySeconds) : null,
    message: `Gemini ha rechazado la petición por límite de cuota${labels.size ? ': ' + [...labels].join(', ') : ' (Google no ha especificado cuál)'}. Consulta el consumo del proyecto en Google AI Studio.` };
}

// Estimate only, not Google's tokenizer: conservative 3 chars/token plus instructions.
// Never truncate an announcement. An oversized record is sent on its own.
export function packRecords(records, targetTokens = 8000) {
  const selected = [];
  let estimated = Math.ceil((CRITERIOS_BOCM.length + STAGE.length) / 3);
  for (const record of records) {
    const cost = Math.ceil(JSON.stringify(compactRecord(record, true)).length / 3);
    if (selected.length && (estimated + cost > targetTokens || selected.length >= 12)) break;
    selected.push(record);
    estimated += cost;
  }
  return { records: selected, estimatedInputTokens: estimated };
}

function validDecision(item) {
  return item && DECISIONS.has(item.decision) && typeof item.relacion_directa === 'boolean'
    && ['cve', 'categoria', 'objeto_real', 'motivo', 'municipio', 'resumen'].every(key => typeof item[key] === 'string');
}

export async function analyzeBocmChunk(records, { singleLegacyBatch = false } = {}) {
  const models = modelNames();
  const found = await Promise.all(records.map(async record => {
    for (const model of models) {
      const value = await cacheGet(decisionKey(record, model));
      if (validDecision(value) && value.cve === record.cve) return value;
    }
    return null;
  }));
  const decisions = found.filter(Boolean);
  const missing = records.filter((_, index) => !found[index]);
  const configured = Number(process.env.GEMINI_BATCH_TARGET_TOKENS || 8000);
  const target = Number.isFinite(configured) ? Math.min(16000, Math.max(2000, configured)) : 8000;
  const packed = singleLegacyBatch
    ? { records: missing, estimatedInputTokens: Math.ceil((CRITERIOS_BOCM.length + STAGE.length + JSON.stringify(missing.map(record => compactRecord(record, true))).length) / 3) }
    : packRecords(missing, target);
  const metrics = { cached: decisions.length, requested: packed.records.length,
    estimatedInputTokens: packed.records.length ? packed.estimatedInputTokens : 0 };
  let error;
  if (packed.records.length) {
    // This is a cooldown, not cached classification. Never retry a 429 in this invocation.
    const cooldownKey = `quota:${digest([process.env.GEMINI_API_KEY || '', models])}`;
    try {
      const cooldown = await cacheGet(cooldownKey);
      if (cooldown?.until > Date.now()) throw Object.assign(new Error(cooldown.message), cooldown);
      const response = await singleFlight(`ai:${digest(packed.records.map(record => decisionKey(record, models[0])))}`,
        () => callGemini({ anuncios: packed.records.map(record => compactRecord(record, true)) }, STAGE));
      const items = Array.isArray(response.resultados) ? response.resultados : [];
      await Promise.all(packed.records.map(async record => {
        const matches = items.filter(item => item.cve === record.cve);
        if (matches.length !== 1 || !validDecision(matches[0])) return;
        decisions.push(matches[0]);
        await cacheSet(decisionKey(record, response.model), matches[0], 604800);
      }));
      metrics.model = response.model;
      metrics.usage = response.usage;
      if (packed.records.some(record => !decisions.some(item => item.cve === record.cve))) {
        error = { status: 502, message: 'Gemini no devolvió decisiones válidas para todos los anuncios. Los restantes siguen pendientes.' };
      }
    } catch (cause) {
      error = { status: cause.status || 502, message: cause.message, quota: cause.quota || null };
      if (cause.status === 429 && !cause.until) {
        const seconds = Math.max(60, cause.quota?.retryAfterSeconds || 60);
        await cacheSet(cooldownKey, { ...error, until: Date.now() + seconds * 1000 }, seconds);
      }
    }
  }
  const processed = new Set(decisions.map(item => item.cve));
  console.info(JSON.stringify({ event: 'bocmi_analysis', ...metrics, status: error?.status || 200 }));
  return { decisions, pendingCves: records.filter(record => !processed.has(record.cve)).map(record => record.cve), metrics, error };
}

// Compatibility for historical search. Keep one bounded call per request.
export async function analyzeBocmRecords(records) {
  const result = await analyzeBocmChunk(records, { singleLegacyBatch: true });
  if (result.error) throw Object.assign(new Error(result.error.message), result.error);
  if (result.pendingCves.length) throw new Error('Lote demasiado grande para una sola revisión. Reduce el tamaño del lote.');
  return result.decisions;
}

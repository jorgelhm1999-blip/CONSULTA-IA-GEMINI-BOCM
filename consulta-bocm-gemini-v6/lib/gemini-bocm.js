import { CRITERIOS_BOCM } from './criterios-bocm.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
  if (status === 429) return 'Se ha alcanzado temporalmente el límite gratuito de Gemini. Espera un poco y vuelve a intentarlo.';
  if (status === 400 && /api key/i.test(message)) return 'La clave de Gemini no es válida o no está autorizada para esta API.';
  if (status === 403) return 'Gemini ha rechazado la petición. Revisa la clave, el proyecto y que la API esté habilitada.';
  return message || `La revisión de Gemini falló (${status}).`;
}

async function callGemini(input, stage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta configurar GEMINI_API_KEY en Vercel.');

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const delays = [0, 2000, 5000, 12000];
  let lastError;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: `${CRITERIOS_BOCM}\n\nETAPA ACTUAL: ${stage}` }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseJsonSchema: resultSchema
          }
        })
      });

      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { throw new Error(`Gemini devolvió una respuesta no válida (${response.status}).`); }

      if (!response.ok) {
        const error = new Error(friendlyGeminiError(response.status, data));
        error.status = response.status;
        throw error;
      }

      const text = outputText(data);
      if (!text) throw new Error('Gemini no devolvió la clasificación esperada.');
      try { return JSON.parse(text); }
      catch { throw new Error('Gemini devolvió una clasificación que no pudo interpretarse como JSON.'); }
    } catch (error) {
      lastError = error?.name === 'AbortError'
        ? new Error('Gemini tardó demasiado en responder.')
        : error;
      const transient = error?.name === 'AbortError' || [429, 500, 502, 503, 504].includes(error?.status);
      if (!transient || attempt === delays.length - 1) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Gemini no pudo completar la revisión.');
}

function compactRecord(record, includeBody = false) {
  const base = {
    cve: record.cve,
    seccion: record.section || '',
    departamento: record.department || '',
    organismo: record.organization || '',
    titulo: record.title || ''
  };
  if (includeBody) base.texto = String(record.body || '').slice(0, 14000);
  return base;
}

export async function analyzeBocmRecords(records) {
  if (!records.length) return [];

  const first = await callGemini(
    { anuncios: records.map(record => compactRecord(record, false)) },
    'Primera revisión. Clasifica todos los CVE. Reserva revisar para los casos donde título y metadatos no permitan identificar el objeto real.'
  );
  const firstMap = new Map((first.resultados || []).map(item => [item.cve, item]));

  // Segunda lectura severa para TODO candidato seleccionado o dudoso.
  // Así una falsa inclusión clara en la primera etapa no elude el texto completo.
  const candidates = records.filter(record => {
    const decision = firstMap.get(record.cve)?.decision;
    return decision === 'principal' || decision === 'complementario' || decision === 'revisar';
  });

  if (candidates.length) {
    const second = await callGemini(
      { anuncios: candidates.map(record => compactRecord(record, true)) },
      'Segunda revisión severa con texto completo. Reevalúa desde cero. Aplica primero las exclusiones absolutas. Devuelve principal, complementario o excluir. Usa revisar solo si el texto está realmente incompleto.'
    );
    for (const item of second.resultados || []) firstMap.set(item.cve, item);
  }

  return records.map(record => firstMap.get(record.cve) || ({
    cve: record.cve,
    decision: 'revisar',
    categoria: 'Sin clasificar',
    objeto_real: 'No identificado',
    relacion_directa: false,
    motivo: 'Gemini no devolvió una decisión para este anuncio.',
    municipio: '',
    resumen: ''
  }));
}

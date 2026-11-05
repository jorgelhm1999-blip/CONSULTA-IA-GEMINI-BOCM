import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHtmlRecord, parseXmlRecord, downloadBocmBatch } from '../lib/bocm.js';
import { analyzeBocmChunk, decisionKey, packRecords, quotaDetails } from '../lib/gemini-bocm.js';
import { collectBulletin } from '../lib/query-client.js';
import handler from '../api/search.js';

const record = (n, body = 'Se aprueba un plan especial de urbanismo.') => ({ cve: `BOCM-20261105-${n}`, title: 'Plan especial', body });
const decision = r => ({ cve: r.cve, decision: 'principal', categoria: 'Urbanismo', objeto_real: 'Plan', relacion_directa: true, motivo: 'Aprobación', municipio: 'Madrid', resumen: 'Plan aprobado.' });
const answer = items => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ resultados: items }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } });

test('HTML exige identidad exacta y texto; XML rechaza otro CVE o texto vacío', () => {
  const cve = record(9001).cve;
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Legislation', legislationIdentifier: cve, text: record(1).body, name: 'Plan especial' })}</script>`;
  assert.equal(parseHtmlRecord(html, cve).cve, cve);
  assert.equal(parseHtmlRecord(html, record(9002).cve), null);
  assert.equal(parseHtmlRecord('<html>Error de acceso</html>', cve), null);
  assert.equal(parseXmlRecord(`<documento><metadatos><identificador>OTRO</identificador></metadatos><texto>contenido</texto></documento>`, cve), null);
  assert.equal(parseXmlRecord(`<documento><metadatos><identificador>${cve}</identificador></metadatos><texto/></documento>`, cve), null);
});

test('un XML fallido usa HTML validado y no vuelve a descargarse', async () => {
  const original = fetch;
  const cve = record(9003).cve;
  const requests = [];
  try {
    globalThis.fetch = async url => {
      requests.push(String(url));
      if (String(url).endsWith('.xml')) return new Response('error', { status: 503 });
      return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'Legislation', legislationIdentifier: cve, text: record(1).body })}</script>`);
    };
    assert.deepEqual((await downloadBocmBatch([cve])).downloadedCves, [cve]);
    assert.equal((await downloadBocmBatch([cve])).cacheHits, 1);
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = original; }
});

test('lotes por longitud, sin recortar anuncios largos; claves cambian con texto y modelo', () => {
  const small = [record(1), record(2)];
  assert.equal(packRecords(small, 8000).records.length, 2);
  const huge = record(3, 'x'.repeat(90000));
  assert.deepEqual(packRecords([huge, ...small], 8000).records, [huge]);
  assert.equal(packRecords([huge], 8000).records[0].body.length, 90000);
  assert.notEqual(decisionKey(small[0], 'a'), decisionKey(small[0], 'b'));
  assert.notEqual(decisionKey(small[0], 'a'), decisionKey({ ...small[0], body: 'corrección' }, 'a'));
});

test('decisiones omitidas siguen pendientes; reutiliza las válidas sin pagar otra llamada por ellas', async () => {
  const original = fetch;
  process.env.GEMINI_API_KEY = 'test-omitted';
  const records = [record(9010), record(9011)];
  const bodies = [];
  try {
    globalThis.fetch = async (url, options) => {
      const sent = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).anuncios;
      bodies.push(sent);
      return answer([decision(records[bodies.length === 1 ? 0 : 1])]);
    };
    const first = await analyzeBocmChunk(records);
    assert.deepEqual(first.pendingCves, [records[1].cve]);
    assert.equal(first.error.status, 502);
    const second = await analyzeBocmChunk(records);
    assert.equal(second.decisions.length, 2);
    assert.equal(second.metrics.cached, 1);
    assert.deepEqual(bodies[1].map(r => r.cve), [records[1].cve]);
    await analyzeBocmChunk(records);
    assert.equal(bodies.length, 2);
  } finally { globalThis.fetch = original; delete process.env.GEMINI_API_KEY; }
});

test('429 distingue cuotas y aplica pausa compartida sin probar otro modelo', async () => {
  const original = fetch;
  process.env.GEMINI_API_KEY = 'test-quota';
  const data = { error: { details: [{ violations: [{ quotaId: 'GenerateContentInputTokensPerModelPerMinute' }] }, { retryDelay: '32s' }] } };
  assert.match(quotaDetails(data).message, /TPM/);
  assert.equal(quotaDetails(data).retryAfterSeconds, 32);
  assert.match(quotaDetails({ error: { details: [{ violations: [{ quotaId: 'RequestsPerDay' }] }] } }).message, /RPD/);
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json(data, { status: 429 }); };
    assert.equal((await analyzeBocmChunk([record(9020)])).error.status, 429);
    assert.equal((await analyzeBocmChunk([record(9021)])).error.status, 429);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; delete process.env.GEMINI_API_KEY; }
});

test('cliente descarga antes de analizar, reintenta solo ausentes y sigue lotes dinámicos', async () => {
  const cves = [record(9030).cve, record(9031).cve];
  const requests = [];
  const fetcher = async url => {
    const params = new URL(url).searchParams;
    const mode = params.get('mode');
    const batch = params.get('cves')?.split(',');
    requests.push({ mode, batch });
    if (mode === 'manifest') return Response.json({ found: true, cves });
    if (mode === 'download') return Response.json({ downloadedCves: requests.length === 2 ? [cves[0]] : batch });
    return Response.json({ processedCves: [batch[0]], pendingCves: batch.slice(1), results: [{ cve: batch[0] }] });
  };
  const report = await collectBulletin('https://example.com', '2026-11-05', { fetcher, wait: async () => {} });
  assert.deepEqual(requests.map(r => r.mode), ['manifest', 'download', 'download', 'analyze', 'analyze']);
  assert.deepEqual(requests[2].batch, [cves[1]]);
  assert.deepEqual(requests[4].batch, [cves[1]]);
  assert.equal(report.scanned, 2);
  assert.equal(report.principal.length, 2);
  assert.deepEqual(report.failedCves, []);
});

test('API valida fecha/CVE y analizar no descarga del BOCM', async () => {
  const invoke = async query => {
    const result = {};
    await handler({ method: 'GET', query }, { setHeader() {}, status(n) { result.status = n; return this; }, json(data) { result.data = data; } });
    return result;
  };
  assert.equal((await invoke({ date: '2026-02-30' })).status, 400);
  assert.equal((await invoke({ mode: 'download', date: '2026-11-05', cves: 'BOCM-20261104-1' })).status, 400);
  const original = fetch;
  try {
    globalThis.fetch = async () => { throw new Error('No debe descargar ni llamar a Gemini'); };
    const result = await invoke({ mode: 'analyze', date: '2026-11-05', cves: record(9998).cve });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.failedCves, [record(9998).cve]);
    assert.deepEqual(result.data.processedCves, []);
  } finally { globalThis.fetch = original; }
});


test('los errores transitorios reintentan solo decisiones pendientes en otra petición', async () => {
  const cves = [record(9040).cve, record(9041).cve];
  const sent = [];
  const pauses = [];
  const fetcher = async url => {
    const params = new URL(url).searchParams;
    if (params.get('mode') === 'manifest') return Response.json({ found: true, cves });
    if (params.get('mode') === 'download') return Response.json({ downloadedCves: cves });
    const batch = params.get('cves').split(',');
    sent.push(batch);
    return Response.json(sent.length === 1
      ? { processedCves: [cves[0]], results: [{ cve: cves[0] }], analysisError: { status: 503, message: 'Saturado' } }
      : { processedCves: batch, results: batch.map(cve => ({ cve })) });
  };
  const report = await collectBulletin('https://example.com', '2026-11-05', { fetcher, wait: async ms => pauses.push(ms) });
  assert.deepEqual(sent, [cves, [cves[1]]]);
  assert.deepEqual(pauses, [5000]);
  assert.equal(report.scanned, 2);
});

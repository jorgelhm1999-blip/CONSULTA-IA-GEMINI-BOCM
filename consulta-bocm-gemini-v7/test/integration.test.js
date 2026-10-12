import test from 'node:test';
import assert from 'node:assert/strict';
import { findLiteralMatch, matchingExcerpt } from '../lib/historical-match.js';
import { getBocmManifest, searchBocmCveBatch, searchHistoricalCveBatch } from '../lib/bocm.js';
import historicalHandler from '../api/historical.js';

const publications = new Map();
const requested = [];
let geminiCalls = 0;
const temporaryFailures = new Map();

function bulletinNumber(date) {
  const end = new Date(`${date}T12:00:00Z`);
  let count = 0;
  for (let day = new Date(Date.UTC(end.getUTCFullYear(), 0, 1, 12)); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() !== 0 && !(day.getUTCMonth() === 0 && day.getUTCDate() === 1)
      && !(day.getUTCMonth() === 11 && day.getUTCDate() === 25)) count++;
  }
  return count;
}

function addPublication(date, bodies) {
  publications.set(date, bodies.map((body, index) => ({
    cve: `BOCM-${date.replaceAll('-', '')}-${index + 1}`,
    title: `Urbanismo. Anuncio ${index + 1}`,
    body,
    organization: index === 0 ? 'Ayuntamiento de Meco' : 'Ayuntamiento de Parla'
  })));
}

addPublication('2026-09-25', [
  'Se aprueba el Proyecto de Urbanización del sector.',
  'Se somete a información pública el Plan  Especial de Infraestructuras.',
  'Contenido sobre vías pecuarias.'
]);
addPublication('2026-09-26', Array.from({ length: 72 }, (_, index) =>
  `El plan especial ${index + 1} afecta a un ámbito distinto.`));
addPublication('2026-08-31', [
  'La aprobación del Plan Especial de Alcobendas se somete a información pública.',
  'Oferta de empleo público del Ayuntamiento de Alcobendas.',
  'Régimen económico y tasas del Ayuntamiento de Alcobendas.'
]);
publications.get('2026-08-31')[0].title = 'Urbanismo. Plan Especial de Alcobendas';
publications.get('2026-08-31')[1].title = 'Ofertas de empleo. Alcobendas';
publications.get('2026-08-31')[2].title = 'Régimen económico. Alcobendas';
for (let day = 1; day <= 24; day += 1) {
  const date = `2026-09-${String(day).padStart(2, '0')}`;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday !== 0) addPublication(date, [`Acuerdo sin relación con el término solicitado (${date}).`]);
}

globalThis.fetch = async (url, options = {}) => {
  const value = String(url);
  requested.push(value);
  if (value.includes('generativelanguage.googleapis.com')) {
    geminiCalls++;
    const request = JSON.parse(options.body);
    const records = JSON.parse(request.contents[0].parts[0].text).anuncios;
    const resultados = records.map(record => ({
      cve: record.cve,
      decision: /empleo|régimen económico/i.test(record.titulo) ? 'excluir' : 'principal',
      categoria: 'Urbanismo',
      objeto_real: 'Proyecto de urbanización', relacion_directa: true,
      motivo: 'Tramitación urbanística', municipio: 'Meco',
      resumen: 'Aprobación del proyecto de urbanización.'
    }));
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ resultados }) }] } }] });
  }
  const dateMatch = value.match(/(?:bocm-|BOCM-)(\d{8})/);
  const date = dateMatch && `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`;
  const records = publications.get(date) || [];
  const page = value.match(/\/boletin\/bocm-\d{8}-(\d+)$/);
  if (page && records.length && Number(page[1]) === bulletinNumber(date)) {
    return new Response(`<html>BOCM-${dateMatch[1]}-${page[1]} ${date}</html>`);
  }
  if (value.includes('/boletin-completo/') && records.length) {
    return new Response(`<html><a href="/boletin/CM_Boletin_BOCM/${date.replaceAll('-', '/')}/BOCM-${dateMatch[1]}-0.xml">Portada</a>${records.map(record => `<a href="/boletin/CM_Orden_BOCM/${date.replaceAll('-', '/')}/${record.cve}.xml?language=es">XML</a>`).join('')}<a href="/boletin/CM_Boletin_BOCM/${date.replaceAll('-', '/')}/BOCM-${dateMatch[1]}${bulletinNumber(date)}.xml">Sumario</a></html>`);
  }
  if (value.includes('/CM_Boletin_BOCM/') && records.length) {
    return new Response(`<sumario>BOCM-${dateMatch[1]}-0 ${records.map(record => record.cve).join(' ')}</sumario>`);
  }
  const individual = value.match(/\/(BOCM-\d{8}-\d+)\.xml$/);
  if (individual) {
    const remaining = temporaryFailures.get(individual[1]) || 0;
    if (remaining) {
      temporaryFailures.set(individual[1], remaining - 1);
      return new Response('No disponible', { status: 503 });
    }
    const record = records.find(item => item.cve === individual[1]);
    if (record) return new Response(`<documento><metadatos><identificador>${record.cve}</identificador><titulo>${record.title}</titulo><departamento>Administración local</departamento><fecha_publicacion>${date}</fecha_publicacion><diario_numero>${bulletinNumber(date)}</diario_numero></metadatos><analisis><seccion>III. ADMINISTRACIÓN LOCAL AYUNTAMIENTOS</seccion><organismo>${record.organization}</organismo></analisis><texto>${record.body}</texto></documento>`);
  }
  return new Response('No existe', { status: 404 });
};

test('coincidencia literal con tildes, frase, espacios y guion de corte', () => {
  const body = 'Se aprueba la urbaniza- ción y el Plan  Especial.';
  const first = findLiteralMatch(body, 'urbanizacion');
  assert.ok(first);
  assert.match(matchingExcerpt(body, first).text, /urbaniza- ción/);
  assert.ok(findLiteralMatch(body, 'PLAN ESPECIAL'));
  assert.equal(findLiteralMatch(body, 'planeamiento'), null);
  assert.equal(findLiteralMatch('año', 'ano'), null);
});

test('día con BOCM, día sin BOCM y búsqueda de un día sin Gemini', async () => {
  const present = await getBocmManifest('2026-09-25', { historical: true });
  assert.equal(present.cves.length, 3);
  assert.ok(!present.cves.includes('BOCM-20260925-0'));
  const absent = await getBocmManifest('2026-09-27', { historical: true });
  assert.equal(absent.found, false);
  const before = geminiCalls;
  const found = await searchHistoricalCveBatch('2026-09-25', 'urbanizacion', '', present.cves);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].cve, present.cves[0]);
  assert.equal(found.results[0].date, '2026-09-25');
  assert.equal(geminiCalls, before);
  assert.equal((await searchHistoricalCveBatch('2026-09-25', 'nada encontrado', '', present.cves)).results.length, 0);
  assert.equal((await searchHistoricalCveBatch('2026-09-25', 'urbanización', 'Parla', present.cves)).results.length, 0);
  assert.equal((await searchHistoricalCveBatch('2026-09-25', 'urbanización', 'Meco', present.cves)).results.length, 1);
});

test('búsqueda histórica solo por municipio, con y sin criterios de interés', async () => {
  const cves = publications.get('2026-08-31').map(record => record.cve);
  const open = await searchHistoricalCveBatch('2026-08-31', '', 'Alcobendas', cves);
  assert.equal(open.results.length, 3);
  assert.equal(open.results[0].source, 'Título');
  process.env.GEMINI_API_KEY = 'clave-simulada';
  const filtered = await searchHistoricalCveBatch('2026-08-31', '', 'Alcobendas', cves, true);
  assert.equal(filtered.results.length, 1);
  assert.equal(filtered.results[0].cve, cves[0]);
});

test('semana y mes: fechas sin publicación se saltan y no hay duplicados', async () => {
  for (const [first, last, expectedDays] of [
    ['2026-09-25', '2026-10-01', 2],
    ['2026-09-01', '2026-09-30', publications.size - 1]
  ]) {
    let bulletins = 0;
    const cves = new Set();
    for (let timestamp = Date.parse(`${first}T12:00:00Z`); timestamp <= Date.parse(`${last}T12:00:00Z`); timestamp += 86400000) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      const manifest = await getBocmManifest(date, { historical: true });
      if (!manifest.found) continue;
      bulletins++;
      for (let offset = 0; offset < manifest.cves.length; offset += 12) {
        const batch = manifest.cves.slice(offset, offset + 12);
        const result = await searchHistoricalCveBatch(date, 'plan especial', '', batch);
        for (const item of result.results) cves.add(item.cve);
      }
    }
    assert.equal(bulletins, expectedDays);
    assert.equal(cves.size, 73);
  }
});

test('fallo temporal de un XML devuelve pendientes y permite reintentar sin perder resultados', async () => {
  const cves = publications.get('2026-09-25').map(record => record.cve);
  temporaryFailures.set(cves[1], 1);
  const initial = await searchHistoricalCveBatch('2026-09-25', 'plan especial', '', cves);
  assert.deepEqual(initial.failedCves, [cves[1]]);
  assert.deepEqual(initial.failedDetails, [{ cve: cves[1], reason: 'transient' }]);
  const retried = await searchHistoricalCveBatch('2026-09-25', 'plan especial', '', initial.failedCves);
  assert.equal(retried.results.length, 1);
  assert.deepEqual(retried.failedCves, []);
});

test('un XML inexistente se identifica como anuncio, no como día fallido', async () => {
  const cve = 'BOCM-20260925-9999';
  const result = await searchHistoricalCveBatch('2026-09-25', 'proyecto', '', [cve]);
  assert.deepEqual(result.failedCves, [cve]);
  assert.deepEqual(result.failedDetails, [{ cve, reason: 'not_found' }]);
});

test('consulta diaria conserva Gemini y la clasificación en dos etapas', async () => {
  process.env.GEMINI_API_KEY = 'clave-simulada';
  const records = publications.get('2026-09-25');
  const before = geminiCalls;
  const daily = await searchBocmCveBatch('2026-09-25', '', records.map(item => item.cve));
  assert.equal(daily.results.length, 3);
  assert.equal(geminiCalls - before, 2);
});

test('interruptor: abierto busca Alcobendas en todo; encendido aplica los mismos criterios Gemini solo a coincidencias', async () => {
  process.env.GEMINI_API_KEY = 'clave-simulada';
  const cves = publications.get('2026-08-31').map(record => record.cve);
  const before = geminiCalls;
  const all = await searchHistoricalCveBatch('2026-08-31', 'Alcobendas', '', cves);
  assert.equal(all.results.length, 3);
  assert.equal(geminiCalls, before);

  const filtered = await searchHistoricalCveBatch('2026-08-31', 'Alcobendas', '', cves, true);
  assert.deepEqual(filtered.results.map(item => item.cve), [cves[0]]);
  assert.equal(filtered.results[0].decision, 'principal');
  assert.equal(filtered.results[0].summary, 'Aprobación del proyecto de urbanización.');
  assert.equal(geminiCalls - before, 2);

  const none = await searchHistoricalCveBatch('2026-08-31', 'palabra inexistente', '', cves, true);
  assert.equal(none.results.length, 0);
  assert.equal(geminiCalls - before, 2);
});

test('API histórica rechaza fechas irreales y CVE de otro día', async () => {
  const invoke = async query => {
    let status = 200;
    let body;
    const response = {
      status(value) { status = value; return this; },
      json(value) { body = value; return this; },
      setHeader() {}
    };
    await historicalHandler({ method: 'GET', query }, response);
    return { status, body };
  };
  assert.equal((await invoke({ mode: 'manifest', date: '2026-02-30' })).status, 400);
  assert.equal((await invoke({ mode: 'batch', date: '2026-09-25', q: 'plan', cves: 'BOCM-20260924-1' })).status, 400);
  assert.equal((await invoke({ mode: 'batch', date: '2026-09-25', q: 'plan', cves: 'BOCM-20260925-1', filter: 'no' })).status, 400);
  const key = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const unavailable = await invoke({ mode: 'batch', date: '2026-09-25', q: 'plan', cves: 'BOCM-20260925-1', filter: '1' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, 'AI_UNAVAILABLE');
  process.env.GEMINI_API_KEY = key;
  const filtered = await invoke({
    mode: 'batch', date: '2026-08-31', q: 'Alcobendas',
    cves: publications.get('2026-08-31').map(item => item.cve).join(','), filter: '1'
  });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.results.length, 1);
  const municipalityOnly = await invoke({
    mode: 'batch', date: '2026-08-31', q: '', municipality: 'Alcobendas',
    cves: publications.get('2026-08-31').map(item => item.cve).join(','), filter: '1'
  });
  assert.equal(municipalityOnly.status, 200);
  assert.equal(municipalityOnly.body.results.length, 1);
  assert.equal((await invoke({ mode: 'batch', date: '2026-08-31', q: '', cves: 'BOCM-20260831-1' })).status, 400);
  assert.equal((await invoke({ mode: 'batch', date: '2026-09-25', q: 'plan', cves: publications.get('2026-09-25')[1].cve })).body.results.length, 1);
});

test('el motor solo consulta dominios oficiales del BOCM y Gemini', () => {
  assert.ok(requested.every(url => url.startsWith('https://www.bocm.es/') || url.startsWith('https://generativelanguage.googleapis.com/')));
});

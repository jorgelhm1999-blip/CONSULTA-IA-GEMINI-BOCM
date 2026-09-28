import * as cheerio from 'cheerio';
import { analyzeBocmRecords } from './gemini-bocm.js';
import { findLiteralMatch, matchingExcerpt } from './historical-match.js';

const BASE = 'https://www.bocm.es';

const normalize = (value = '') => String(value)
  .replace(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])-\s*\n?\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/g, '$1$2')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const containsAny = (text, terms) => {
  const value = normalize(text);
  return terms.some(term => value.includes(normalize(term)));
};

const EXCLUDED_DEPARTMENTS = [
  'consejeria de sanidad',
  'servicio madrileno de salud',
  'hospital universitario',
  'consejeria de educacion',
  'consejeria de educacion, ciencia y universidades',
  'consejeria de familia, juventud y asuntos sociales',
  'consejeria de cultura, turismo y deporte',
  'metro de madrid'
];

const TARGET_C_DEPARTMENT = 'consejeria de medio ambiente, agricultura e interior';
const TARGET_D_DEPARTMENTS = [
  'consejeria de vivienda, transportes e infraestructuras',
  'consejeria de medio ambiente, agricultura e interior'
];

const LOCAL_URBAN_TERMS = [
  'urbanismo', 'plan parcial', 'planes parciales', 'plan especial', 'planes especiales',
  'estudio de detalle', 'estudios de detalle', 'proyecto de urbanizacion',
  'proyectos de urbanizacion', 'proyecto de reparcelacion', 'reparcelacion',
  'planeamiento', 'gestion urbanistica', 'modificacion puntual', 'plan general',
  'normas subsidiarias', 'unidad de ejecucion', 'sector urbanistico',
  'aprovechamiento urbanistico', 'licencia urbanistica'
];

const URBAN_AND_CIVIL_TITLE_TERMS = [
  ...LOCAL_URBAN_TERMS,
  'urbanizacion', 'reurbanizacion', 'rehabilitacion urbana', 'rehabilitacion edificatoria',
  'regeneracion urbana', 'renovacion urbana', 'entorno residencial de rehabilitacion programada',
  'mejora del entorno fisico', 'espacio publico', 'infraestructura viaria', 'obra civil',
  'carretera', 'vial', 'calzada', 'pavimentacion', 'firme', 'acera', 'glorieta',
  'puente', 'pasarela', 'movilidad', 'trafico', 'aparcamiento', 'abastecimiento',
  'saneamiento', 'alcantarillado', 'colector', 'drenaje', 'depuracion', 'red de agua',
  'red de riego', 'alumbrado publico', 'redes de servicios', 'proyecto constructivo',
  'redaccion de proyecto', 'direccion de obra', 'asistencia tecnica', 'estudio geotecnico',
  'topografia', 'levantamiento topografico'
];

const ENVIRONMENTAL_TITLE_TERMS = [
  'impacto ambiental', 'evaluacion ambiental', 'informe de impacto ambiental',
  'declaracion de impacto ambiental', 'autorizacion ambiental integrada',
  'restauracion ambiental', 'via pecuaria', 'vias pecuarias', 'monte', 'montes',
  'cauce', 'dominio publico hidraulico', 'zona de policia', 'residuos',
  'suelo contaminado', 'contaminacion', 'medio natural', 'espacio protegido'
];

const EXPROPRIATION_TERMS = [
  'expropiacion', 'expropiacion forzosa', 'expediente expropiatorio',
  'procedimiento expropiatorio', 'actas previas a la ocupacion',
  'levantamiento de actas', 'justiprecio', 'ocupacion urgente',
  'necesidad de ocupacion', 'bienes y derechos afectados'
];

const INVESTMENT_PROGRAM_TERMS = [
  'programa regional de inversiones',
  'programa regional de inversion',
  'programa inversion regional'
];

const FUNDING_TERMS = [
  'subvencion', 'ayuda', 'concesion directa', 'convenio', 'adenda',
  'financiacion', 'fondos europeos', 'nextgenerationeu'
];

const OPEN_CONTRACT_TERMS = [
  'licitacion', 'convocatoria de licitacion', 'procedimiento abierto',
  'anuncio previo', 'presentacion de ofertas', 'pliego de clausulas'
];

const CLOSED_CONTRACT_TERMS = [
  'adjudicacion', 'adjudicado', 'formalizacion', 'formalizado', 'prorroga',
  'modificacion del contrato', 'desistimiento', 'renuncia', 'declarado desierto'
];

const AGRICULTURE_ONLY_TERMS = [
  'ganaderia', 'ganadero', 'actividad ganadera', 'explotacion ganadera',
  'bovino', 'ovino', 'caprino', 'porcino', 'avicola', 'apicultura',
  'bienestar animal', 'sanidad animal', 'actividad agraria', 'explotacion agraria',
  'agricultura', 'cultivos', 'politica agraria comun'
];

async function fetchResource(url, { timeoutMs = 7000, attempts = 2 } = {}) {
  let last = { kind: 'transient', status: 0, text: null };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 ConsultaDiariaBOCM/0.30',
          'Accept': 'application/xml,text/xml,text/html;q=0.8,*/*;q=0.5',
          'Accept-Language': 'es-ES,es;q=0.9',
          'Cache-Control': 'no-cache'
        }
      });
      if (response.status === 404 || response.status === 410) {
        return { kind: 'not_found', status: response.status, text: null };
      }
      if (!response.ok) {
        last = { kind: 'transient', status: response.status, text: null };
      } else {
        return { kind: 'ok', status: response.status, text: await response.text() };
      }
    } catch (error) {
      last = { kind: 'transient', status: 0, text: null };
      console.warn(`No se pudo consultar ${url} (intento ${attempt}/${attempts}):`, error?.name || error?.message || error);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 180 * attempt));
  }
  return last;
}

async function fetchText(url, { timeoutMs = 7000, attempts = 2 } = {}) {
  const result = await fetchResource(url, { timeoutMs, attempts });
  return result.kind === 'ok' ? result.text : null;
}

function publicationDayEstimate(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 12));
  let count = 0;
  for (let cursor = new Date(start); cursor <= date; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const isSunday = cursor.getUTCDay() === 0;
    const isFixedHoliday = (month === 1 && day === 1) || (month === 12 && day === 25);
    if (!isSunday && !isFixedHoliday) count += 1;
  }
  return Math.max(1, count);
}

function bulletinPageLooksValid(html, compactDate, number) {
  if (!html) return false;
  const value = normalize(html);
  const dateIso = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
  const dateSlash = `${compactDate.slice(6, 8)}/${compactDate.slice(4, 6)}/${compactDate.slice(0, 4)}`;
  const numberPatterns = [
    `bocm n.o ${number}`,
    `bocm no ${number}`,
    `num. ${number}`,
    `num ${number}`,
    `numero ${number}`,
    `bocm-${compactDate}-${number}`
  ];
  return value.includes(normalize(compactDate))
    || value.includes(normalize(dateIso))
    || value.includes(normalize(dateSlash))
    || numberPatterns.some(pattern => value.includes(normalize(pattern)));
}

async function locateBulletin(dateString, { historical = false } = {}) {
  const compact = dateString.replaceAll('-', '');
  const estimate = publicationDayEstimate(dateString);
  const spread = historical ? 12 : 4;
  const candidates = [estimate];
  for (let distance = 1; distance <= spread; distance += 1) {
    candidates.push(estimate - distance, estimate + distance);
  }
  const validCandidates = candidates.filter(number => number > 0 && number <= 366);

  let temporaryFailures = 0;
  const urls = validCandidates.flatMap(number => [
    { number, url: `${BASE}/boletin/bocm-${compact}-${number}` },
    { number, url: `${BASE}/boletin/bocm-${compact}${number}` }
  ]);
  const inspect = async ({ number, url }) => {
      const response = await fetchResource(url, {
        timeoutMs: historical ? 3500 : 10000, attempts: historical ? 1 : 2
      });
      if (response.kind === 'transient') temporaryFailures += 1;
      if (response.kind === 'ok' && bulletinPageLooksValid(response.text, compact, number)) {
        return { number, url, html: response.text };
      }
      return null;
  };
  for (let index = 0; index < urls.length; index += historical ? 3 : 1) {
    const inspected = await Promise.all(urls.slice(index, index + (historical ? 3 : 1)).map(inspect));
    const found = inspected.find(Boolean);
    if (found) return found;
  }
  // Un fallo de red no demuestra que el día carezca de boletín.
  if (temporaryFailures) throw new Error('El BOCM no respondió al comprobar esta fecha. Vuelve a intentarlo.');
  return null;
}

function extractCves(html, compactDate) {
  const matches = html.match(new RegExp(`BOCM-${compactDate}-\\d+`, 'gi')) || [];
  return [...new Set(matches.map(value => value.toUpperCase()))]
    .sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop()));
}

function absoluteUrl(href, parent = BASE) {
  try {
    return new URL(href, parent).href;
  } catch {
    return '';
  }
}

function selectSectionPages(bulletinHtml, bulletinUrl) {
  const $ = cheerio.load(bulletinHtml);
  const selected = [];

  // El HTML del sumario puede cambiar el orden o el tipo de sus encabezados.
  // Para no perder anuncios, se recorren todas las páginas intermedias del
  // boletín y el filtrado temático se realiza después sobre el XML oficial.
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const url = absoluteUrl(href, bulletinUrl);
    if (!url || !url.includes('/boletin-completo/')) return;
    if (!url.includes(`/bocm-${bulletinUrl.match(/bocm-(\d{8})-/i)?.[1] || ''}/`)) {
      // Se acepta igualmente cuando la URL relativa no repite el identificador,
      // siempre que pertenezca al dominio oficial y a boletin-completo.
      try {
        if (new URL(url).hostname !== 'www.bocm.es') return;
      } catch { return; }
    }
    selected.push(url);
  });

  return [...new Set(selected)];
}

async function discoverCvesFromSectionPages(bulletin, compactDate) {
  const sectionUrls = selectSectionPages(bulletin.html, bulletin.url);
  if (!sectionUrls.length) {
    return { sectionPages: 0, cves: extractCves(bulletin.html, compactDate) };
  }

  const pages = await mapConcurrent(sectionUrls, 12, async url => {
    const html = await fetchText(url, { timeoutMs: 6500 });
    return html || '';
  });

  const cves = [...new Set(
    pages.flatMap(html => extractCves(html, compactDate))
  )].sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop()));

  return { sectionPages: sectionUrls.length, cves };
}

function xmlUrlFromCve(cve) {
  const match = cve.match(/^BOCM-(\d{4})(\d{2})(\d{2})-(\d+)$/i);
  if (!match) return '';
  return `${BASE}/boletin/CM_Orden_BOCM/${match[1]}/${match[2]}/${match[3]}/${cve}.xml`;
}

function textOf($, selector) {
  return $(selector).first().text().replace(/\s+/g, ' ').trim();
}

function parseXmlRecord(xml, cve) {
  if (!xml || !xml.includes('<documento')) return null;
  const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: true });
  const metadataSection = textOf($, 'documento > metadatos > seccion');
  const analysisSection = textOf($, 'documento > analisis > seccion');
  const department = textOf($, 'documento > metadatos > departamento');
  const organization = textOf($, 'documento > analisis > organismo');
  return {
    cve: textOf($, 'documento > metadatos > identificador') || cve,
    title: textOf($, 'documento > metadatos > titulo'),
    section: analysisSection || metadataSection,
    department,
    organization,
    body: textOf($, 'documento > texto'),
    htmlUrl: textOf($, 'documento > metadatos > url_html') || `${BASE}/${cve.toLowerCase()}`,
    bulletinNumber: textOf($, 'documento > metadatos > diario_numero'),
    publicationDate: textOf($, 'documento > metadatos > fecha_publicacion')
  };
}

function classifyRecord(record) {
  const title = normalize(record.title);
  const section = normalize(record.section);
  const department = normalize(record.department);
  const organization = normalize(record.organization);
  const source = `${department} ${organization}`;

  if (!title) return null;
  if (section.includes('autoridades y personal')) return null;

  // Regla cerrada para III. ADMINISTRACION LOCAL AYUNTAMIENTOS:
  // - Si la seccion contiene AYUNTAMIENTOS y el titulo contiene URBANISMO,
  //   el anuncio se incluye siempre, con independencia del orden o de las
  //   palabras intermedias del titulo.
  // - Si contiene AYUNTAMIENTOS pero el titulo no contiene URBANISMO,
  //   se descarta antes de aplicar cualquier otra regla positiva.
  const isLocalCouncil = section.includes('ayuntamientos')
    || section.includes('administracion local');
  if (isLocalCouncil) {
    const hasUrbanismo = /\burbanismo\b/.test(title);
    if (!hasUrbanismo) return null;
    const localMatches = LOCAL_URBAN_TERMS.filter(term => title.includes(normalize(term)));
    return {
      score: 112,
      reason: 'Ayuntamiento - Urbanismo',
      matches: localMatches.length ? localMatches.slice(0, 5) : ['urbanismo']
    };
  }

  if (containsAny(source, EXCLUDED_DEPARTMENTS)) return null;

  const lawAction = /\b(ley|leyes)\b/.test(title)
    && /\b(aprueba|aprobacion|modifica|modificacion|deroga|derogacion)\b/.test(title);
  if (section.includes('disposiciones generales') && lawAction) {
    return { score: 108, reason: 'Aprobación, modificación o derogación de una ley', matches: ['ley'] };
  }

  const investmentMatches = INVESTMENT_PROGRAM_TERMS.filter(term => title.includes(normalize(term)));
  if (investmentMatches.length) {
    return { score: 110, reason: 'Programa de Inversión Regional', matches: investmentMatches.slice(0, 5) };
  }

  const expropriationMatches = EXPROPRIATION_TERMS.filter(term => title.includes(normalize(term)));
  if (expropriationMatches.length) {
    return { score: 108, reason: 'Actuación o procedimiento de expropiación', matches: expropriationMatches.slice(0, 5) };
  }

  const urbanMatches = URBAN_AND_CIVIL_TITLE_TERMS.filter(term => title.includes(normalize(term)));
  const environmentalMatches = ENVIRONMENTAL_TITLE_TERMS.filter(term => title.includes(normalize(term)));
  const technicalMatches = [...new Set([...urbanMatches, ...environmentalMatches])];

  const agricultureOnly = containsAny(title, AGRICULTURE_ONLY_TERMS) && technicalMatches.length === 0;
  if (agricultureOnly) return null;

  const isC = section.includes('otras disposiciones');
  if (isC) {
    if (!department.includes(TARGET_C_DEPARTMENT)) return null;
    if (!technicalMatches.length) return null;
    return { score: 104, reason: 'Disposición técnica de Medio Ambiente o territorio', matches: technicalMatches.slice(0, 5) };
  }

  const isD = section.includes('anuncios');
  if (isD) {
    const allowedDepartment = TARGET_D_DEPARTMENTS.some(term => department.includes(term));
    if (!allowedDepartment) return null;

    if (technicalMatches.length) {
      return { score: 104, reason: 'Anuncio técnico de una consejería de interés', matches: technicalMatches.slice(0, 5) };
    }

    const fundingMatches = FUNDING_TERMS.filter(term => title.includes(normalize(term)));
    if (fundingMatches.length && technicalMatches.length) {
      return { score: 102, reason: 'Subvención o convenio vinculado a urbanismo u obra civil', matches: [...fundingMatches, ...technicalMatches].slice(0, 5) };
    }

    const isOpenContract = containsAny(title, OPEN_CONTRACT_TERMS) && !containsAny(title, CLOSED_CONTRACT_TERMS);
    if (isOpenContract && urbanMatches.length) {
      return { score: 100, reason: 'Licitación de ingeniería civil o urbanismo', matches: urbanMatches.slice(0, 5) };
    }
    return null;
  }

  // Regla transversal: títulos inequívocamente técnicos pueden aparecer en
  // otras ramas sin perderse, salvo que el organismo esté expresamente vetado.
  if (technicalMatches.length) {
    return { score: 98, reason: 'Actuación relacionada con urbanismo, ingeniería o medio ambiente', matches: technicalMatches.slice(0, 5) };
  }

  return null;
}

function municipalityFromRecord(record) {
  if (normalize(record.section).includes('administracion local') && record.organization) {
    return record.organization.replace(/\s+/g, ' ').trim();
  }
  const titleMatch = record.title.match(/^[-–—]?\s*([^.]+)\.\s*Urbanismo\b/i);
  if (titleMatch) return titleMatch[1].trim();
  return 'Ámbito autonómico o no identificado';
}

function cleanBody(record) {
  let body = String(record.body || '').replace(/\s+/g, ' ').trim();
  const title = String(record.title || '').replace(/^[-–—]\s*/, '').trim();
  if (title) {
    const pos = normalize(body).indexOf(normalize(title));
    if (pos >= 0) body = body.slice(Math.min(body.length, pos + title.length)).trim();
  }
  body = body
    .replace(/^I{1,3}\.\s+COMUNIDAD DE MADRID\s*/i, '')
    .replace(/^III\.\s+ADMINISTRACIÓN LOCAL\s*/i, '')
    .replace(/^AYUNTAMIENTO DE\s+[^.]{2,100}\s*/i, '')
    .replace(/^URBANISMO\s*/i, '')
    .replace(/^\d+\s*/, '')
    .trim();
  return body;
}

function buildSummary(record) {
  const body = cleanBody(record);
  if (!body) return record.title;
  const sentences = body.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [body];
  const useful = sentences
    .map(value => value.trim())
    .filter(value => value.length >= 45)
    .slice(0, 2)
    .join(' ');
  return (useful || body).slice(0, 620);
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function fetchXmlRecordDetailed(cve, { timeoutMs = 5200, attempts = 1 } = {}) {
  const url = xmlUrlFromCve(cve);
  const response = await fetchResource(url, { timeoutMs, attempts });
  if (response.kind !== 'ok') return { status: response.kind, record: null };
  const record = parseXmlRecord(response.text, cve);
  return record
    ? { status: 'ok', record }
    : { status: 'transient', record: null };
}

function cveNumber(cve = '') {
  return Number(String(cve).split('-').pop()) || 0;
}

async function fetchNumber(compact, number, options = {}) {
  const cve = `BOCM-${compact}-${number}`;
  const result = await fetchXmlRecordDetailed(cve, options);
  return { number, ...result };
}

async function probeNumber(compact, number) {
  let result = await fetchNumber(compact, number, { timeoutMs: 4800, attempts: 1 });
  if (result.status === 'transient') {
    result = await fetchNumber(compact, number, { timeoutMs: 7000, attempts: 1 });
  }
  return result;
}

async function discoverLastNumber(compact, summaryCves = []) {
  const advertised = summaryCves.map(cveNumber).filter(Number.isFinite).filter(n => n > 0);
  let lower = advertised.length ? Math.max(...advertised) : 1;

  // Si el sumario aporta CVE, se comprueba un margen corto por si omite el final.
  if (advertised.length) {
    let lastOk = lower;
    for (let n = lower + 1; n <= Math.min(lower + 16, 320); n += 1) {
      const probe = await probeNumber(compact, n);
      if (probe.status === 'ok') lastOk = n;
      else if (probe.status === 'not_found') return { lastNumber: lastOk, incomplete: false };
      else return { lastNumber: lastOk, incomplete: true };
    }
    return { lastNumber: lastOk, incomplete: false };
  }

  // Respaldo general: búsqueda exponencial y después binaria. Requiere pocas
  // peticiones y no depende de una fecha concreta ni del HTML del sumario.
  let upper = 16;
  let incomplete = false;
  while (upper <= 320) {
    const probe = await probeNumber(compact, upper);
    if (probe.status === 'ok') {
      lower = upper;
      upper *= 2;
      continue;
    }
    if (probe.status === 'transient') incomplete = true;
    break;
  }
  upper = Math.min(upper, 321);

  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const probe = await probeNumber(compact, middle);
    if (probe.status === 'ok') lower = middle;
    else {
      if (probe.status === 'transient') incomplete = true;
      upper = middle;
    }
  }
  return { lastNumber: lower, incomplete };
}

async function discoverCvesFromOfficialSummary(date, firstRecord) {
  const compact = date.replaceAll('-', '');
  const bulletinNumber = Number(firstRecord?.bulletinNumber || 0);
  if (!bulletinNumber) return { cves: [], sectionPages: 0 };

  const urls = [
    `${BASE}/boletin/bocm-${compact}-${bulletinNumber}`,
    `${BASE}/boletin/bocm-${compact}${bulletinNumber}`
  ];
  for (const url of urls) {
    const html = await fetchText(url, { timeoutMs: 6500, attempts: 1 });
    if (!html) continue;
    const bulletin = { number: bulletinNumber, url, html };
    const direct = extractCves(html, compact);
    const sections = await discoverCvesFromSectionPages(bulletin, compact);
    return {
      cves: [...new Set([...direct, ...sections.cves])]
        .sort((a, b) => cveNumber(a) - cveNumber(b)),
      sectionPages: sections.sectionPages
    };
  }
  return { cves: [], sectionPages: 0 };
}

async function fetchRecordsRobust(date) {
  const compact = date.replaceAll('-', '');
  const diagnostics = {
    mode: 'xml-range',
    summaryCves: 0,
    sectionPages: 0,
    transientFailures: 0,
    verifiedMissing: 0,
    incomplete: false,
    lastNumber: 0
  };

  const first = await probeNumber(compact, 1);
  if (first.status === 'not_found') {
    return { records: [], diagnostics, definitelyMissing: true };
  }
  if (first.status !== 'ok') {
    diagnostics.incomplete = true;
    return { records: [], diagnostics, definitelyMissing: false };
  }

  const summary = await discoverCvesFromOfficialSummary(date, first.record);
  diagnostics.summaryCves = summary.cves.length;
  diagnostics.sectionPages = summary.sectionPages;

  const boundary = await discoverLastNumber(compact, summary.cves);
  diagnostics.lastNumber = boundary.lastNumber;
  diagnostics.incomplete = boundary.incomplete;

  const numbers = Array.from({ length: boundary.lastNumber }, (_, index) => index + 1);
  const initial = await mapConcurrent(numbers, 18, number =>
    fetchNumber(compact, number, { timeoutMs: 4500, attempts: 1 })
  );

  const recordsByNumber = new Map();
  const transientNumbers = [];
  for (const item of initial) {
    if (item.status === 'ok') recordsByNumber.set(item.number, item.record);
    else if (item.status === 'transient') transientNumbers.push(item.number);
    else diagnostics.verifiedMissing += 1;
  }

  // Solo los fallos temporales reciben un segundo intento. Los 404 no se repiten.
  if (transientNumbers.length) {
    const retry = await mapConcurrent(transientNumbers, 10, number =>
      fetchNumber(compact, number, { timeoutMs: 7000, attempts: 1 })
    );
    for (const item of retry) {
      if (item.status === 'ok') recordsByNumber.set(item.number, item.record);
      else {
        diagnostics.transientFailures += 1;
        diagnostics.incomplete = true;
      }
    }
  }

  const records = [...recordsByNumber.values()]
    .sort((a, b) => cveNumber(a.cve) - cveNumber(b.cve));
  return { records, diagnostics, definitelyMissing: false };
}

export async function searchBocm(date, municipalityText = '') {
  // El motor de clasificación XML permanece intacto. Esta versión solo
  // refuerza cómo se localizan y enumeran los XML de cualquier fecha.
  const discovery = await fetchRecordsRobust(date);
  const records = discovery.records;
  if (!records.length) {
    return {
      found: false,
      results: [],
      scanned: 0,
      incomplete: discovery.diagnostics.incomplete,
      definitelyMissing: discovery.definitelyMissing,
      discovery: discovery.diagnostics
    };
  }

  const compact = date.replaceAll('-', '');
  const bulletinNumber = Number(records.find(record => record.bulletinNumber)?.bulletinNumber || 0);
  const bulletinUrl = bulletinNumber
    ? `${BASE}/boletin/bocm-${compact}-${bulletinNumber}`
    : `${BASE}/boletin/bocm-${compact}`;

  const municipalityFilter = normalize(municipalityText);
  const results = [];
  for (const record of records) {
    const relevance = classifyRecord(record);
    if (!relevance) continue;
    const municipality = municipalityFromRecord(record);
    if (municipalityFilter) {
      const haystack = normalize(`${municipality} ${record.title} ${record.body}`);
      if (!haystack.includes(municipalityFilter)) continue;
    }
    results.push({
      cve: record.cve,
      title: record.title || record.cve,
      municipality,
      summary: buildSummary(record),
      url: record.htmlUrl,
      score: relevance.score,
      reason: relevance.reason,
      matches: relevance.matches,
      section: record.section,
      department: record.department || record.organization
    });
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'es'));
  return {
    found: true,
    bulletinNumber: bulletinNumber || records[0]?.bulletinNumber || '',
    bulletinUrl,
    scanned: records.length,
    sectionPages: discovery.diagnostics.sectionPages,
    discoveryMode: discovery.diagnostics.mode,
    incomplete: discovery.diagnostics.incomplete,
    discovery: discovery.diagnostics,
    results
  };
}

// Consulta fragmentada para Vercel: cada invocacion procesa un lote pequeno
// de XML. El clasificador y las reglas anteriores no se modifican.
export async function searchBocmBatch(date, municipalityText = '', startValue = 1, sizeValue = 12) {
  const compact = String(date || '').replaceAll('-', '');
  const start = Math.max(1, Math.min(400, Number(startValue) || 1));
  const size = Math.max(1, Math.min(15, Number(sizeValue) || 12));
  const numbers = Array.from({ length: size }, (_, index) => start + index);

  const fetched = await mapConcurrent(numbers, Math.min(12, size), number =>
    fetchNumber(compact, number, { timeoutMs: 3200, attempts: 1 })
  );

  const municipalityFilter = normalize(municipalityText);
  const results = [];
  let existingCount = 0;
  let missingCount = 0;
  let transientCount = 0;
  let bulletinNumber = 0;

  for (const item of fetched) {
    if (item.status === 'not_found') {
      missingCount += 1;
      continue;
    }
    if (item.status !== 'ok' || !item.record) {
      transientCount += 1;
      continue;
    }

    existingCount += 1;
    const record = item.record;
    if (!bulletinNumber && record.bulletinNumber) {
      bulletinNumber = Number(record.bulletinNumber) || 0;
    }

    const relevance = classifyRecord(record);
    if (!relevance) continue;

    const municipality = municipalityFromRecord(record);
    if (municipalityFilter) {
      const haystack = normalize(`${municipality} ${record.title} ${record.body}`);
      if (!haystack.includes(municipalityFilter)) continue;
    }

    results.push({
      cve: record.cve,
      title: record.title || record.cve,
      municipality,
      summary: buildSummary(record),
      url: record.htmlUrl,
      score: relevance.score,
      reason: relevance.reason,
      matches: relevance.matches,
      section: record.section,
      department: record.department || record.organization
    });
  }

  results.sort((a, b) => b.score - a.score || cveNumber(a.cve) - cveNumber(b.cve));

  return {
    found: existingCount > 0,
    start,
    size,
    nextStart: start + size,
    existingCount,
    missingCount,
    transientCount,
    bulletinNumber,
    results
  };
}



// Índice exacto del boletín: utiliza el XML oficial del sumario completo.
// No estima el último CVE ni recorre números inexistentes.
function dailySummaryXmlUrl(date, bulletinNumber) {
  const compact = String(date || '').replaceAll('-', '');
  const [year, month, day] = String(date || '').split('-');
  return `${BASE}/boletin/CM_Boletin_BOCM/${year}/${month}/${day}/BOCM-${compact}${bulletinNumber}.xml`;
}

export async function getBocmManifest(date, { historical = false } = {}) {
  const compact = String(date || '').replaceAll('-', '');

  // El número del boletín se obtiene desde su página oficial, no desde el
  // primer XML individual. Así un fallo puntual del anuncio -1 no invalida
  // todo el día.
  const bulletin = await locateBulletin(date, { historical });
  if (!bulletin) {
    return { found: false, cves: [], bulletinNumber: 0, bulletinUrl: '' };
  }

  const bulletinNumber = Number(bulletin.number || 0);
  const summaryUrl = dailySummaryXmlUrl(date, bulletinNumber);
  const summary = await fetchResource(summaryUrl, {
    timeoutMs: historical ? 8000 : 12000, attempts: historical ? 2 : 3
  });
  if (summary.kind !== 'ok' || !summary.text) {
    throw new Error('No se pudo obtener el sumario XML completo del boletín.');
  }

  // Se eliminan identificadores repetidos y el identificador genérico del
  // boletín, conservando solo CVE individuales terminados en -número.
  const cves = extractCves(summary.text, compact)
    .filter(cve => /^BOCM-\d{8}-\d+$/.test(cve));
  if (!cves.length) {
    throw new Error('El sumario XML no contiene la relación de anuncios del día.');
  }

  return {
    found: true,
    bulletinNumber,
    bulletinUrl: bulletin.url || `${BASE}/boletin/bocm-${compact}-${bulletinNumber}`,
    summaryXmlUrl: summaryUrl,
    cves
  };
}

export async function searchBocmCveBatch(date, municipalityText = '', cveValues = []) {
  const compact = String(date || '').replaceAll('-', '');
  const cves = [...new Set((Array.isArray(cveValues) ? cveValues : [])
    .map(value => String(value || '').trim().toUpperCase())
    .filter(value => new RegExp(`^BOCM-${compact}-\\d+$`).test(value))
  )].slice(0, 15);

  const fetched = await mapConcurrent(cves, Math.min(4, cves.length), async cve => {
    const item = await fetchXmlRecordDetailed(cve, { timeoutMs: 9000, attempts: 2 });
    return { cve, ...item };
  });

  const records = [];
  let missingCount = 0;
  let transientCount = 0;
  for (const item of fetched) {
    if (item.status === 'not_found') { missingCount += 1; continue; }
    if (item.status !== 'ok' || !item.record) { transientCount += 1; continue; }
    records.push(item.record);
  }

  const decisions = await analyzeBocmRecords(records);
  const decisionMap = new Map(decisions.map(item => [item.cve, item]));
  const municipalityFilter = normalize(municipalityText);
  const results = [];
  const complementary = [];
  const doubtful = [];
  let excludedCount = 0;

  for (const record of records) {
    const ai = decisionMap.get(record.cve);
    if (!ai || ai.decision === 'excluir') { excludedCount += 1; continue; }

    const municipality = ai.municipio || municipalityFromRecord(record);
    if (municipalityFilter) {
      const haystack = normalize(`${municipality} ${record.title} ${record.body} ${record.organization}`);
      if (!haystack.includes(municipalityFilter)) continue;
    }

    const output = {
      cve: record.cve,
      title: record.title || record.cve,
      municipality,
      summary: ai.resumen || buildSummary(record),
      url: record.htmlUrl,
      score: ai.decision === 'principal' ? 100 : ai.decision === 'complementario' ? 70 : 50,
      reason: ai.motivo || '',
      object: ai.objeto_real || '',
      directRelation: Boolean(ai.relacion_directa),
      matches: ai.categoria ? [ai.categoria] : [],
      category: ai.categoria || 'Sin clasificar',
      decision: ai.decision,
      section: record.section,
      department: record.department || record.organization
    };

    if (ai.decision === 'principal') results.push(output);
    else if (ai.decision === 'complementario') complementary.push(output);
    else doubtful.push(output);
  }

  const sortCve = (a, b) => cveNumber(a.cve) - cveNumber(b.cve);
  results.sort(sortCve);
  complementary.sort(sortCve);
  doubtful.sort(sortCve);

  const failedCves = fetched.filter(item => item.status !== 'ok' || !item.record).map(item => item.cve);
  return {
    existingCount: records.length,
    missingCount,
    transientCount,
    excludedCount,
    failedCves,
    results,
    complementary,
    doubtful
  };
}

// La revisión opcional aplica a las coincidencias el mismo clasificador de
// dos etapas que utiliza la consulta diaria.
export async function searchHistoricalCveBatch(date, query, municipalityText = '', cveValues = [], relevanceFilter = false) {
  const compact = date.replaceAll('-', '');
  const cves = [...new Set(cveValues.map(value => String(value).toUpperCase()))]
    .filter(cve => new RegExp(`^BOCM-${compact}-\\d+$`).test(cve))
    .slice(0, 12);
  const fetched = await mapConcurrent(cves, 3, async cve => ({
    cve,
    ...await fetchXmlRecordDetailed(cve, { timeoutMs: 7500, attempts: 1 })
  }));
  const results = [];
  const matchedRecords = [];
  const failedCves = [];
  const failedDetails = [];
  let existingCount = 0;
  const municipalityFilter = normalize(municipalityText);

  for (const item of fetched) {
    if (item.status !== 'ok' || !item.record) {
      failedCves.push(item.cve);
      failedDetails.push({ cve: item.cve, reason: item.status === 'not_found' ? 'not_found' : 'transient' });
      continue;
    }
    existingCount += 1;
    const record = item.record;
    const municipality = municipalityFromRecord(record);
    if (municipalityFilter && !normalize(`${municipality} ${record.organization} ${record.title} ${record.body}`)
      .includes(municipalityFilter)) continue;

    const fields = [
      ['Texto del anuncio', record.body],
      ['Título', record.title],
      ['Organismo', record.organization],
      ['Departamento', record.department],
      ['Sección', record.section]
    ];
    for (const [source, content] of fields) {
      const match = findLiteralMatch(content, query);
      if (!match) continue;
      const result = {
        date,
        cve: record.cve,
        title: record.title || record.cve,
        department: record.department,
        organization: record.organization,
        municipality: municipality === 'Ámbito autonómico o no identificado' ? '' : municipality,
        url: `${BASE}/${record.cve.toLowerCase()}`,
        source,
        excerpt: matchingExcerpt(content, match)
      };
      results.push(result);
      matchedRecords.push(record);
      break;
    }
  }

  if (relevanceFilter && matchedRecords.length) {
    let decisions;
    try {
      decisions = await analyzeBocmRecords(matchedRecords);
    } catch (error) {
      error.isHistoricalRelevanceError = true;
      throw error;
    }
    const byCve = new Map(decisions.map(item => [item.cve, item]));
    const selected = results.flatMap(result => {
      const ai = byCve.get(result.cve);
      if (!ai || !['principal', 'complementario'].includes(ai.decision)) return [];
      return [{
        ...result,
        municipality: ai.municipio || result.municipality,
        decision: ai.decision,
        category: ai.categoria || '',
        summary: ai.resumen || '',
        reason: ai.motivo || ''
      }];
    });
    return { existingCount, failedCves, failedDetails, results: selected };
  }

  return { existingCount, failedCves, failedDetails, results };
}

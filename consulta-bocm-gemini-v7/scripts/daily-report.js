import { collectDailyReport, formatReport, madridDate, parseMailConfig, sendWithGmail, validateDate } from '../lib/daily-report.js';
import { appendFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const baseUrl = process.env.BOCM_APP_URL;
if (!baseUrl || new URL(baseUrl).protocol !== 'https:') {
  throw new Error('Configura BOCM_APP_URL con la URL HTTPS pública de Bocmi.');
}
const date = validateDate(process.env.BOCM_DATE || madridDate());
const dryRun = process.env.BOCM_DRY_RUN === 'true';
if (!dryRun) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) {
    throw new Error('El envío automático requiere GITHUB_REPOSITORY y GITHUB_TOKEN para comprobar duplicados.');
  }
  const artifactsUrl = new URL(`https://api.github.com/repos/${repository}/actions/artifacts`);
  artifactsUrl.searchParams.set('name', `bocmi-report-${date}`);
  artifactsUrl.searchParams.set('per_page', '100');
  const response = await fetch(artifactsUrl, { headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  } });
  if (!response.ok) throw new Error(`No se pudo comprobar si el correo ya fue enviado (GitHub HTTP ${response.status}).`);
  const data = await response.json();
  if ((data.artifacts || []).some(item => !item.expired)) {
    console.log(`El informe del ${date} ya figura como enviado. No se repite.`);
    process.exit(0);
  }
}
const report = await collectDailyReport(baseUrl, date);
const message = formatReport(report);

console.log(`Fecha ${date}: boletín ${report.found ? report.bulletinNumber : 'no localizado'}, ` +
  `${report.scanned} anuncios revisados; ${report.principal.length} principales, ` +
  `${report.complementary.length} complementarios y ${report.doubtful.length} pendientes.`);

if (dryRun) {
  console.log('Vista previa sin envío:');
  console.log(message.subject);
  console.log(message.text);
} else {
  let confirmation;
  if (process.env.GOOGLE_APP_PASSWORD) {
    const { from, to } = parseMailConfig(process.env, { requireOAuth: false });
    const result = spawnSync('python3', ['scripts/send-smtp.py'], {
      input: JSON.stringify({ from, to, ...message }), encoding: 'utf8',
      env: process.env, timeout: 45000
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Falló el envío SMTP: ${result.stderr?.trim() || result.error?.message || 'error desconocido'}`);
    }
    confirmation = 'Gmail SMTP aceptó el mensaje';
  } else {
    const messageId = await sendWithGmail(message, process.env);
    confirmation = `Gmail ID ${messageId}`;
  }
  console.log(`Informe enviado. ${confirmation}`);
  await writeFile('.bocmi-sent.txt', `BOCM ${date}, ${confirmation}\n`, { mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `sent_date=${date}\n`);
}

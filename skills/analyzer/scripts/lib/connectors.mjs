// Optional read-only connectors. The only Analyzer7 code that uses the
// network, and only when `connect.mjs` is run explicitly.
//
// - Credentials are referenced, never stored: a service-account file path
//   (`auth.credentials_file`) or an env var naming one / holding an API key
//   (`auth.env_vars`). Nothing fetched from them is written to state.
// - Scopes are read-only and fixed here, not configurable.
// - Every response is written to a temporary export file and ingested through
//   the normal path, so provenance and hashing are identical to a manual export.
// - ANALYZER_CONNECTOR_ENDPOINTS (JSON) overrides base URLs, for tests only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UsageError, isoDate} from './core.mjs';

export const SCOPES = {
  gsc: 'https://www.googleapis.com/auth/webmasters.readonly',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
};

const DEFAULT_ENDPOINTS = {
  gsc: 'https://searchconsole.googleapis.com',
  ga4: 'https://analyticsdata.googleapis.com',
  psi: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
  clarity: 'https://www.clarity.ms/export-data/api/v1/project-live-insights',
};

export function endpoints() {
  const override = process.env.ANALYZER_CONNECTOR_ENDPOINTS ? JSON.parse(process.env.ANALYZER_CONNECTOR_ENDPOINTS) : {};
  return {...DEFAULT_ENDPOINTS, ...override};
}

function expandHome(filePath) {
  return filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

// Resolve the service-account file from the source's auth reference.
export function credentialsFile(source) {
  const auth = source.auth ?? {};
  const fromEnv = (auth.env_vars ?? []).map((name) => process.env[name]).find((value) => value && fs.existsSync(expandHome(value)));
  const candidate = auth.credentials_file ? expandHome(auth.credentials_file) : fromEnv ? expandHome(fromEnv) : process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!candidate || !fs.existsSync(candidate)) throw new UsageError(`source ${source.id}: no service-account file found (set auth.credentials_file with record.mjs source --credentials-file, or name an env var with --env-vars)`);
  return candidate;
}

export function envSecret(source) {
  const name = (source.auth?.env_vars ?? []).find((variable) => process.env[variable]);
  return name ? process.env[name] : null;
}

const base64url = (input) => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// OAuth2 service-account flow (RFC 7523): sign a JWT with the key, exchange it.
export async function googleAccessToken(source, scope) {
  const key = JSON.parse(fs.readFileSync(credentialsFile(source), 'utf8'));
  const tokenUri = endpoints().token ?? key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}))}.${base64url(JSON.stringify({iss: key.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600}))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const response = await fetch(tokenUri, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}`})});
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`token exchange failed: HTTP ${response.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim());
  return body.access_token;
}

async function postJson(url, token, payload) {
  const response = await fetch(url, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error?.message ?? response.statusText}`);
  return body;
}

// ---------- Search Console ----------

export async function gscSearchAnalytics(source, {start, end, dimensions, dataState = 'final', filters = {}}) {
  const token = await googleAccessToken(source, SCOPES.gsc);
  const site = encodeURIComponent(source.property);
  const rows = [];
  for (let startRow = 0; ; startRow += 25000) {
    const body = {startDate: start, endDate: end, dimensions, rowLimit: 25000, startRow, dataState};
    if (Object.keys(filters).length) body.dimensionFilterGroups = [{filters: Object.entries(filters).map(([dimension, expression]) => ({dimension, operator: 'equals', expression}))}];
    const page = (await postJson(`${endpoints().gsc}/webmasters/v3/sites/${site}/searchAnalytics/query`, token, body)).rows ?? [];
    rows.push(...page);
    if (page.length < 25000) break;
  }
  return {request: {site: source.property, start, end, dimensions, dataState, filters}, rows};
}

export async function gscLatestFinalDate(source) {
  const end = isoDate(new Date().toISOString());
  const start = isoDate(new Date(Date.now() - 20 * 86400000).toISOString());
  const {rows} = await gscSearchAnalytics(source, {start, end, dimensions: ['date']});
  return rows.length ? rows.map((row) => row.keys[0]).sort().at(-1) : null;
}

export async function gscInspect(source, urls) {
  const token = await googleAccessToken(source, SCOPES.gsc);
  const results = [];
  for (const url of urls) {
    try {
      const body = await postJson(`${endpoints().gsc}/v1/urlInspection/index:inspect`, token, {inspectionUrl: url, siteUrl: source.property});
      const status = body.inspectionResult?.indexStatusResult ?? {};
      results.push({url, coverage_state: status.coverageState ?? '', google_canonical: status.googleCanonical ?? '', user_canonical: status.userCanonical ?? '', last_crawl: status.lastCrawlTime ?? ''});
    } catch (error) {
      results.push({url, coverage_state: `unknown (${error.message.slice(0, 80)})`, google_canonical: '', user_canonical: '', last_crawl: ''});
    }
  }
  return results;
}

// ---------- GA4 ----------

export async function ga4Report(source, {start, end, dimensions, metrics}) {
  if (!dimensions.includes('date')) throw new UsageError('GA4 pulls must include the date dimension (Analyzer7 stores daily series)');
  const token = await googleAccessToken(source, SCOPES.ga4);
  const property = String(source.property).replace(/^properties\//, '');
  const rows = [];
  for (let offset = 0; ; offset += 100000) {
    const body = await postJson(`${endpoints().ga4}/v1beta/properties/${property}:runReport`, token, {dateRanges: [{startDate: start, endDate: end}], dimensions: dimensions.map((name) => ({name})), metrics: metrics.map((name) => ({name})), limit: 100000, offset});
    for (const row of body.rows ?? []) {
      const record = {};
      dimensions.forEach((name, index) => {
        const value = row.dimensionValues[index].value;
        record[name === 'date' ? 'date' : name] = name === 'date' ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
      });
      metrics.forEach((name, index) => {
        record[name] = row.metricValues[index].value;
      });
      rows.push(record);
    }
    if ((body.rows ?? []).length < 100000) break;
  }
  return rows;
}

// ---------- Crawl ----------

function extract(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").trim() : '';
}

async function getPage(url) {
  const response = await fetch(url, {redirect: 'manual', headers: {'User-Agent': 'Analyzer7/1.0 (read-only audit)'}});
  const text = response.status >= 200 && response.status < 300 ? await response.text() : '';
  return {status: response.status, location: response.headers.get('location'), text};
}

export async function sitemapUrls(sitemapUrl, limit = 80) {
  const urls = new Set();
  const index = await getPage(sitemapUrl);
  const locs = [...index.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  const children = locs.filter((loc) => /\.xml(\?|$)/.test(loc)).slice(0, limit);
  if (!children.length) locs.forEach((loc) => urls.add(loc));
  for (const child of children) {
    const page = await getPage(child);
    for (const match of page.text.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(match[1]);
  }
  return urls;
}

export async function crawl(urls, {sitemap = null} = {}) {
  const inSitemap = sitemap ? await sitemapUrls(sitemap) : null;
  const rows = [];
  for (const url of urls) {
    let current = url;
    let first = null;
    let hops = 0;
    let page;
    for (;;) {
      page = await getPage(current);
      first ??= page.status;
      if (page.status < 300 || page.status >= 400 || !page.location || hops >= 5) break;
      current = new URL(page.location, current).toString();
      hops += 1;
    }
    rows.push({
      url,
      status: first,
      redirect_to: hops ? current : '',
      redirect_hops: hops,
      canonical: extract(page.text, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i),
      title: extract(page.text, /<title[^>]*>([\s\S]*?)<\/title>/i),
      meta_description: extract(page.text, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i),
      robots: extract(page.text, /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)/i),
      in_sitemap: inSitemap ? String(inSitemap.has(url)) : '',
      inlinks: '',
    });
  }
  return rows;
}

// ---------- PageSpeed Insights (field data) ----------

export async function pagespeed(source, urls) {
  const key = envSecret(source);
  const rows = [];
  const failures = [];
  for (const url of urls) {
    const query = new URLSearchParams({url, strategy: 'mobile', category: 'performance', ...(key ? {key} : {})});
    const response = await fetch(`${endpoints().psi}?${query}`);
    if (!response.ok) {
      failures.push(`${url}: HTTP ${response.status}`);
      continue;
    }
    const metrics = (await response.json()).loadingExperience?.metrics ?? {};
    const value = (name) => metrics[name]?.percentile ?? '';
    const cls = value('CUMULATIVE_LAYOUT_SHIFT_SCORE');
    rows.push({url, form_factor: 'phone', lcp_p75_ms: value('LARGEST_CONTENTFUL_PAINT_MS'), inp_p75_ms: value('INTERACTION_TO_NEXT_PAINT'), cls_p75: cls === '' ? '' : cls / 100, date: isoDate(new Date().toISOString())});
  }
  return {rows, failures};
}

// ---------- Microsoft Clarity (Data Export API) ----------

// The API returns the last 1–3 days only and is rate-limited per project;
// the token comes from an env var named in the source's auth.env_vars.
export async function clarityInsights(source, {days = 3, dimensions = ['URL']}) {
  const token = envSecret(source);
  if (!token) throw new UsageError(`source ${source.id}: set the Clarity API token in an env var named by --env-vars (it is never stored)`);
  if (days < 1 || days > 3) throw new UsageError('Clarity returns the last 1–3 days only');
  const query = new URLSearchParams({numOfDays: String(days), ...Object.fromEntries(dimensions.slice(0, 3).map((dimension, index) => [`dimension${index + 1}`, dimension]))});
  const response = await fetch(`${endpoints().clarity}?${query}`, {headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}});
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body?.message ?? response.statusText}`);
  return body;
}

export {toCsv, writeExport} from './core.mjs';

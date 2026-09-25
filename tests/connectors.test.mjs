// Optional connectors against a local mock of the Google endpoints and a test
// website. The mock verifies the service-account JWT signature and the
// read-only scope, so the auth flow is exercised for real — only the host is fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SCRIPTS, days, readSnapshot, run, tempDir, validateState} from './helpers.mjs';

const exec = promisify(execFile);
const NOW = '2026-10-01T08:00:00Z';

function startMock(publicKey) {
  const seen = {scopes: [], gscBodies: []};
  const token = 'mock-access-token';
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const url = new URL(request.url, 'http://localhost');
      const send = (status, body, type = 'application/json') => {
        response.writeHead(status, {'Content-Type': type});
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (url.pathname === '/token') {
        const assertion = new URLSearchParams(raw).get('assertion');
        const [header, claims, signature] = assertion.split('.');
        const valid = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
        const payload = JSON.parse(Buffer.from(claims, 'base64').toString());
        seen.scopes.push(payload.scope);
        return valid ? send(200, {access_token: token}) : send(401, {error: 'invalid_grant'});
      }
      if (request.headers.authorization !== `Bearer ${token}` && !url.pathname.startsWith('/site') && !url.pathname.startsWith('/psi') && !url.pathname.startsWith('/clarity')) return send(401, {error: {message: 'unauthenticated'}});
      if (url.pathname.endsWith('/searchAnalytics/query')) {
        const body = JSON.parse(raw);
        seen.gscBodies.push(body);
        if (body.dimensions.join() === 'date') return send(200, {rows: days('2026-09-01', 20).map((date) => ({keys: [date], clicks: 10, impressions: 200, ctr: 0.05, position: 7}))});
        if (body.dimensions.join() === 'date,page') return send(200, {rows: days('2026-09-01', 20).flatMap((date) => ['/a/', '/b/'].map((page, index) => ({keys: [date, `http://localhost:${server.address().port}/site${page}`], clicks: index ? 2 : 8, impressions: 100, ctr: 0.05, position: 5})))});
        return send(200, {rows: []});
      }
      if (url.pathname === '/v1/urlInspection/index:inspect') return send(200, {inspectionResult: {indexStatusResult: {coverageState: 'Submitted and indexed', googleCanonical: JSON.parse(raw).inspectionUrl, userCanonical: JSON.parse(raw).inspectionUrl}}});
      if (url.pathname.endsWith(':runReport')) return send(200, {rows: days('2026-09-01', 3).flatMap((date) => ['Organic Search', 'Direct'].map((channel) => ({dimensionValues: [{value: date.replace(/-/g, '')}, {value: channel}], metricValues: [{value: channel === 'Direct' ? '5' : '20'}, {value: '1'}]})))});
      if (url.pathname === '/clarity') {
        if (request.headers.authorization !== 'Bearer clarity-test-token') return send(401, {message: 'unauthorized'});
        return send(200, [{metricName: 'Traffic', information: [{totalSessionCount: '50', URL: `http://localhost:${server.address().port}/site/a/`, Device: 'Mobile'}]}, {metricName: 'RageClickCount', information: [{sessionsWithMetricPercentage: 4, URL: `http://localhost:${server.address().port}/site/a/`, Device: 'Mobile'}]}]);
      }
      if (url.pathname === '/psi') return send(200, {loadingExperience: {metrics: {LARGEST_CONTENTFUL_PAINT_MS: {percentile: 2600}, INTERACTION_TO_NEXT_PAINT: {percentile: 150}, CUMULATIVE_LAYOUT_SHIFT_SCORE: {percentile: 5}}}});
      if (url.pathname === '/site/sitemap.xml') return send(200, `<urlset><url><loc>http://localhost:${server.address().port}/site/a/</loc></url></urlset>`, 'application/xml');
      if (url.pathname === '/site/a/') return send(200, '<html><head><title>Page A</title><link rel="canonical" href="/site/a/"><meta name="description" content="About A"></head></html>', 'text/html');
      if (url.pathname === '/site/b/') {
        response.writeHead(301, {Location: '/site/a/'});
        return response.end();
      }
      return send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({server, seen, base: `http://localhost:${server.address().port}`})));
}

test('connectors: GSC, URL inspection, GA4, crawl and PageSpeed fetch read-only and ingest with provenance', async (t) => {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const mock = await startMock(publicKey);
  t.after(() => mock.server.close());
  const secrets = tempDir();
  const keyFile = path.join(secrets, 'service-account.json');
  fs.writeFileSync(keyFile, JSON.stringify({client_email: 'reader@example.iam.gserviceaccount.com', private_key: privateKey.export({type: 'pkcs8', format: 'pem'}), token_uri: `${mock.base}/token`}));
  const project = tempDir();
  run('init.mjs', ['--project', project, '--seed', 'seo', '--now', NOW]);
  const register = (...args) => run('record.mjs', ['source', '--project', project, ...args, '--now', NOW]);
  register('--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--property', `${mock.base}/site/`, '--auth-method', 'service_account_file', '--credentials-file', keyFile);
  register('--id', 'inspection', '--type', 'indexation', '--adapter', 'indexation', '--property', `${mock.base}/site/`, '--auth-method', 'service_account_file', '--credentials-file', keyFile);
  register('--id', 'ga4', '--type', 'analytics', '--adapter', 'timeseries', '--property', 'properties/123', '--auth-method', 'service_account_file', '--credentials-file', keyFile);
  register('--id', 'crawl', '--type', 'crawl', '--adapter', 'crawl', '--auth-method', 'none');
  register('--id', 'psi', '--type', 'performance', '--adapter', 'cwv', '--auth-method', 'api_key_env', '--env-vars', 'PSI_API_KEY');
  const env = {...process.env, ANALYZER_CONNECTOR_ENDPOINTS: JSON.stringify({gsc: mock.base, ga4: mock.base, psi: `${mock.base}/psi`, token: `${mock.base}/token`})};
  const connect = async (...args) => JSON.parse((await exec(process.execPath, [path.join(SCRIPTS, 'connect.mjs'), ...args, '--project', project, '--now', NOW], {env})).stdout);

  const site = await connect('gsc', '--source', 'gsc', '--start', '2026-09-01', '--end', '2026-09-20', '--dimensions', 'date');
  assert.equal(site.row_count, 20);
  assert.equal(site.headline_safe, true);
  assert.equal(mock.seen.gscBodies[0].dataState, 'final');
  const pages = await connect('gsc', '--source', 'gsc', '--start', '2026-09-01', '--end', '2026-09-20', '--dimensions', 'date,page');
  assert.equal(pages.row_count, 40);
  assert.equal((await connect('gsc-latest', '--source', 'gsc')).latest_final_date, '2026-09-20');
  const inspection = await connect('inspect', '--source', 'inspection', '--top-pages', '2', '--pages-source', 'gsc', '--since', '2026-09-01');
  assert.equal(inspection.row_count, 2, 'top pages are ranked from the ingested GSC page data');
  const ga4 = await connect('ga4', '--source', 'ga4', '--start', '2026-09-01', '--end', '2026-09-03', '--dimensions', 'date,sessionDefaultChannelGroup', '--metrics', 'sessions,keyEvents');
  assert.deepEqual(ga4.dimensions, ['date', 'metric', 'sessiondefaultchannelgroup']);
  const ga4Rows = readSnapshot(path.join(project, ga4.observation)).rows;
  assert.equal(ga4Rows.find((row) => row.metric === 'sessions' && row.sessiondefaultchannelgroup === 'Organic Search').value, 20);
  const crawled = await connect('crawl', '--source', 'crawl', '--urls', `${mock.base}/site/a/,${mock.base}/site/b/`, '--sitemap', `${mock.base}/site/sitemap.xml`);
  const crawlRows = readSnapshot(path.join(project, crawled.observation)).rows;
  assert.equal(crawlRows[0].title, 'Page A');
  assert.equal(crawlRows[0].in_sitemap, true);
  assert.equal(crawlRows[1].status, 301);
  assert.equal(crawlRows[1].redirect_hops, 1);
  const psi = await connect('psi', '--source', 'psi', '--urls', `${mock.base}/site/a/`);
  assert.equal(readSnapshot(path.join(project, psi.observation)).rows[0].lcp_p75_ms, 2600);
  register('--id', 'clarity', '--type', 'analytics', '--adapter', 'clarity', '--auth-method', 'api_key_env', '--env-vars', 'CLARITY_API_TOKEN');
  const clarityEnv = {...env, CLARITY_API_TOKEN: 'clarity-test-token', ANALYZER_CONNECTOR_ENDPOINTS: JSON.stringify({...JSON.parse(env.ANALYZER_CONNECTOR_ENDPOINTS), clarity: `${mock.base}/clarity`})};
  const clarity = JSON.parse((await exec(process.execPath, [path.join(SCRIPTS, 'connect.mjs'), 'clarity', '--source', 'clarity', '--days', '3', '--project', project, '--now', NOW], {env: clarityEnv})).stdout);
  assert.equal(clarity.kind, 'behavior');
  assert.deepEqual(clarity.period, {start: '2026-09-29', end: '2026-10-01'});
  assert.equal(readSnapshot(path.join(project, clarity.observation)).rows[0].rage_click_pct, 4);
  assert.doesNotMatch(fs.readFileSync(path.join(project, '.analyzer', 'sources.json'), 'utf8'), /clarity-test-token/, 'the token is never stored');

  assert.ok(mock.seen.scopes.every((scope) => /\.readonly$/.test(scope)), `only read-only scopes: ${mock.seen.scopes.join(', ')}`);
  const state = fs.readFileSync(path.join(project, '.analyzer', 'sources.json'), 'utf8');
  assert.doesNotMatch(state, /PRIVATE KEY/);
  assert.match(state, /"credentials_file":/);
  assert.ok(validateState(project).ok, validateState(project).output);
});

test('connectors: a failed fetch is recorded on the source and nothing is ingested', async (t) => {
  const mock = await startMock(crypto.generateKeyPairSync('rsa', {modulusLength: 2048}).publicKey);
  t.after(() => mock.server.close());
  const {privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const keyFile = path.join(tempDir(), 'wrong-key.json');
  fs.writeFileSync(keyFile, JSON.stringify({client_email: 'reader@example.iam.gserviceaccount.com', private_key: privateKey.export({type: 'pkcs8', format: 'pem'})}));
  const project = tempDir();
  run('init.mjs', ['--project', project, '--seed', 'seo', '--now', NOW]);
  run('record.mjs', ['source', '--project', project, '--id', 'gsc', '--type', 'search', '--adapter', 'gsc', '--property', `${mock.base}/site/`, '--auth-method', 'service_account_file', '--credentials-file', keyFile, '--now', NOW]);
  const env = {...process.env, ANALYZER_CONNECTOR_ENDPOINTS: JSON.stringify({gsc: mock.base, token: `${mock.base}/token`})};
  await assert.rejects(exec(process.execPath, [path.join(SCRIPTS, 'connect.mjs'), 'gsc', '--source', 'gsc', '--start', '2026-09-01', '--end', '2026-09-20', '--dimensions', 'date', '--project', project, '--now', NOW], {env}), /token exchange failed: HTTP 401/);
  const probe = run('state.mjs', ['--project', project, '--now', NOW]);
  assert.equal(probe.sources[0].health, 'unavailable');
  assert.equal(fs.existsSync(path.join(project, '.analyzer', 'observations')), false);
});

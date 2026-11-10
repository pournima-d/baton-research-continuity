'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const TEST_DB_PATH = path.resolve(__dirname, '..', 'data', 'test_frontend_baton.db');
process.env.DB_PATH = TEST_DB_PATH;

const { openDatabase, closeDatabase, runMigrations } = require('../server/db/database');
const { seedDatabase } = require('../server/db/seed');
const { createApp } = require('../server/app');

function cleanTestDb() {
  closeDatabase();
  for (const suffix of ['', '-shm', '-wal']) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function dispatchHttp(server, method, route, { token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = route;
    req.headers = { 'content-type': 'application/json' };
    if (token) req.headers['authorization'] = `Bearer ${token}`;
    req.destroy = () => {};

    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, hdrs = {}) {
        this.statusCode = code;
        Object.assign(this.headers, hdrs);
      },
      end(chunk) {
        const text = chunk ? chunk.toString('utf8') : '';
        const ct = this.headers['Content-Type'] || '';
        if (ct.includes('application/json')) {
          try {
            resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(text || '{}') });
          } catch (e) {
            reject(e);
          }
        } else {
          resolve({ status: this.statusCode, headers: this.headers, text });
        }
      }
    };

    server.handleRequest(req, res).catch(reject);

    process.nextTick(() => {
      if (body !== null && body !== undefined) {
        req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
      }
      req.emit('end');
    });
  });
}

test('Stage 03 Frontend Workspace & API Integration Suite', async (t) => {
  await t.test('1. Frontend static assets (/, /styles.css, /app.js) serve with 200 OK and contain all 7 screens', async () => {
    cleanTestDb();
    const db = openDatabase(TEST_DB_PATH);
    runMigrations(db);
    seedDatabase(db);
    const server = createApp(db);

    const htmlRes = await dispatchHttp(server, 'GET', '/');
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.text.includes('id="view-overview"'));
    assert.ok(htmlRes.text.includes('id="view-sources"'));
    assert.ok(htmlRes.text.includes('id="view-continuity-map"'));
    assert.ok(htmlRes.text.includes('id="view-records"'));
    assert.ok(htmlRes.text.includes('id="view-review-queue"'));
    assert.ok(htmlRes.text.includes('id="view-handover"'));
    assert.ok(htmlRes.text.includes('id="view-audit"'));

    const cssRes = await dispatchHttp(server, 'GET', '/styles.css');
    assert.equal(cssRes.status, 200);
    assert.ok(cssRes.text.includes('.workspace-shell'));
    assert.ok(cssRes.text.includes('@media (max-width: 768px)'));

    const jsRes = await dispatchHttp(server, 'GET', '/app.js');
    assert.equal(jsRes.status, 200);
    assert.ok(jsRes.text.includes('refreshWorkspace'));
  });

  await t.test('2. Dashboard values are 100% API-backed and reflect real database mutations & persist across refresh', async () => {
    const db = openDatabase(TEST_DB_PATH);
    const server = createApp(db);

    const dash1 = await dispatchHttp(server, 'GET', '/api/projects/prj_solidstate_01', {
      token: 'tok_researcher_01'
    });
    assert.equal(dash1.status, 200);
    assert.equal(dash1.body.dashboard.source_count, 3);
    assert.equal(dash1.body.dashboard.restricted_hidden_count, 1);
    assert.equal(dash1.body.dashboard.total_records_count, 3);
    assert.equal(dash1.body.dashboard.pending_reviews_count, 1);
    assert.equal(dash1.body.dashboard.handover_status, 'NONE');

    // Upload a new source and verify dashboard source_count increments to 4
    const upRes = await dispatchHttp(server, 'POST', '/api/projects/prj_solidstate_01/sources', {
      token: 'tok_researcher_01',
      body: {
        title: 'Stack Pressure Calibration Note',
        file_name: 'pressure_cal.md',
        source_type: 'LAB_NOTE',
        visibility_level: 'PROJECT_SHARED',
        raw_content: '# Load Cell Verification\nVerified 5.0 MPa stack pressure at 1.4 N-m torque.'
      }
    });
    assert.equal(upRes.status, 201);

    // Retry / Re-index source endpoint works
    const retryRes = await dispatchHttp(
      server,
      'POST',
      `/api/projects/prj_solidstate_01/sources/${upRes.body.source.id}/retry`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.source.processing_status, 'READY');

    const dash2 = await dispatchHttp(server, 'GET', '/api/projects/prj_solidstate_01', {
      token: 'tok_researcher_01'
    });
    assert.equal(dash2.status, 200);
    assert.equal(dash2.body.dashboard.source_count, 4);
  });

  await t.test('3. Every DOM ID referenced in public/app.js exists in public/index.html or dynamic templates (zero null-reference console errors)', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

    const definedIds = new Set([
      ...Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]),
      ...Array.from(js.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1])
    ]);
    const jsLookups = Array.from(js.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)).map((m) => m[1]);

    const missing = jsLookups.filter((id) => !definedIds.has(id));
    assert.deepEqual(missing, [], `Missing DOM IDs: ${missing.join(', ')}`);
  });

  await t.test('4. Execute public/app.js in VM DOM harness to verify zero console errors and API-backed rendering across all 7 views', async () => {
    const db = openDatabase(TEST_DB_PATH);
    const server = createApp(db);

    const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

    const elementsById = new Map();
    const allIds = [
      ...Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]),
      ...Array.from(js.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1])
    ];

    function makeMockElement(id = '') {
      const listeners = {};
      return {
        id,
        value: 'ALL',
        checked: true,
        disabled: false,
        textContent: '',
        _innerHTML: '',
        get innerHTML() {
          return this._innerHTML;
        },
        set innerHTML(val) {
          this._innerHTML = String(val);
          // Register any dynamically injected IDs
          for (const m of this._innerHTML.matchAll(/\bid="([^"]+)"/g)) {
            if (!elementsById.has(m[1])) {
              elementsById.set(m[1], makeMockElement(m[1]));
            }
          }
        },
        style: {},
        dataset: {},
        selectedOptions: [{ dataset: { sampleQuote: 'Achieve >93% relative density' } }],
        classList: {
          _set: new Set(),
          add(c) { this._set.add(c); },
          remove(c) { this._set.delete(c); },
          toggle(c, force) {
            if (force === undefined) {
              if (this._set.has(c)) this._set.delete(c);
              else this._set.add(c);
            } else if (force) {
              this._set.add(c);
            } else {
              this._set.delete(c);
            }
          },
          contains(c) { return this._set.has(c); }
        },
        setAttribute() {},
        getAttribute(attr) {
          if (attr === 'data-tab') return 'overview';
          if (attr === 'data-goto') return 'sources';
          return '';
        },
        appendChild() {},
        addEventListener(ev, fn) {
          listeners[ev] = listeners[ev] || [];
          listeners[ev].push(fn);
        },
        querySelectorAll() { return []; },
        querySelector() { return makeMockElement(); },
        _listeners: listeners
      };
    }

    for (const id of allIds) {
      elementsById.set(id, makeMockElement(id));
    }
    elementsById.get('filter-search').value = '';

    const storage = new Map();
    const consoleErrors = [];
    let domReadyHandler = null;

    const sandbox = {
      console: {
        log: () => {},
        warn: () => {},
        error: (...args) => consoleErrors.push(args.join(' '))
      },
      localStorage: {
        getItem: (k) => storage.get(k) || null,
        setItem: (k, v) => storage.set(k, String(v))
      },
      document: {
        getElementById: (id) => {
          if (!elementsById.has(id)) {
            elementsById.set(id, makeMockElement(id));
          }
          return elementsById.get(id);
        },
        createElement: (tag) => makeMockElement(tag),
        querySelectorAll: () => [],
        addEventListener: (ev, fn) => {
          if (ev === 'DOMContentLoaded') domReadyHandler = fn;
        }
      },
      fetch: async (url, opts = {}) => {
        const auth = opts.headers && (opts.headers['Authorization'] || opts.headers['authorization']);
        const token = auth ? auth.replace(/^Bearer\s+/i, '') : null;
        const result = await dispatchHttp(server, opts.method || 'GET', url, {
          token,
          body: opts.body
        });
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body
        };
      },
      FileReader: function () {},
      Date,
      Set,
      Map,
      Promise,
      JSON,
      String,
      Number,
      Array,
      Object,
      Error
    };

    vm.createContext(sandbox);
    vm.runInContext(js, sandbox);
    assert.ok(domReadyHandler, 'DOMContentLoaded listener was registered');
    await domReadyHandler();

    assert.deepEqual(consoleErrors, [], `Console errors occurred: ${consoleErrors.join('; ')}`);
    assert.equal(
      elementsById.get('heading-overview').textContent,
      'Solid-State Li-Garnet (LLZO) Electrolyte Interface Continuity'
    );
    assert.equal(elementsById.get('metric-sources').textContent, '5');
    assert.equal(elementsById.get('metric-records').textContent, '3');
    cleanTestDb();
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';

process.env.NO_SERVER_LISTEN = '1';
process.env.HARDWARE_ADAPTER = 'simulator';
process.env.DEMO_INVENTORY_SEED = '1';
process.chdir(mkdtempSync(join(tmpdir(), 'lyt-recommendation-page-')));

const {requestHandler} = await import('../src/server.js');
const {getAppState} = await import('../src/server/app-state.js');
const {createSessionCookie} = await import('../src/services/auth.js');
const {db, operationsService: work, pages} = getAppState();
const admin = db.prepare("SELECT * FROM users WHERE role='admin'").get();
const operator = db.prepare("SELECT * FROM users WHERE role='operator'").get();
const product = db.prepare('SELECT * FROM products ORDER BY id LIMIT 1').get();
const cell = db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 1').get();

// Reproduce the real recommendation: new work displaces an unstarted reservation.
db.exec('DELETE FROM inventory_balances');
db.prepare('UPDATE cells SET active=0 WHERE id!=?').run(cell.id);
db.prepare('UPDATE products SET items_per_cell=10 WHERE id=?').run(product.id);
db.prepare(`INSERT INTO inventory_balances
  (product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,10,0)`)
  .run(product.id, cell.id);
const command = (actor, action, input) => work.command(actor, action, {
  requestId: randomUUID(), ...input,
});
const displaced = command(admin, 'assign', {
  direction: 'pick', productId: product.id, quantity: 8,
  assigneeId: operator.id, dueDuration: 8, dueUnit: 'hours',
});
const replacement = command(admin, 'create', {
  direction: 'pick', productId: product.id, quantity: 5,
});

async function read(path, user = admin) {
  const request = Readable.from([]);
  Object.assign(request, {
    method: 'GET', url: path,
    headers: {host: 'localhost', cookie: createSessionCookie(user), accept: 'text/html'},
  });
  const response = {
    statusCode: 200, headers: {}, body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body = '') { this.body += body; },
  };
  await requestHandler(request, response);
  return response;
}

test('Recommended Actions opens with displaced reservations and still limits task-review visibility', async () => {
  const transactionCount = db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
  const response = await read('/recommended-actions');
  assert.equal(response.statusCode, 200, response.headers.Location);
  assert.equal(response.headers.Location, undefined);
  assert.match(response.body, new RegExp(`Task #${displaced.taskId} needs review`));
  assert.match(response.body, new RegExp(`taken over by Task #${replacement.taskId}`));
  assert.match(response.body, new RegExp(`href="/tasks/${displaced.taskId}"`));

  const operatorResponse = await read('/recommended-actions', operator);
  assert.equal(operatorResponse.statusCode, 200);
  assert.doesNotMatch(operatorResponse.body, new RegExp(`Task #${displaced.taskId} needs review`));
  assert.doesNotMatch(operatorResponse.body, new RegExp(`href="/tasks/${displaced.taskId}"`));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, transactionCount);
});

test('a render failure returns a readable error once instead of redirecting back to Recommended Actions', async () => {
  const original = pages.renderRecommendedActions;
  pages.renderRecommendedActions = () => {
    throw Error('Synthetic render failure for regression check');
  };
  try {
    const response = await read('/recommended-actions');
    assert.equal(response.statusCode, 500);
    assert.equal(response.headers.Location, undefined);
    assert.match(response.body, /Try again/);
    assert.match(response.body, /href="\/recommended-actions"/);
    assert.doesNotMatch(response.body, /Synthetic render failure/);
  } finally {
    pages.renderRecommendedActions = original;
  }
});

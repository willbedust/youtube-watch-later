const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync('extension/watch-later.js', 'utf8');

function setup() {
  const notices = [];
  const doc = { documentElement: { hasAttribute: () => false, setAttribute() {} } };
  const context = { window: {}, document: doc, location: { origin: 'https://www.youtube.com', href: 'https://www.youtube.com/' },
    URL, Element: class {}, console: { warn() {} }, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } } };
  const instrumented = source.replace('  init();\n})();', `
    notify = text => notices.push(text);
    globalThis.api = { makeCommand, request, checkResponse, perform, videoId, isWatchLaterRow, active, saved, uncertain,
      navigate: () => { epoch++; saved.clear(); } };
  })();`);
  context.notices = notices;
  vm.createContext(context);
  vm.runInContext(instrumented, context);
  return { ...context, notices };
}

function cardState(id = 'Ga0nnIR-uA8') {
  const card = { isConnected: true, currentId: id,
    querySelectorAll() { return [{ closest: () => card, getAttribute: () => `/watch?v=${card.currentId}` }]; },
    matches: () => false, closest: () => null, setAttribute() {} };
  return { id, card, button: { isConnected: true, dataset: {}, setAttribute() {} }, path: { setAttribute() {} } };
}

test('only edits WL, with correct add/remove action; rejects invalid IDs', () => {
  const { api } = setup();
  const add = api.makeCommand('Ga0nnIR-uA8', false);
  assert.equal(add.playlistEditEndpoint.playlistId, 'WL');
  assert.equal(add.playlistEditEndpoint.actions[0].addedVideoId, 'Ga0nnIR-uA8');
  const remove = api.makeCommand('Ga0nnIR-uA8', true);
  assert.equal(remove.playlistEditEndpoint.actions[0].action, 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID');
  assert.throws(() => api.makeCommand('bad', false));
});

test('native action includes source, endpoint and reads ajaxPromise', async () => {
  const { api } = setup();
  const command = api.makeCommand('Ga0nnIR-uA8', false);
  const answer = { data: { status: 'STATUS_SUCCEEDED' } };
  const source = { dispatchEvent(event) {
    assert.equal(event.type, 'yt-action');
    assert.equal(event.detail.actionName, 'yt-service-request');
    assert.equal(event.detail.args[0], source);
    assert.equal(event.detail.args[1], command);
    event.detail.returnValue.push({ ajaxPromise: Promise.resolve(answer) });
  } };
  assert.equal(await api.request(source, command), answer);
  assert.throws(() => api.request({ dispatchEvent() {} }, command), /недоступен/);
});

test('server errors and unknown responses never become success', () => {
  const { api } = setup();
  assert.equal(api.checkResponse({ data: { status: 'STATUS_SUCCEEDED' } }), true);
  assert.equal(api.checkResponse({ data: { playlistEditResults: [{}] } }), true);
  for (const result of [null, {}, { data: { error: { message: 'denied' } } },
    { data: { status: 'STATUS_FAILED' } }, { data: { actionResults: [{ status: 'STATUS_FAILED' }] } }]) {
    assert.throws(() => api.checkResponse(result));
  }
});

test('rapid double click sends one request; success is set only after response', async () => {
  const { api } = setup();
  let resolve;
  let calls = 0;
  const state = cardState();
  state.card.dispatchEvent = event => { calls++; event.detail.returnValue.push({ ajaxPromise: new Promise(r => { resolve = r; }) }); };
  const pending = api.perform(state);
  await api.perform(state);
  assert.equal(calls, 1);
  assert.equal(api.saved.has(state.id), false);
  resolve({ data: { status: 'STATUS_SUCCEEDED' } });
  await pending;
  assert.equal(api.saved.get(state.id), true);
  await api.perform(state);
  assert.equal(calls, 1);
});

test('uncertain server response prevents repeated sends', async () => {
  const { api } = setup();
  let calls = 0;
  const state = cardState();
  state.card.dispatchEvent = event => { calls++; event.detail.returnValue.push({ ajaxPromise: Promise.resolve({}) }); };
  await api.perform(state);
  await api.perform(state);
  assert.equal(calls, 1);
  assert.equal(api.saved.has(state.id), false);
  assert.equal(api.uncertain.has(state.id), true);
});

test('navigation during an in-flight save does not set stale success', async () => {
  const { api } = setup();
  let resolve;
  const state = cardState();
  state.card.dispatchEvent = event => event.detail.returnValue.push({ ajaxPromise: new Promise(r => { resolve = r; }) });
  const pending = api.perform(state);
  api.navigate();
  resolve({ data: { status: 'STATUS_SUCCEEDED' } });
  await pending;
  assert.equal(api.saved.has(state.id), false);
});

test('recommendations on WL page are not treated as playlist rows', () => {
  const context = setup();
  context.location.href = 'https://www.youtube.com/playlist?list=WL';
  const { card } = cardState();
  card.matches = selector => selector === 'yt-lockup-view-model';
  assert.equal(context.api.isWatchLaterRow(card), false);
});

test('recycled card cannot submit the previous video ID', async () => {
  const { api } = setup();
  const state = cardState();
  state.card.currentId = '0ZHnq7V-GXA';
  let calls = 0;
  state.card.dispatchEvent = () => calls++;
  await api.perform(state);
  assert.equal(calls, 0);
});

test('WL row is hidden only after successful server deletion', async () => {
  const context = setup();
  context.location.href = 'https://www.youtube.com/playlist?list=WL';
  const state = cardState();
  state.card.matches = selector => selector === 'ytd-playlist-video-renderer';
  const attributes = new Map();
  state.card.setAttribute = (key, value) => attributes.set(key, value);
  let resolve;
  state.card.dispatchEvent = event => {
    assert.equal(event.detail.args[1].playlistEditEndpoint.actions[0].action, 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID');
    event.detail.returnValue.push({ ajaxPromise: new Promise(r => { resolve = r; }) });
  };
  const pending = context.api.perform(state);
  assert.equal(attributes.size, 0);
  resolve({ data: { status: 'STATUS_SUCCEEDED' } });
  await pending;
  assert.equal(attributes.get('data-ytwl-removed'), state.id);
});

test('rejected service promise leaves no success or active operation', async () => {
  const { api } = setup();
  const state = cardState();
  state.card.dispatchEvent = event => event.detail.returnValue.push({ ajaxPromise: Promise.reject(new Error('Offline')) });
  await api.perform(state);
  assert.equal(api.saved.has(state.id), false);
  assert.equal(api.active.has(state.id), false);
  assert.equal(api.uncertain.has(state.id), true);
});

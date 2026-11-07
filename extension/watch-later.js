(() => {
  'use strict';
  if (window.top !== window.self || document.documentElement.hasAttribute('data-ytwl-extension')) return;
  document.documentElement.setAttribute('data-ytwl-extension', '1');

  // MAIN world is required: YouTube mutates returnValue and returns its own Promise.
  // No cookies, tokens, fetch, extension background process or menu automation.
  const CARD = 'yt-lockup-view-model,ytd-rich-grid-media,ytd-video-renderer,ytd-grid-video-renderer,ytd-compact-video-renderer,ytd-playlist-video-renderer,ytd-playlist-panel-video-renderer';
  const OWN = '.ytwl-button,#ytwl-notice';
  const states = new WeakMap();
  const active = new Map();
  const saved = new Map();
  const uncertain = new Set();
  const queue = new Set();
  const pendingCards = new Set();
  let timer = 0;
  let noticeTimer = 0;
  let epoch = 0;
  const paths = {
    add: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
    saved: 'm5 12 4 4L19 6',
    remove: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 10v7 M14 10v7',
    pending: 'M12 3a9 9 0 0 1 9 9',
    error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v6 M12 16v.1'
  };

  function videoId(card) {
    for (const link of card.querySelectorAll('a[href*="/watch?"]')) {
      if (link.closest(CARD) !== card) continue;
      try {
        const url = new URL(link.getAttribute('href'), location.origin);
        const id = url.searchParams.get('v');
        // Playlists/mixes have their own save semantics; do not label them as videos.
        if (url.origin === location.origin && url.pathname === '/watch' &&
            !url.searchParams.has('start_radio') && /^[\w-]{11}$/.test(id || '')) return id;
      } catch { /* Ignore malformed links. */ }
    }
    return null;
  }

  function isWatchLaterRow(card) {
    const url = new URL(location.href);
    if (url.searchParams.get('list') !== 'WL') return false;
    if (card.matches('ytd-playlist-panel-video-renderer')) return true;
    if (url.pathname !== '/playlist' || card.closest('#related,ytd-shelf-renderer,ytd-rich-shelf-renderer')) return false;
    if (card.matches('ytd-playlist-video-renderer')) return true;
    return card.matches('yt-lockup-view-model') && Array.from(card.querySelectorAll('a[href*="/watch?"]')).some(link => {
      try { return new URL(link.getAttribute('href'), location.origin).searchParams.get('list') === 'WL'; }
      catch { return false; }
    });
  }

  function makeCommand(id, remove) {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('Некорректный ID видео.');
    return {
      commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/browse/edit_playlist' } },
      playlistEditEndpoint: {
        playlistId: 'WL',
        actions: [remove ? { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: id } :
          { action: 'ACTION_ADD_VIDEO', addedVideoId: id }]
      }
    };
  }

  function request(source, command) {
    // Reproduce YouTube's _.Jc: args contain the originating node, then endpoint.
    const detail = { actionName: 'yt-service-request', optionalAction: false,
      args: [source, command], returnValue: [] };
    source.dispatchEvent(new CustomEvent('yt-action', { bubbles: true, composed: true, detail }));
    const result = detail.returnValue.find(value => value?.ajaxPromise?.then);
    if (!result) throw new Error('Обработчик YouTube недоступен. Перезагрузите страницу.');
    return result.ajaxPromise;
  }

  function checkResponse(result) {
    // YouTube's service Promise resolves to {data: {response: ...}}.
    const response = result?.data?.response ?? result?.response ?? result?.data ?? result;
    if (!response || typeof response !== 'object') throw new Error('YouTube вернул неизвестный ответ.');
    if (response.error) throw new Error(response.error.message || 'YouTube отклонил действие.');
    const status = response.status;
    if (status && status !== 'STATUS_SUCCEEDED' && status !== 'SUCCESS') {
      throw new Error(`YouTube: ${status}`);
    }
    const actions = response.actionResults || [];
    if (actions.some(action => action.status && action.status !== 'STATUS_SUCCEEDED' && action.status !== 'SUCCESS')) {
      throw new Error('YouTube не выполнил изменение плейлиста.');
    }
    // Require a recognizable server response, not an arbitrary resolved object.
    if (!status && !actions.length && !response.playlistEditResults?.length) {
      throw new Error('YouTube не подтвердил изменение плейлиста. Проверьте список.');
    }
    return true;
  }

  function notify(text) {
    let node = document.getElementById('ytwl-notice');
    if (!node) {
      node = document.createElement('div');
      node.id = 'ytwl-notice';
      node.setAttribute('role', 'status');
      document.body.append(node);
    }
    node.textContent = text;
    node.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { node.hidden = true; }, 6000);
  }

  function paint(state) {
    const mode = active.has(state.id) ? 'pending' : uncertain.has(state.id) ? 'error' :
      isWatchLaterRow(state.card) ? 'remove' : saved.get(state.id) ? 'saved' : 'add';
    const title = { pending: 'Сохраняется…', error: 'Результат не подтверждён. Проверьте «Смотреть позже» и перезагрузите страницу.',
      remove: 'Удалить из «Смотреть позже»', saved: 'Добавлено в «Смотреть позже»', add: 'Добавить в «Смотреть позже»' }[mode];
    if (state.button.dataset.mode !== mode) {
      state.button.dataset.mode = mode;
      state.path.setAttribute('d', paths[mode]);
    }
    state.button.title = title;
    state.button.setAttribute('aria-label', title);
    state.button.disabled = mode === 'pending';
    state.button.setAttribute('aria-busy', String(mode === 'pending'));
  }

  async function perform(state) {
    // Re-read identity on click: YouTube reuses cards during SPA navigation.
    const id = videoId(state.card);
    if (!id || id !== state.id || !state.card.isConnected) { schedule(state.card); return; }
    if (active.has(id)) return;
    if (uncertain.has(id)) { notify('Предыдущий результат не подтверждён. Проверьте список и перезагрузите страницу.'); return; }
    const remove = isWatchLaterRow(state.card);
    if (!remove && saved.get(id)) { notify('Уже добавлено в «Смотреть позже».'); return; }
    const operation = {};
    active.set(id, operation);
    const startedEpoch = epoch;
    paint(state);
    let timeout;
    try {
      const pending = request(state.card, makeCommand(id, remove));
      const result = await Promise.race([pending, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('YouTube не ответил за 10 секунд. Проверьте список перед повторным действием.')), 10000);
      })]);
      checkResponse(result);
      if (epoch !== startedEpoch) return;
      saved.set(id, !remove);
      if (remove && state.card.isConnected && videoId(state.card) === id) {
        // Server has confirmed deletion. Hide the row; clear the marker on reuse.
        state.card.setAttribute('data-ytwl-removed', id);
      }
      notify(remove ? 'Удалено из «Смотреть позже».' : 'Добавлено в «Смотреть позже».');
    } catch (error) {
      // Never retry a possibly sent request automatically.
      if (epoch === startedEpoch) {
        uncertain.add(id);
        notify(error.message || 'Не удалось выполнить действие. Проверьте «Смотреть позже».');
      }
      console.warn('[Watch Later]', error.message);
    } finally {
      clearTimeout(timeout);
      if (active.get(id) === operation) active.delete(id);
      if (state.button.isConnected) paint(state);
    }
  }

  function mount(card) {
    const id = videoId(card);
    let state = states.get(card);
    if (state && (state.id !== id || !state.button.isConnected)) {
      state.button.remove();
      states.delete(card);
      state = null;
    }
    if (card.getAttribute('data-ytwl-removed') !== id) card.removeAttribute('data-ytwl-removed');
    if (!id) return;
    if (!state) {
      // A sibling of the thumbnail link: no nested interactive element or geometry reads.
      const thumb = card.querySelector('yt-thumbnail-view-model,ytd-thumbnail,a#thumbnail');
      const host = thumb?.closest('a')?.parentElement || thumb?.parentElement;
      if (!host || !card.contains(host)) return;
      host.classList.add('ytwl-host');
      thumb.classList.add('ytwl-thumbnail');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ytwl-button';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      svg.append(path);
      button.append(svg);
      state = { card, id, button, path };
      states.set(card, state);
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopImmediatePropagation(); void perform(state);
      });
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'keydown', 'keyup']) {
        button.addEventListener(type, event => event.stopPropagation());
      }
      host.append(button);
    }
    paint(state);
  }

  function schedule(root) {
    if (!(root instanceof Element) && root !== document) return;
    if (root instanceof Element && (root.closest(OWN) || !root.isConnected)) return;
    if (root instanceof Element) root = root.closest(CARD) || root;
    if (queue.has(document)) return;
    if (root === document) queue.clear();
    queue.add(root);
    if (!timer) timer = setTimeout(flush, 60);
  }

  function flush() {
    timer = 0;
    const cards = new Set();
    for (const root of queue) {
      if (root !== document && !root.isConnected) continue;
      if (root instanceof Element && root.matches(CARD)) cards.add(root);
      else root.querySelectorAll(CARD).forEach(card => cards.add(card));
    }
    queue.clear();
    for (const card of cards) pendingCards.add(card);
    const end = performance.now() + 8;
    let count = 0;
    for (const card of pendingCards) {
      pendingCards.delete(card);
      if (card.isConnected) mount(card);
      if (++count >= 32 || performance.now() >= end) break;
    }
    if (pendingCards.size) timer = setTimeout(flush, 16);
  }

  function init() {
    if (document.documentElement.hasAttribute('data-ytc-watch-later-v6')) {
      notify('Отключите старый JS в Enhancer и перезагрузите YouTube: сейчас активны две версии кнопки.');
      return;
    }
    const scope = document.querySelector('ytd-page-manager') || document.body;
    new MutationObserver(records => {
      for (const record of records) {
        if (record.target instanceof Element && record.target.closest(OWN)) continue;
        if (record.type === 'attributes') { schedule(record.target); continue; }
        for (const node of record.addedNodes) {
          if (node instanceof Element && !node.matches(OWN)) schedule(node);
        }
      }
    }).observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
    document.addEventListener('yt-navigate-start', () => { epoch++; saved.clear(); }, true);
    document.addEventListener('yt-navigate-finish', () => schedule(document), true);
    schedule(document);
  }
  init();
})();

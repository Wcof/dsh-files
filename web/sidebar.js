import { t } from './locale.js';
import { icon } from './icons.js';
import { normalizePathInput, pathSegments } from './view-state.js';
import { MAX_PLACES, placesKey, placeIdentity, resolvePlace, readPlaces, writePlaces, movePlace, dropPosition } from './places-state.js';

/** Owns bookmark state and interactions; actual directory reads stay in the shared API. */
export function createSidebar({ roots, platform, home, navigate, call, notice }) {
  const $ = id => document.getElementById(id), nav = $('roots'), dialog = $('place-dialog'), menu = $('place-menu');
  let storage; try { storage = localStorage; } catch { /* Explicit save reports unavailable storage. */ }
  const key = placesKey(platform, home), lifetime = new AbortController();
  let items = readPlaces(storage, key, roots, platform), currentPath = '', busy = false, editing = -1, validating, drag, ghost, frame, suppressClick = 0;
  const on = (target, event, handler) => target.addEventListener(event, handler, { signal: lifetime.signal });
  const identity = value => placeIdentity(value, platform);
  const labelFor = path => roots.find(root => identity(root.path) === identity(path))?.label ?? pathSegments(path).at(-1)?.name ?? path;
  const resolved = index => resolvePlace(items[index], roots);
  const focus = index => (nav.querySelectorAll('.place')[index] ?? $('add-place')).focus();
  const validationControls = disabled => { for (const id of ['place-save', 'place-path', 'place-name']) $(id).disabled = disabled; };
  function save(next, message, index) {
    items = next;
    const persisted = writePlaces(storage, key, items);
    render(); if (index !== undefined) focus(index);
    notice(persisted ? message : t('placesNotSaved'), !persisted);
  }
  function update(path = currentPath, blocked = busy) {
    currentPath = path; busy = blocked;
    $('add-place').disabled = busy;
    $('add-current-place').disabled = busy || !path;
    for (const node of nav.querySelectorAll('button')) node.disabled = busy;
    for (const node of nav.querySelectorAll('.place')) {
      const active = Boolean(path) && identity(node.dataset.path) === identity(path);
      node.classList.toggle('active', active);
      if (active) node.setAttribute('aria-current', 'location'); else node.removeAttribute('aria-current');
    }
  }
  function render() {
    nav.replaceChildren(); $('places-empty').hidden = items.length > 0;
    items.forEach((_item, index) => {
      const place = resolved(index), row = document.createElement('div'); row.className = 'place-row'; row.dataset.index = index;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'place'; button.dataset.path = place.path;
      button.title = `${place.path}\n${t('placeDragHint')}`;
      button.append(icon(({ documents: 'file', pictures: 'image', tmp: 'folder' })[place.icon] ?? place.icon, 17));
      const label = document.createElement('span'); label.textContent = place.label; button.append(label);
      button.onclick = () => { if (performance.now() >= suppressClick && !busy) void navigate(place.path); };
      button.onpointerdown = event => pointerDown(event, index, row);
      button.onkeydown = event => {
        if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); reorder(index, index + (event.key === 'ArrowUp' ? -1 : 1));
        }
      };
      const options = document.createElement('button'); options.type = 'button'; options.className = 'place-options icon-button'; options.append(icon('more', 16));
      options.setAttribute('aria-label', t('managePlace', { name: place.label })); options.title = t('managePlace', { name: place.label });
      options.onclick = () => { const rect = options.getBoundingClientRect(); showMenu(index, rect.right, rect.bottom); };
      row.oncontextmenu = event => { event.preventDefault(); if (!drag?.active) showMenu(index, event.clientX, event.clientY); };
      row.append(button, options); nav.append(row);
    });
    update();
  }
  function reorder(from, to) {
    if (busy || from === to || to < 0 || to >= items.length) return;
    save(movePlace(items, from, to), t('placeMoved', { name: resolved(from).label, index: to + 1 }), to);
  }
  function showMenu(index, x, y) {
    if (busy) return;
    menu.replaceChildren(); menu.dataset.index = index; $('context-menu').hidden = true;
    document.querySelectorAll('details[open]').forEach(node => { node.open = false; });
    for (const [label, action, disabled] of [
      ['editPlace', () => edit(index)],
      ['movePlaceUp', () => reorder(index, index - 1), index === 0],
      ['movePlaceDown', () => reorder(index, index + 1), index === items.length - 1],
      ['removePlace', () => save(items.filter((_item, i) => i !== index), t('placeRemoved'), Math.min(index, items.length - 2))],
    ]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = t(label); button.disabled = Boolean(disabled); button.setAttribute('role', 'menuitem');
      button.onclick = () => { menu.hidden = true; action(); }; menu.append(button);
    }
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button')?.focus();
  }
  function edit(index = -1, path = currentPath) {
    if (busy || dialog.open || $('dialog').open) return;
    editing = index;
    if (index < 0 && items.length >= MAX_PLACES) { notice(t('placesLimit', { count: MAX_PLACES }), true); return; }
    $('place-dialog-title').textContent = t(index < 0 ? 'addPlace' : 'editPlace');
    $('place-path').value = index < 0 ? path : resolved(index).path;
    $('place-name').value = index < 0 ? '' : resolved(index).label;
    $('place-error').hidden = true; validationControls(false);
    $('place-name').placeholder = t('placeNameHint');
    dialog.showModal(); (index < 0 ? $('place-path') : $('place-name')).select();
  }
  async function add(path = currentPath, label = '', index = -1, signal) {
    if (index < 0 && items.length >= MAX_PLACES) throw Error(t('placesLimit', { count: MAX_PLACES }));
    // Verifies existence, directory type, readability and the configured access policy.
    const listing = await call('list_dir', { path: normalizePathInput(path), limit: 1 }, { signal });
    signal?.throwIfAborted();
    if (index < 0 && items.length >= MAX_PLACES) throw Error(t('placesLimit', { count: MAX_PLACES }));
    const canonical = listing.path;
    const duplicate = items.findIndex((item, i) => i !== index && identity(resolvePlace(item, roots).path) === identity(canonical));
    if (duplicate >= 0) throw Error(t('placeExists'));
    const name = label.trim() || labelFor(canonical).slice(0, 80);
    if (name.length > 80 || /[\x00-\x1f]/.test(name)) throw Error(t('placeNameInvalid'));
    const root = roots.find(root => identity(root.path) === identity(canonical));
    const item = root ? { root: root.id, ...(name === root.label ? {} : { label: name }) } : { path: canonical, label: name };
    const next = [...items]; if (index < 0) next.push(item); else next[index] = item;
    save(next, t(index < 0 ? 'placeAdded' : 'placeUpdated'), index < 0 ? next.length - 1 : index);
    return index < 0 ? next.length - 1 : index;
  }
  on($('place-form'), 'submit', async event => {
    event.preventDefault(); if (validating) return;
    const controller = new AbortController(); validating = controller; validationControls(true); $('place-error').hidden = true;
    try { const savedIndex = await add($('place-path').value, $('place-name').value, editing, controller.signal); dialog.close(); focus(savedIndex); }
    catch (error) { if (!controller.signal.aborted) { $('place-error').textContent = error.message; $('place-error').hidden = false; } }
    finally { if (validating === controller) { validating = undefined; validationControls(false); } }
  });
  on($('place-cancel'), 'click', () => { validating?.abort(); dialog.close(); });
  on(dialog, 'cancel', () => validating?.abort());
  on(dialog, 'close', () => { validating?.abort(); validating = undefined; validationControls(false); });
  on($('add-place'), 'click', () => edit());
  on($('add-current-place'), 'click', async () => {
    if (busy) return;
    $('add-current-place').disabled = true;
    try { await add(currentPath, '', -1, lifetime.signal); }
    catch (error) { if (!lifetime.signal.aborted) notice(error.message, true); }
    finally { if (!lifetime.signal.aborted) update(); }
  });
  on(document, 'pointerdown', event => { if (!event.target.closest('#place-menu')) menu.hidden = true; });
  on(menu, 'keydown', event => {
    if (event.key === 'Tab') { menu.hidden = true; return; }
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  });
  on(document, 'keydown', event => {
    if (event.key !== 'Escape' || !drag?.active && menu.hidden) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const index = drag?.index ?? Number(menu.dataset.index); finishDrag(false); menu.hidden = true; focus(index);
  });

  function pointerDown(event, index, row) {
    if (event.button !== 0 || busy || items.length < 2) return;
    finishDrag(false); suppressClick = 0;
    drag = { index, row, button: event.currentTarget, pointerId: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, gap: index, active: false };
    drag.timer = setTimeout(startDrag, 300);
  }
  function startDrag() {
    if (!drag || drag.active || busy) return;
    clearTimeout(drag.timer); drag.active = true; menu.hidden = true;
    drag.button.setPointerCapture(drag.pointerId);
    drag.row.classList.add('dragging'); document.body.classList.add('dragging-place');
    ghost = document.createElement('div'); ghost.className = 'place-ghost'; ghost.append(icon('folder', 17), document.createTextNode(resolved(drag.index).label));
    const rect = drag.row.getBoundingClientRect(); ghost.style.left = `${rect.left}px`; ghost.style.width = `${rect.width}px`; document.body.append(ghost);
    positionDrag(); frame = requestAnimationFrame(scrollDrag);
  }
  function positionDrag() {
    if (!drag?.active) return;
    ghost.style.top = `${drag.lastY - 16}px`;
    const rows = [...nav.children]; rows.forEach(row => row.classList.remove('drop-before', 'drop-after'));
    let gap = rows.findIndex(row => drag.lastY < row.getBoundingClientRect().top + row.offsetHeight / 2);
    if (gap < 0) gap = rows.length;
    drag.gap = gap;
    if (gap === rows.length) rows.at(-1)?.classList.add('drop-after'); else rows[gap].classList.add('drop-before');
  }
  function scrollDrag() {
    if (!drag?.active) return;
    const rect = nav.getBoundingClientRect();
    const delta = drag.lastY < rect.top + 25 ? -7 : drag.lastY > rect.bottom - 25 ? 7 : 0;
    if (delta) { nav.scrollTop += delta; positionDrag(); }
    frame = requestAnimationFrame(scrollDrag);
  }
  function finishDrag(commit) {
    if (!drag) return;
    const last = drag; drag = undefined; clearTimeout(last.timer); cancelAnimationFrame(frame);
    if (last.button.hasPointerCapture(last.pointerId)) last.button.releasePointerCapture(last.pointerId);
    ghost?.remove(); ghost = undefined; last.row.classList.remove('dragging'); document.body.classList.remove('dragging-place');
    for (const row of nav.children) row.classList.remove('drop-before', 'drop-after');
    if (last.active) { suppressClick = performance.now() + 400; if (commit) reorder(last.index, dropPosition(last.index, last.gap, items.length)); }
  }
  on(document, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.lastY = event.clientY;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 7) {
      if (event.pointerType === 'mouse') startDrag(); else { finishDrag(false); return; }
    }
    if (drag?.active) { event.preventDefault(); positionDrag(); }
  });
  on(document, 'pointerup', event => {
    if (drag?.pointerId !== event.pointerId) return;
    const rect = nav.getBoundingClientRect();
    finishDrag(event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top - 20 && event.clientY <= rect.bottom + 20);
  });
  on(document, 'pointercancel', () => finishDrag(false));
  on(window, 'blur', () => finishDrag(false));
  render();
  return { update, edit: path => edit(-1, path), dispose() { finishDrag(false); validating?.abort(); lifetime.abort(); menu.hidden = true; } };
}

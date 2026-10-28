// Windowed <tbody>: only rows near the viewport exist in the DOM, spacer rows keep the scrollbar honest.
// Needs a scroll container around the table and rows of one fixed height (cells must not wrap).
import { h } from './dom.js';

// Makes tbody show exactly `wanted`. When the id order is unchanged only the replaced rows are swapped, so a keyboard
// user's focus survives polling updates; otherwise the whole list is replaced.
export function reconcile(tbody, wanted) {
  const cur = tbody.children;
  // rows must carry a unique data-id; without it we cannot tell what changed, so replace everything
  const sameOrder = cur.length === wanted.length && wanted.every((el, i) => el.dataset.id !== undefined && cur[i].dataset.id === el.dataset.id);
  if (!sameOrder) { tbody.replaceChildren(...wanted); return; }
  for (let i = 0; i < wanted.length; i += 1) {
    if (cur[i] === wanted[i]) continue;
    const old = cur[i];
    const active = document.activeElement;
    const act = active && old.contains(active) ? active.dataset?.act : '';
    old.replaceWith(wanted[i]);
    if (act) wanted[i].querySelector(`[data-act="${act}"]:not([disabled])`)?.focus({ preventScroll: true });
  }
}

export function createVirtualBody({ scroller, table, tbody, rowHeight, columns, overscan = 10, renderRow }) {
  const spacer = (id) => h('tr', { class: 'v-spacer', dataset: { id }, 'aria-hidden': 'true' }, h('td', { colSpan: columns }));
  const top = spacer('v-top'), bottom = spacer('v-bottom');
  let items = [], range = [-1, -1], raf = 0;

  function paint(force) {
    const headH = table.tHead?.offsetHeight ?? 0;
    const y = Math.max(0, scroller.scrollTop - headH);
    const first = Math.max(0, Math.floor(y / rowHeight) - overscan);
    const last = Math.min(items.length, Math.ceil((y + scroller.clientHeight) / rowHeight) + overscan);
    if (!force && first === range[0] && last === range[1]) return;
    range = [first, last];
    top.firstChild.style.height = `${first * rowHeight}px`;
    bottom.firstChild.style.height = `${Math.max(0, items.length - last) * rowHeight}px`;
    const rows = [];
    for (let i = first; i < last; i += 1) {
      const row = renderRow(items[i]);
      row.setAttribute('aria-rowindex', String(i + 2)); // header is row 1
      rows.push(row);
    }
    reconcile(tbody, [top, ...rows, bottom]);
  }
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(false); }); };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const observer = new ResizeObserver(onScroll);
  observer.observe(scroller);

  return {
    // keepScroll=false jumps back to the top (a user-driven filter / sort change)
    setItems(next, { keepScroll = true } = {}) {
      items = next;
      table.setAttribute('aria-rowcount', String(items.length + 1));
      const total = (table.tHead?.offsetHeight ?? 0) + items.length * rowHeight;
      scroller.scrollTop = keepScroll ? Math.min(scroller.scrollTop, Math.max(0, total - scroller.clientHeight)) : 0;
      paint(true);
    },
    refresh() { paint(true); },
    get count() { return items.length; },
    destroy() { cancelAnimationFrame(raf); scroller.removeEventListener('scroll', onScroll); observer.disconnect(); }
  };
}

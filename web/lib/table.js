// Sortable table header (aria-sort, keyboard friendly) and a null-safe row sorter.
import { h, cx } from './dom.js';
import { icon } from './icons.js';

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

// cols: [{ key, label, num?, sortable?, title? }]; `state` is { key, dir } and is mutated in place.
export function sortHead(cols, state, onChange) {
  const heads = new Map();
  function paint() {
    for (const col of cols) {
      if (!col.sortable) continue;
      const th = heads.get(col.key);
      const on = state.key === col.key;
      th.setAttribute('aria-sort', on ? (state.dir === 1 ? 'ascending' : 'descending') : 'none');
      th.querySelector('.sort-ico').replaceChildren(on ? icon(state.dir === 1 ? 'arrow-up' : 'arrow-down', 12) : '');
    }
  }
  function toggle(col) {
    state.dir = state.key === col.key ? -state.dir : (col.num ? -1 : 1); // numbers: biggest first
    state.key = col.key;
    paint();
    onChange();
  }
  const row = h('tr', null, cols.map((col) => {
    const th = h('th', { scope: 'col', class: cx(`c-${col.key}`, col.num && 'num'), title: col.title },
      col.sortable ? h('button', { class: 'th-btn', type: 'button', onclick: () => toggle(col) }, col.label, h('span', { class: 'sort-ico' })) : col.label);
    heads.set(col.key, th);
    return th;
  }));
  paint();
  return { el: h('thead', null, row), paint };
}

// Empty values always go last, whatever the direction.
export function sortRows(rows, state, getters) {
  const get = getters[state.key];
  if (!get) return rows;
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    const nx = x === null || x === undefined || Number.isNaN(x), ny = y === null || y === undefined || Number.isNaN(y);
    if (nx || ny) return nx && ny ? 0 : nx ? 1 : -1;
    return (typeof x === 'string' ? collator.compare(x, y) : x - y) * state.dir;
  });
}

const paths = {
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
  file: 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6',
  image: 'M3 4h18v16H3ZM3 17l6-6 4 4 3-3 5 5M16 8h.01',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  back: 'm14 5-7 7 7 7', forward: 'm10 5 7 7-7 7', up: 'm5 14 7-7 7 7',
  refresh: 'M20 7V3l-4 4M20 7a9 9 0 1 0 1 9M20 7h-5', close: 'm6 6 12 12M6 18 18 6', go: 'M4 12h16m-6-6 6 6-6 6',
  grid: 'M3 3h6v6H3ZM15 3h6v6h-6ZM3 15h6v6H3ZM15 15h6v6h-6Z',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
  sort: 'M4 6h12M4 12h9M4 18h5M19 10v11m-3-3 3 3 3-3',
  sidebar: 'M3 4h18v16H3ZM9 4v16', preview: 'M3 4h18v16H3ZM15 4v16', more: 'M5 12h.01M12 12h.01M19 12h.01',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6', newFolder: 'M3 7V5h7l2 2h9v13H3ZM12 10v7m-3-3h6',
  home: 'm3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7', desktop: 'M3 3h18v14H3ZM8 21h8m-4-4v4',
  downloads: 'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4', music: 'M9 17V5l12-2v12M9 8l12-2M9 17c0 4-6 4-6 1s6-4 6-1m12-2c0 4-6 4-6 1s6-4 6-1',
  movies: 'M3 4h18v16H3ZM8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5',
  projects: 'M8 6V3h8v3M3 6h18v15H3ZM3 11h18M10 11v3h4v-3',
  trash: 'M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3M9 10v7M15 10v7',
};
const NS = 'http://www.w3.org/2000/svg';
function shape(svg, tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  svg.append(node); return node;
}
export function icon(name, size = 20) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  shape(svg, 'path', { d: paths[name] ?? paths.file }); return svg;
}
export function fileIcon(entry) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 80 80'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('file-icon');
  if (entry.isDir) {
    shape(svg, 'path', { d: 'M5 20Q5 16 10 16H30L36 22H69Q75 22 75 28V61Q75 66 70 66H10Q5 66 5 61Z', fill: '#4fa8df', stroke: '#3597cf', 'stroke-width': .7 });
    shape(svg, 'path', { d: 'M7 30Q7 27 11 27H69Q73 27 73 31V61Q73 64 69 64H11Q7 64 7 60Z', fill: '#80c9f1' });
    shape(svg, 'path', { d: 'M9 29H70', stroke: '#c2e9fc', 'stroke-width': 1.3 });
  } else {
    shape(svg, 'path', { d: 'M19 8H48L63 23V68Q63 72 59 72H21Q17 72 17 68V12Q17 8 19 8Z', fill: '#fff', stroke: '#cbd0d6', 'stroke-width': 1 });
    shape(svg, 'path', { d: 'M48 8V23H63', fill: '#e9edf2', stroke: '#cbd0d6', 'stroke-width': 1 });
    const colors = { image: '#21877f', pdf: '#ce4949', video: '#8661bf', audio: '#bf5788', archive: '#9b783d', text: '#5b84b7' };
    const color = colors[entry.kind] ?? '#84909c';
    if (entry.kind === 'image') {
      shape(svg, 'rect', { x: 25, y: 30, width: 30, height: 23, rx: 2, fill: '#d5eee8' });
      shape(svg, 'path', { d: 'M25 50l9-10 7 7 6-5 8 10H25Z', fill: color }); shape(svg, 'circle', { cx: 46, cy: 36, r: 3, fill: color });
    } else {
      shape(svg, 'path', { d: 'M26 32H45M26 38H53M26 44H53M26 50H42', stroke: '#d4dae2', 'stroke-width': 2 });
    }
    const ext = entry.name.includes('.') ? entry.name.split('.').at(-1).slice(0, 5).toUpperCase() : 'FILE';
    const label = shape(svg, 'text', { x: 40, y: 63, fill: color, 'font-size': 9, 'font-family': 'system-ui, sans-serif', 'font-weight': 700, 'text-anchor': 'middle' }); label.textContent = ext;
  }
  return svg;
}

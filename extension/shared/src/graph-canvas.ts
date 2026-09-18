type Point = { x: number; y: number };
type Side = 'left' | 'right';
type GraphNode = { element: HTMLElement; halfWidth: number; halfHeight: number };
type Edge = { from: string; to: string; fromSide: Side; toSide: Side; paths: SVGPathElement[] };

const positions = new Map<string, Point>(), defaults = new Map<string, Point>();
const nodes = new Map<string, GraphNode>(), pointers = new Map<number, Point>(), dirtyNodes = new Set<string>();
let canvas: HTMLElement | null = null, world: HTMLElement | null = null, grid: HTMLElement | null = null, listeners: AbortController | undefined;
let edges: Edge[] = [], rect: DOMRect, frame = 0, activeNode: string | undefined, scene: string | undefined;
let zoom = 1, pan = { x: 0, y: 0 }, automaticFit = true, cameraDirty = false, gridZoom: number | undefined;
const clampZoom = (value: number) => Math.max(Math.min(.05, zoom), Math.min(2, value));

/** Positions belong to the canvas, so live dashboard updates cannot undo a drag. */
export function graphPosition(key: string, initial: Point): Point {
  defaults.set(key, { ...initial });
  if (!positions.has(key)) positions.set(key, { ...initial });
  return positions.get(key)!;
}

export function graphCurve(from: Point, to: Point, fromHalfWidth: number, toHalfWidth: number, fromSide: Side, toSide: Side): string {
  const a = fromSide === 'left' ? -1 : 1, b = toSide === 'left' ? -1 : 1;
  const x1 = from.x + a * fromHalfWidth, x2 = to.x + b * toHalfWidth;
  const bend = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M${x1} ${from.y} C${x1 + a * bend} ${from.y} ${x2 + b * bend} ${to.y} ${x2} ${to.y}`;
}

function draw() {
  frame = 0;
  if (!canvas || !world) return;
  for (const key of dirtyNodes) {
    const node = nodes.get(key), point = positions.get(key);
    if (!node || !point) continue;
    node.element.style.transform = `translate3d(${point.x}px,${point.y}px,0) translate(-50%,-50%)`;
    node.element.dataset.x = String(point.x);
    node.element.dataset.y = String(point.y);
  }
  for (const edge of edges) {
    if (!dirtyNodes.has(edge.from) && !dirtyNodes.has(edge.to)) continue;
    const from = positions.get(edge.from), to = positions.get(edge.to), a = nodes.get(edge.from), b = nodes.get(edge.to);
    if (!from || !to || !a || !b) continue;
    const path = graphCurve(from, to, a.halfWidth, b.halfWidth, edge.fromSide, edge.toSide);
    for (const element of edge.paths) element.setAttribute('d', path);
  }
  dirtyNodes.clear();
  if (cameraDirty) {
    world.style.transform = `translate3d(${pan.x}px,${pan.y}px,0) scale(${zoom})`;
    canvas.dataset.zoom = String(zoom);
    canvas.dataset.panX = String(pan.x);
    canvas.dataset.panY = String(pan.y);
    if (grid) {
      const spacing = 22 * zoom;
      grid.style.transform = `translate3d(${(pan.x + 44) % spacing}px,${(pan.y + 44) % spacing}px,0)`;
      if (gridZoom !== zoom) { grid.style.backgroundSize = `${spacing}px ${spacing}px`; gridZoom = zoom; }
    }
    const label = document.getElementById('graph-zoom-label');
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
    const out = document.getElementById('graph-zoom-out') as HTMLButtonElement | null;
    const into = document.getElementById('graph-zoom-in') as HTMLButtonElement | null;
    if (out) out.disabled = zoom <= .05;
    if (into) into.disabled = zoom >= 2;
    cameraDirty = false;
  }
}

function schedule(camera = false) {
  cameraDirty ||= camera;
  if (!frame) frame = requestAnimationFrame(draw);
}

function fit() {
  if (!canvas || !nodes.size) return;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [key, node] of nodes) {
    const point = positions.get(key)!;
    left = Math.min(left, point.x - node.halfWidth); right = Math.max(right, point.x + node.halfWidth);
    top = Math.min(top, point.y - node.halfHeight); bottom = Math.max(bottom, point.y + node.halfHeight);
  }
  zoom = Math.min(1, Math.max(.001, Math.min((rect.width - 64) / (right - left), (rect.height - 64) / (bottom - top))));
  pan = { x: rect.width / 2 - (left + right) / 2 * zoom, y: rect.height / 2 - (top + bottom) / 2 * zoom };
  schedule(true);
}

function zoomAt(factor: number, point: Point) {
  const next = clampZoom(zoom * factor), ratio = next / zoom;
  pan = { x: point.x - (point.x - pan.x) * ratio, y: point.y - (point.y - pan.y) * ratio };
  zoom = next;
  automaticFit = false;
  schedule(true);
}

export function zoomGraph(factor?: number) {
  if (!canvas) return;
  rect = canvas.getBoundingClientRect();
  if (factor === undefined) { automaticFit = true; fit(); }
  else zoomAt(factor, { x: rect.width / 2, y: rect.height / 2 });
}

export function resetGraphLayout() {
  for (const key of nodes.keys()) {
    const initial = defaults.get(key);
    if (initial) positions.set(key, { ...initial });
    dirtyNodes.add(key);
  }
  zoomGraph();
}

function nodeAt(target: EventTarget | null): string | undefined {
  return target instanceof Element ? target.closest<HTMLElement>('[data-graph-node]')?.dataset.graphNode : undefined;
}

function pointerDown(event: PointerEvent) {
  if (!canvas || (event.pointerType !== 'touch' && event.button !== 0)) return;
  rect = canvas.getBoundingClientRect();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  activeNode = pointers.size === 1 ? nodeAt(event.target) : undefined;
  canvas.dataset.dragging = activeNode ? 'node' : 'canvas';
  (activeNode ? nodes.get(activeNode)?.element : canvas)?.focus({ preventScroll: true });
  try { canvas.setPointerCapture(event.pointerId); } catch {}
  event.preventDefault();
}

function pointerMove(event: PointerEvent) {
  const previous = pointers.get(event.pointerId);
  if (!previous) return;
  const before = [...pointers.values()];
  const point = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, point);
  automaticFit = false;
  if (pointers.size >= 2) {
    const after = [...pointers.values()];
    const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top });
    const oldCenter = midpoint(before[0], before[1]), center = midpoint(after[0], after[1]);
    const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    const oldDistance = distance(before[0], before[1]);
    const next = clampZoom(zoom * (oldDistance ? distance(after[0], after[1]) / oldDistance : 1));
    pan = { x: center.x - (oldCenter.x - pan.x) * next / zoom, y: center.y - (oldCenter.y - pan.y) * next / zoom };
    zoom = next;
    schedule(true);
  } else if (activeNode) {
    const position = positions.get(activeNode);
    if (position) {
      position.x += (point.x - previous.x) / zoom;
      position.y += (point.y - previous.y) / zoom;
      dirtyNodes.add(activeNode);
      schedule();
    }
  } else {
    pan.x += point.x - previous.x; pan.y += point.y - previous.y;
    schedule(true);
  }
  event.preventDefault();
}

function pointerEnd(event: PointerEvent) {
  pointers.delete(event.pointerId);
  if (!pointers.size) {
    activeNode = undefined;
    if (canvas) delete canvas.dataset.dragging;
  }
}

function wheel(event: WheelEvent) {
  if (!canvas) return;
  rect = canvas.getBoundingClientRect();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
  if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * unit * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  else {
    automaticFit = false;
    pan.x -= (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
    pan.y -= (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
    schedule(true);
  }
  event.preventDefault();
}

function keyDown(event: KeyboardEvent) {
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (direction) {
    const key = nodeAt(event.target), position = key ? positions.get(key) : undefined;
    automaticFit = false;
    if (key && position) {
      position.x += direction[0] * (event.shiftKey ? 50 : 10);
      position.y += direction[1] * (event.shiftKey ? 50 : 10);
      dirtyNodes.add(key);
      schedule();
    } else {
      pan.x -= direction[0] * (event.shiftKey ? 120 : 40);
      pan.y -= direction[1] * (event.shiftKey ? 120 : 40);
      schedule(true);
    }
  } else if (event.key === '+' || event.key === '=') zoomGraph(1.2);
  else if (event.key === '-') zoomGraph(1 / 1.2);
  else if (event.key === '0' || event.key === 'Home') zoomGraph();
  else return;
  event.preventDefault();
}

const resize = new ResizeObserver(() => {
  if (!canvas) return;
  const previous = rect;
  rect = canvas.getBoundingClientRect();
  if (automaticFit) fit();
  else {
    pan.x += (rect.width - previous.width) / 2;
    pan.y += (rect.height - previous.height) / 2;
    schedule(true);
  }
});

/** Rebind only when the viewport changes; DOM morphs keep pointer capture and animation identity. */
export function syncGraphCanvas(next: HTMLElement | null) {
  if (canvas !== next) {
    listeners?.abort(); resize.disconnect(); pointers.clear(); activeNode = undefined;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    dirtyNodes.clear();
    canvas = next;
    if (canvas) {
      rect = canvas.getBoundingClientRect();
      listeners = new AbortController();
      const options = { signal: listeners.signal };
      canvas.addEventListener('pointerdown', pointerDown, options);
      canvas.addEventListener('pointermove', pointerMove, options);
      canvas.addEventListener('pointerup', pointerEnd, options);
      canvas.addEventListener('pointercancel', pointerEnd, options);
      canvas.addEventListener('lostpointercapture', pointerEnd, options);
      canvas.addEventListener('wheel', wheel, { ...options, passive: false });
      canvas.addEventListener('keydown', keyDown, options);
      resize.observe(canvas);
    }
  }
  nodes.clear(); edges = [];
  world = canvas?.querySelector('#graph-world') ?? null;
  const nextGrid = canvas?.querySelector<HTMLElement>('.graph-grid') ?? null;
  if (grid !== nextGrid) gridZoom = undefined;
  grid = nextGrid;
  if (!canvas || !world) {
    if (frame) cancelAnimationFrame(frame);
    frame = 0; cameraDirty = false; dirtyNodes.clear();
    return;
  }
  const nextScene = `${canvas.dataset.graphScope}:${canvas.dataset.layout}`;
  if (scene !== nextScene) { scene = nextScene; automaticFit = true; }
  rect = canvas.getBoundingClientRect();
  for (const element of canvas.querySelectorAll<HTMLElement>('[data-graph-node]')) {
    const key = element.dataset.graphNode!;
    if (!positions.has(key)) graphPosition(key, { x: Number(element.dataset.x), y: Number(element.dataset.y) });
    nodes.set(key, { element, halfWidth: Number(element.dataset.halfWidth) || element.offsetWidth / 2, halfHeight: element.offsetHeight / 2 });
    dirtyNodes.add(key);
  }
  for (const element of canvas.querySelectorAll<SVGGElement>('.graph-edge')) {
    edges.push({ from: element.dataset.from!, to: element.dataset.to!, fromSide: element.dataset.fromSide === 'left' ? 'left' : 'right', toSide: element.dataset.toSide === 'right' ? 'right' : 'left', paths: [...element.querySelectorAll<SVGPathElement>('path')] });
  }
  if (automaticFit) fit();
  cameraDirty = true;
  // A morph can add a new world; restore its camera before the browser paints it.
  if (frame) cancelAnimationFrame(frame);
  draw();
}

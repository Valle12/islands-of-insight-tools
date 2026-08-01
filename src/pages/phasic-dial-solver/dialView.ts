/**
 * One dial, drawn the way the game draws it: a polygon with as many corners as
 * the dial has positions, and a pointer that has to end up aimed at the hub.
 *
 * The config format is unchanged — it stores `max`, which is the number of
 * positions minus one. Everything the player sees is derived from it:
 * `sides = max + 1`, and position 0 is the solved one.
 */

/** Circumradius of the polygon, in the SVG's own units. */
export const DIAL_RADIUS = 30;

/** Half the side of the square viewBox the dial is drawn in. */
const VIEW = 50;

/** Below three positions there is no polygon to draw — fall back to a ring. */
const MIN_POLYGON_SIDES = 3;

/** How far out the pointer's tip and the base of its head sit. */
const ARROW_TIP = 43;
const ARROW_BASE = 28;
const ARROW_HALF_WIDTH = 7;

export interface DialViewOptions {
  /** Dial colour id, e.g. `"blue"` — also the `data-color` attribute. */
  color: string;
  /** Human-readable colour, used in every accessible name. */
  label: string;
  /** Data URL of the colour's hub artwork. */
  image: string;
  /** Positions minus one, i.e. exactly what the config calls `max`. */
  max: number;
  /** Current position, `0..max`. */
  value: number;
  onValueChange: (value: number) => void;
  /** Fired with the new max and the value after clamping it into range. */
  onMaxChange: (max: number, value: number) => void;
}

/** Angle of position `index` in degrees, with position 0 straight up. */
export function vertexAngle(index: number, sides: number): number {
  return -90 + (index * 360) / sides;
}

/** Cartesian point of position `index` on a circle of the given radius. */
export function vertexPoint(
  index: number,
  sides: number,
  radius = DIAL_RADIUS,
): { x: number; y: number } {
  const rad = (vertexAngle(index, sides) * Math.PI) / 180;
  return { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
}

/**
 * The position a cursor offset from the dial's centre points at. Snapping to
 * the nearest corner is what makes dragging feel like turning a dial rather
 * than dropping a needle wherever the finger happened to be.
 */
export function nearestVertex(dx: number, dy: number, sides: number): number {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const step = 360 / sides;
  const index = Math.round((deg + 90) / step);
  return ((index % sides) + sides) % sides;
}

function polygonPoints(sides: number): string {
  return Array.from({ length: sides }, (_, i) => {
    const p = vertexPoint(i, sides);
    return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }).join(" ");
}

/** The three corners of the pointer's head, aimed along `angle`. */
function arrowHeadPoints(angle: number): string {
  const rad = (angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  // Perpendicular to the pointer, so the head's base straddles the shaft.
  const px = -uy;
  const py = ux;
  const corners: [number, number][] = [
    [ux * ARROW_TIP, uy * ARROW_TIP],
    [
      ux * ARROW_BASE + px * ARROW_HALF_WIDTH,
      uy * ARROW_BASE + py * ARROW_HALF_WIDTH,
    ],
    [
      ux * ARROW_BASE - px * ARROW_HALF_WIDTH,
      uy * ARROW_BASE - py * ARROW_HALF_WIDTH,
    ],
  ];
  return corners.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

export class DialView {
  readonly root: HTMLDivElement;

  private readonly options: DialViewOptions;
  private readonly face: SVGSVGElement;
  private readonly sidesLabel: HTMLSpanElement;
  private readonly stateLabel: HTMLSpanElement;
  private readonly fewerBtn: HTMLElement;
  private readonly controller = new AbortController();
  private dragging = false;

  constructor(options: DialViewOptions) {
    this.options = { ...options };

    this.root = document.createElement("div");
    this.root.className = "dial-card";
    this.root.dataset.color = options.color;
    this.root.innerHTML = DialView.markup(options.label);

    this.face = this.root.querySelector("svg")!;
    this.sidesLabel = this.root.querySelector(".dial-sides-count")!;
    this.stateLabel = this.root.querySelector(".dial-state")!;
    this.fewerBtn = this.root.querySelector(".dial-sides-fewer")!;

    this.wireControls();
    this.render();
  }

  /** Detaches every listener — call before dropping the card. */
  dispose() {
    this.controller.abort();
  }

  get sides(): number {
    return this.options.max + 1;
  }

  private static markup(label: string): string {
    return `
      <span class="dial-name">${label}</span>
      <svg
        class="dial-face"
        viewBox="${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}"
        role="slider"
        tabindex="0"
        aria-label="${label} dial position"
      ></svg>
      <div class="dial-sides">
        <md-icon-button
          class="dial-sides-fewer"
          title="Fewer positions on the ${label.toLowerCase()} dial"
          aria-label="Fewer positions on the ${label.toLowerCase()} dial"
        >
          <md-icon>remove</md-icon>
        </md-icon-button>
        <span class="dial-sides-count"></span>
        <md-icon-button
          class="dial-sides-more"
          title="More positions on the ${label.toLowerCase()} dial"
          aria-label="More positions on the ${label.toLowerCase()} dial"
        >
          <md-icon>add</md-icon>
        </md-icon-button>
      </div>
      <span class="dial-state"></span>`;
  }

  private wireControls() {
    const { signal } = this.controller;

    this.fewerBtn.addEventListener(
      "click",
      () => this.changeMax(this.options.max - 1),
      { signal },
    );
    this.root
      .querySelector(".dial-sides-more")!
      .addEventListener("click", () => this.changeMax(this.options.max + 1), {
        signal,
      });

    this.face.addEventListener("pointerdown", e => this.onPointerDown(e), {
      signal,
    });
    this.face.addEventListener("pointermove", e => this.onPointerMove(e), {
      signal,
    });
    this.face.addEventListener("pointerup", () => this.endDrag(), { signal });
    this.face.addEventListener("pointercancel", () => this.endDrag(), {
      signal,
    });
    this.face.addEventListener("keydown", e => this.onKeyDown(e), { signal });
  }

  private onPointerDown(event: PointerEvent) {
    event.preventDefault();
    this.dragging = true;
    this.face.setPointerCapture?.(event.pointerId);
    this.face.focus();
    this.pointTo(event);
  }

  private onPointerMove(event: PointerEvent) {
    if (this.dragging) this.pointTo(event);
  }

  private endDrag() {
    this.dragging = false;
  }

  /** Turns a cursor position into the position it is closest to. */
  private pointTo(event: PointerEvent) {
    const rect = this.face.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    // A cursor right on the hub has no meaningful angle; ignore it rather than
    // snapping the pointer to whatever atan2(0, 0) happens to return.
    if (Math.hypot(dx, dy) < rect.width * 0.12) return;
    this.changeValue(nearestVertex(dx, dy, this.sides));
  }

  private onKeyDown(event: KeyboardEvent) {
    const delta = DialView.keyDelta(event.key);
    if (delta === null) return;
    event.preventDefault();
    if (event.key === "Home") {
      this.changeValue(0);
    } else if (event.key === "End") {
      this.changeValue(this.options.max);
    } else {
      const next = (this.options.value + delta + this.sides) % this.sides;
      this.changeValue(next);
    }
  }

  private static keyDelta(key: string): number | null {
    switch (key) {
      case "ArrowRight":
      case "ArrowUp":
        return 1;
      case "ArrowLeft":
      case "ArrowDown":
        return -1;
      case "Home":
      case "End":
        return 0;
      default:
        return null;
    }
  }

  private changeValue(value: number) {
    if (value === this.options.value) return;
    this.options.value = value;
    this.render();
    this.options.onValueChange(value);
  }

  private changeMax(max: number) {
    // Max is "positions minus one", so 0 would be an inert one-position dial —
    // the same floor the config validator enforces.
    if (max < 1 || max === this.options.max) return;
    this.options.max = max;
    if (this.options.value > max) this.options.value = max;
    this.render();
    this.options.onMaxChange(max, this.options.value);
  }

  /** Redraws the face and the two labels from the current state. */
  private render() {
    const { max, value, label, image } = this.options;
    const sides = this.sides;
    const solved = value === 0;

    this.root.dataset.solved = String(solved);
    this.face.setAttribute("aria-valuemin", "0");
    this.face.setAttribute("aria-valuemax", String(max));
    this.face.setAttribute("aria-valuenow", String(value));
    this.face.setAttribute(
      "aria-valuetext",
      solved
        ? `Position 0 of ${sides}, aimed at the hub`
        : `Position ${value} of ${sides}`,
    );
    this.face.innerHTML = DialView.faceMarkup(sides, value, label, image);

    this.sidesLabel.textContent = `${sides} positions`;
    this.stateLabel.textContent = solved
      ? "Aimed at the hub"
      : `Position ${value}`;
    this.fewerBtn.toggleAttribute("disabled", max <= 1);
  }

  private static faceMarkup(
    sides: number,
    value: number,
    label: string,
    image: string,
  ): string {
    const angle = vertexAngle(value, sides);
    const tip = vertexPoint(value, sides, ARROW_BASE);
    // Fewer than three positions cannot be a polygon; a ring carries the dots
    // just as well and keeps every other part of the drawing identical.
    const frame =
      sides < MIN_POLYGON_SIDES
        ? `<circle class="dial-frame" cx="0" cy="0" r="${DIAL_RADIUS}" />`
        : `<polygon class="dial-frame" points="${polygonPoints(sides)}" />`;

    const dots = Array.from({ length: sides }, (_, i) => {
      const p = vertexPoint(i, sides);
      const kind = i === 0 ? "home" : "step";
      return (
        `<circle class="dial-dot" data-position="${i}" data-kind="${kind}" ` +
        `cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${i === 0 ? 4.5 : 3}" />`
      );
    }).join("");

    return `
      ${frame}
      ${dots}
      <line class="dial-pointer" x1="0" y1="0"
        x2="${tip.x.toFixed(2)}" y2="${tip.y.toFixed(2)}" />
      <polygon class="dial-pointer-head" points="${arrowHeadPoints(angle)}" />
      <circle class="dial-hub" cx="0" cy="0" r="13" />
      <image class="dial-hub-image" href="${image}"
        x="-11" y="-11" width="22" height="22">
        <title>${label}</title>
      </image>`;
  }
}

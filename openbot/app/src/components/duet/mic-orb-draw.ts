/**
 * The mic orb, OpenDuet's presence, drawn on a 2D canvas exactly as the launch film draws it: a
 * glass sphere of drifting colour, two eye-lights that look, blink and smile, and a lined grille on
 * each side like a microphone's. Only the Ocean colours are here; they are OpenDuet's.
 *
 * Every frame is a pure function of an `OrbPose`, so the component that animates it owns time and
 * this file owns only the picture.
 */

const TAU = Math.PI * 2;
const PI = Math.PI;

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const eio = (u: number) => {
  const v = clamp(u);
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
};
const eout = (u: number) => 1 - (1 - clamp(u)) ** 3;
const smooth = (u: number) => {
  const v = clamp(u);
  return v * v * (3 - 2 * v);
};
const bump = (u: number) => (u <= 0 || u >= 1 ? 0 : Math.sin(PI * u) ** 2);

// ---------- motion: keyed tracks with eases and closed-form springs ----------

/** One move of a track: to `to` from time `at`, over an ease of `ease` seconds or on a spring of [stiffness, damping]. */
export type TrackKey =
  | { at: number; to: number; ease: number }
  | { at: number; to: number; spring: readonly [number, number] };

/** A value that starts at `from` and moves through its keys in order. */
export type Track = { from: number; keys: TrackKey[] };

/** Step response of a damped spring: closed form, so it is a pure function of elapsed time. */
function springStep(tau: number, w: number, z: number) {
  if (tau <= 0) return 0;
  if (z >= 1) return 1 - Math.exp(-w * tau) * (1 + w * tau);
  const wd = w * Math.sqrt(1 - z * z);
  return (
    1 -
    Math.exp(-z * w * tau) *
      (Math.cos(wd * tau) + ((z * w) / wd) * Math.sin(wd * tau))
  );
}

/**
 * The track's value at time t. Each key moves the value from the previous key's value to its own,
 * and the responses are summed, which for springs is exactly a spring chasing a stepped target:
 * anticipation, overshoot and settle all fall out of the same maths.
 */
export function track(tr: Track, t: number) {
  let v = tr.from;
  let prev = tr.from;
  for (const k of tr.keys) {
    if (t < k.at) break;
    const tau = t - k.at;
    const r =
      "ease" in k
        ? eio(tau / k.ease)
        : springStep(tau, k.spring[0], k.spring[1]);
    v += (k.to - prev) * r;
    prev = k.to;
  }
  return v;
}

/** A blink at `tau` seconds after it starts: shut fast, open slower, 0.24 s in all. */
export function blinkCurve(tau: number) {
  if (tau < 0 || tau > 0.24) return 0;
  return tau < 0.07 ? eout(tau / 0.07) : 1 - eio((tau - 0.07) / 0.17);
}

/** A nod that rings down, `tau` seconds after it starts. */
export function nodCurve(tau: number) {
  return tau >= 0 && tau < 2.2 ? Math.exp(-3 * tau) * Math.sin(8 * tau) : 0;
}

export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where it looks while nothing needs it: mostly at you, now and then a glance aside and back.
 * Each look snaps over 0.14 s and then holds, so the pauses are part of the motion.
 */
export function restLook(ta: number, period: number, seed: number) {
  const k = Math.floor(ta / period);
  const f = ta - k * period;
  const at = (n: number): [number, number, number] => {
    const r = mulberry32((seed * 7919 + n * 104729) | 0);
    return r() < 0.55
      ? [0, 0, 0]
      : [(r() * 2 - 1) * 0.7, (r() * 2 - 1) * 0.4, (r() * 2 - 1) * 0.24];
  };
  const a = at(k - 1);
  const b = at(k);
  const u = eout(f / 0.14);
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

// ---------- colour ----------

type Rgb = [number, number, number];

function ok2rgb(L: number, C: number, h: number): Rgb | null {
  const hr = (h * PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const out: number[] = [];
  for (const x of linear) {
    if (x < -0.002 || x > 1.002) return null;
    const c = clamp(x);
    out.push(
      Math.round(
        255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055),
      ),
    );
  }
  return out as Rgb;
}

/** An oklch colour as sRGB, losing chroma until it fits rather than clipping its hue. */
export function oklch(L: number, C: number, h: number): Rgb {
  let chroma = C;
  for (let i = 0; i < 40; i++) {
    const c = ok2rgb(L, chroma, h);
    if (c) return c;
    chroma *= 0.95;
  }
  return ok2rgb(L, 0, h) ?? [128, 128, 128];
}

const rgba = (c: Rgb, a: number) =>
  `rgba(${c[0]},${c[1]},${c[2]},${a <= 0 ? 0 : a >= 1 ? 1 : a.toFixed(3)})`;
const mix = (a: Rgb, b: Rgb, u: number): Rgb => [
  Math.round(lerp(a[0], b[0], u)),
  Math.round(lerp(a[1], b[1], u)),
  Math.round(lerp(a[2], b[2], u)),
];
const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [20, 16, 33];

/**
 * Ocean, as oklch [L, C, h]: four tones for the sphere's drifting colour and its pale base. `violet`
 * is also the deep tone the grilles are made of, and `mag` the light their slots glow with.
 */
const OCEAN = {
  pink: [0.75, 0.13, 232],
  blue: [0.74, 0.13, 205],
  violet: [0.53, 0.2, 262],
  mag: [0.86, 0.08, 220],
  bg: [0.93, 0.025, 235],
} as const;
/** The tint of the sphere's shaded rim, as an rgb triple. */
const SHADE = "14,30,80";

type Palette = Record<keyof typeof OCEAN, Rgb>;
const paletteMemo = new Map<string, Palette>();

/** Ocean with its saturation and hue nudged, as the orb livens when it listens and cools when it works. */
export function palette(sat: number, hue: number): Palette {
  const ks = Math.round(clamp(sat, 0.5, 1.3) * 50) / 50;
  const kh = Math.round(hue * 2) / 2;
  const key = `${ks}|${kh}`;
  let p = paletteMemo.get(key);
  if (!p) {
    const c = (k: keyof typeof OCEAN, sk = ks, hk = kh) =>
      oklch(OCEAN[k][0], OCEAN[k][1] * sk, OCEAN[k][2] + hk);
    p = {
      pink: c("pink"),
      blue: c("blue"),
      violet: c("violet"),
      mag: c("mag"),
      bg: c("bg", 1, kh * 0.5),
    };
    paletteMemo.set(key, p);
  }
  return p;
}

// ---------- the pose ----------

/** Everything one frame depends on. `ta` is seconds on the orb's own clock; ages are -1 when nothing happened yet. */
export type OrbPose = {
  ta: number;
  /** 0 at rest, 1 listening (can overshoot a little). */
  listen: number;
  think: number;
  /** The landing's glow, 0 to 1. */
  done: number;
  smile: number;
  tilt: number;
  /** Where it looks: right and down, about -1 to 1. */
  ax: number;
  ay: number;
  blink: number;
  nod: number;
  /** A keystroke's kick, 0 to 1, that lights the grilles' slots like a level meter. */
  key: number;
  doneAge: number;
  noticeAge: number;
  /** -1 to 1, a slow breath. */
  breath: number;
};

// ---------- the orb's pieces ----------

type Ctx = CanvasRenderingContext2D;

function blob(ctx: Ctx, x: number, y: number, r: number, c: Rgb, a: number) {
  if (a <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(c, a));
  g.addColorStop(0.42, rgba(c, a * 0.78));
  g.addColorStop(0.76, rgba(c, a * 0.24));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function light(ctx: Ctx, x: number, y: number, r: number, a: number) {
  if (a <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${clamp(a).toFixed(3)})`);
  g.addColorStop(0.45, `rgba(255,255,255,${clamp(a * 0.42).toFixed(3)})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function circle(ctx: Ctx, r: number) {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
}

// angle, orbit, radius of the mesh's four colour masses
const MESH = [
  [3.95, 0.43, 0.88],
  [5.5, 0.45, 0.74],
  [0.78, 0.45, 0.86],
  [2.36, 0.45, 0.88],
] as const;

function meshPos(ta: number, fast: boolean) {
  const rot = fast ? 1.45 * ta + 1.1 : 0.22 * ta;
  return MESH.map((b, i) => {
    const a =
      b[0] +
      rot +
      (fast
        ? 0.5 * Math.sin(1.1 * ta + i * 1.93)
        : 0.42 * Math.sin(0.29 * ta + i * 1.93));
    return [Math.cos(a) * b[1], Math.sin(a) * b[1], b[2]] as const;
  });
}

/** Four soft colour masses drifting round a pale base; a faster swirl joins them while it works. */
function mesh(
  ctx: Ctx,
  R: number,
  S: OrbPose,
  pal: Palette,
  lx: number,
  ly: number,
) {
  ctx.fillStyle = rgba(pal.bg, 1);
  ctx.fillRect(-R * 1.7, -R * 1.7, R * 3.4, R * 3.4);
  const cols = [pal.blue, pal.mag, pal.pink, pal.violet];
  meshPos(S.ta, false).forEach((p, i) => {
    blob(ctx, p[0] * R + lx * R, p[1] * R + ly * R, p[2] * R, cols[i], 0.94);
  });
  const swirl = S.think * 0.55;
  if (swirl > 0.01) {
    meshPos(S.ta, true).forEach((p, i) => {
      blob(
        ctx,
        p[0] * R + lx * R * 0.6,
        p[1] * R + ly * R * 0.6,
        p[2] * R * 0.92,
        cols[i],
        0.9 * swirl,
      );
    });
  }
}

/** Lit top edge, shaded bottom: what makes the disc read as a sphere. Call inside the clip. */
function rim(ctx: Ctx, R: number, dark: boolean) {
  const g = ctx.createRadialGradient(
    0,
    -R * 0.3,
    R * 0.55,
    0,
    -R * 0.12,
    R * 1.16,
  );
  g.addColorStop(0, `rgba(${SHADE},0)`);
  g.addColorStop(0.72, `rgba(${SHADE},0)`);
  g.addColorStop(1, `rgba(${SHADE},${dark ? 0.3 : 0.24})`);
  ctx.fillStyle = g;
  ctx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
  const lw = Math.max(1, R * 0.05);
  const lg = ctx.createLinearGradient(0, -R, 0, R * 0.25);
  lg.addColorStop(0, "rgba(255,255,255,.7)");
  lg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.strokeStyle = lg;
  ctx.lineWidth = lw;
  circle(ctx, R - lw * 0.5);
  ctx.stroke();
}

function glow(ctx: Ctx, R: number, amt: number, c: Rgb, dark: boolean) {
  if (amt < 0.005) return;
  const r = R * 1.85;
  const g = ctx.createRadialGradient(0, 0, R * 0.55, 0, 0, r);
  g.addColorStop(0, rgba(c, amt * (dark ? 0.8 : 0.5)));
  g.addColorStop(0.38, rgba(c, amt * (dark ? 0.34 : 0.18)));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(-r, -r, 2 * r, 2 * r);
}

/** One ring that leaves the orb and fades: the landing's ping. */
function ping(ctx: Ctx, r0: number, age: number, pal: Palette, dark: boolean) {
  const dur = 1;
  if (!(age >= 0 && age < dur)) return;
  const u = age / dur;
  const r = r0 * (1.02 + (1.5 - 1.02) * eout(u));
  const a = (1 - u) ** 1.5;
  ctx.strokeStyle = rgba(
    dark ? mix(pal.blue, WHITE, 0.2) : pal.violet,
    a * (dark ? 0.75 : 0.62),
  );
  ctx.lineWidth = Math.max(1, r0 * 0.07 * (1 - u * 0.6));
  circle(ctx, r);
  ctx.stroke();
}

function eyePath(ctx: Ctx, w: number, h: number, smile: number) {
  const rx = (w / 2) * (1 + 0.12 * smile);
  const ry = h / 2;
  const e = 0.32 * ry * smile;
  const top = -ry;
  const bot = lerp(ry, -0.36 * ry, smile);
  const ct = (top - 0.25 * e) / 0.75;
  const cb = (bot - 0.25 * e) / 0.75;
  ctx.beginPath();
  ctx.moveTo(-rx, e);
  ctx.bezierCurveTo(-rx, ct, rx, ct, rx, e);
  ctx.bezierCurveTo(rx, cb, -rx, cb, -rx, e);
  ctx.closePath();
}

/** The sphere: the mesh turned toward where it looks, its rim, and two eye-lights that blink and smile. */
function sphere(
  ctx: Ctx,
  R: number,
  S: OrbPose,
  pal: Palette,
  dark: boolean,
  size: number,
) {
  const na = S.noticeAge;
  const perk = na >= 0 && na < 1.6 ? Math.exp(-2.6 * na) * smooth(na / 0.1) : 0;
  const L = clamp(S.listen, 0, 1.25);
  const sc = 1 + 0.015 * S.breath * (1 - S.think) + 0.025 * L + 0.04 * S.done;
  ctx.save();
  ctx.translate(0, S.nod * R * 0.11);
  ctx.scale(sc, sc);
  circle(ctx, R);
  ctx.clip();
  const yaw = clamp(S.ax, -1.1, 1.1) * 0.62;
  const pitch = -clamp(S.ay, -1.1, 1.1) * 0.5;
  const roll = S.tilt;
  mesh(ctx, R, S, pal, Math.sin(yaw) * 0.2, -Math.sin(pitch) * 0.16);
  light(ctx, -0.42 * R, -0.5 * R, 0.5 * R, 0.26);
  light(ctx, 0, R * 0.05, R * 0.9, 0.28 * S.done);
  rim(ctx, R, dark);
  const small = size < 40;
  const widen = 1 + 0.16 * perk;
  const open = clamp(1 - 0.94 * S.blink) * (1 - 0.3 * S.think) * widen;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const ew = Math.max(small ? 2.4 : 1.8, R * 0.16 * widen);
  const eh = Math.max(small ? 3.4 : 2.4, R * 0.3);
  for (const side of [-1, 1]) {
    const lon = side * 0.35;
    const lat = 0.05 + 0.04 * S.smile;
    const x = Math.sin(lon) * Math.cos(lat);
    const y = Math.sin(lat);
    const z = Math.cos(lon) * Math.cos(lat);
    const y1 = y * Math.cos(pitch) + z * Math.sin(pitch);
    const z1 = -y * Math.sin(pitch) + z * Math.cos(pitch);
    const x2 = x * Math.cos(yaw) + z1 * Math.sin(yaw);
    const sx = x2 * cr - y1 * sr;
    const sy = x2 * sr + y1 * cr;
    const fx = Math.sqrt(clamp(1 - sx * sx, 0.12, 1));
    const fy = Math.sqrt(clamp(1 - sy * sy, 0.2, 1));
    const h = Math.max(small ? 1.1 : 0.9, eh * open * fy);
    ctx.save();
    ctx.translate(sx * R * 0.84, -sy * R * 0.84 + (eh - h) * 0.28);
    ctx.rotate(-roll);
    ctx.shadowColor = dark ? "rgba(8,6,20,.4)" : "rgba(20,16,33,.28)";
    ctx.shadowBlur = Math.max(1, R * 0.07);
    ctx.fillStyle = "rgba(255,255,255,.97)";
    eyePath(ctx, ew * fx, h, clamp(S.smile) * (1 - S.blink));
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ---------- the grilles ----------

const SLOTS = 5;

/**
 * A lined pad on each side, like a microphone's, its inner edge behind the sphere. Tucked at rest,
 * open to listen with the slots lighting from the bottom on each keystroke, a light scanning up and
 * down while it works, a flash and a flare when it notices you and when it lands.
 */
function grilles(ctx: Ctx, r: number, S: OrbPose, pal: Palette) {
  const L = clamp(S.listen);
  const th = S.think;
  const fold = clamp(
    lerp(lerp(lerp(0.8, 0.18, L), 0.05, th), 0, clamp(S.done)),
  );
  const open = 1 - fold;
  let flare = 0.08 * open + 0.06 * L;
  let flash = 0;
  const na = S.noticeAge;
  const da = S.doneAge;
  if (na >= 0 && na < 1.4) {
    flare += 0.22 * Math.exp(-3.5 * na) * smooth(na / 0.08);
    flash = Math.max(flash, bump(na / 0.5));
  }
  if (da >= 0 && da < 1.4) {
    flare += 0.3 * bump(clamp(da / 0.9));
    flash = Math.max(flash, bump(da / 0.7));
  }
  const out = 0.06 + 0.08 * open;
  const lift = da >= 0 && da < 1 ? 0.04 * bump(da / 0.6) : 0;
  const level = clamp(0.16 * L * (1 - th) + 0.95 * S.key * L);
  const scan = (0.5 + 0.5 * Math.sin(2.4 * S.ta)) * (SLOTS - 1);

  const top = mix(pal.violet, WHITE, 0.08);
  const bot = mix(pal.violet, INK, 0.3);
  const edge = mix(pal.violet, INK, 0.55);
  const slot = mix(pal.violet, INK, 0.72);
  const lit = mix(pal.mag, WHITE, 0.45);
  const w = 0.5 * r;
  const h = r;
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(side * r * (0.98 + out), r * 0.04 - lift * r);
    ctx.rotate(-side * (0.14 - flare));
    const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, rgba(top, 1));
    g.addColorStop(1, rgba(bot, 1));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 0.22 * r);
    ctx.fill();
    // a soft light down the outer edge, so the pad reads as a rounded capsule
    const hl = ctx.createLinearGradient((side * w) / 2, 0, -side * w * 0.1, 0);
    hl.addColorStop(0, "rgba(255,255,255,.28)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hl;
    ctx.fill();
    ctx.strokeStyle = rgba(edge, 1);
    ctx.lineWidth = Math.max(0.8, 0.04 * r);
    ctx.stroke();
    // The slots sit on the part of the pad that shows beside the sphere, bottom (i = 0) to top.
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(0.8, 0.065 * r);
    const xa = side * w * 0.02;
    const xb = side * w * 0.3;
    for (let i = 0; i < SLOTS; i++) {
      const y = h * 0.32 - (h * 0.64 * i) / (SLOTS - 1);
      ctx.strokeStyle = rgba(slot, 1);
      ctx.beginPath();
      ctx.moveTo(xa, y);
      ctx.lineTo(xb, y);
      ctx.stroke();
      const amt = clamp(
        Math.max(
          level * SLOTS - i,
          th * Math.exp(-((i - scan) ** 2) / 0.5),
          flash,
        ),
      );
      if (amt > 0.02) {
        ctx.save();
        ctx.shadowColor = rgba(lit, 0.9 * amt);
        ctx.shadowBlur = 0.12 * r;
        ctx.strokeStyle = rgba(lit, amt);
        ctx.beginPath();
        ctx.moveTo(xa, y);
        ctx.lineTo(xb, y);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

/**
 * The whole orb, centred on the context's origin, for a footprint of `size` CSS px (R = size / 2).
 * Its glow and the landing's ping spill past the footprint, so draw it on a canvas twice its size.
 */
export function drawMicOrb(
  ctx: Ctx,
  size: number,
  S: OrbPose,
  { dark }: { dark: boolean },
) {
  const pal = palette(
    0.9 + 0.14 * clamp(S.listen) + 0.08 * S.think + 0.12 * clamp(S.done),
    -6 * S.think,
  );
  const r = (size / 2) * 0.72;
  const L = clamp(S.listen, 0, 1.25);
  const sc = 1 + 0.015 * S.breath * (1 - S.think) + 0.025 * L + 0.04 * S.done;
  const glowAmt = clamp(
    0.18 + 0.42 * clamp(S.listen) + 0.22 * S.think + 0.55 * S.done,
  );
  glow(ctx, r * sc, glowAmt * 0.85, mix(pal.blue, pal.violet, 0.4), dark);
  ping(ctx, r, S.doneAge, pal, dark);
  ctx.save();
  ctx.translate(0, S.nod * r * 0.11);
  ctx.rotate(S.tilt * 0.5);
  grilles(ctx, r, S, pal);
  ctx.restore();
  sphere(ctx, r, S, pal, dark, size * 0.72);
}

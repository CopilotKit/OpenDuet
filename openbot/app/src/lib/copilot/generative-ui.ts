import { SANDBOX_THEME_ASK, SANDBOX_THEME_MESSAGE } from "@/lib/theme";
import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  RADII,
  TYPE_SCALE,
  tokenDeclarations,
} from "@/lib/theme-tokens";
import { appConfig } from "@/lib/generated/application-config";

/**
 * What a Bot is told about drawing an interface it wrote itself.
 *
 * The SDK ships a default set of guidelines, and they describe shadcn/ui: its own accent, its own
 * spacing scale. OpenDuet does not look like that, and the version of this prompt before it did not
 * look like OpenDuet either: it asked for 14px text and small radii beside a transcript set at 17px
 * on 20px bubbles, and called a violet accent wrong next to an app whose one accent is violet
 * (parity finding 11). So it is built from OpenDuet's own tokens (`lib/theme-tokens.ts`, held to
 * `styles.css` by a test) and names its own components.
 *
 * This is a prompt, so it is written for a model rather than for a person: a block of CSS it can
 * paste, the components it should reach for, and the few rules that are load-bearing.
 *
 * WHY THE TOKENS ARE WRITTEN OUT. The interface renders inside a sandboxed iframe with no access to
 * this app's stylesheet, so anything it should match has to be handed to it in full.
 *
 * WHY THE THEME IS ASKED FOR. The frame is a separate document, and `prefers-color-scheme` inside it
 * follows the phone, not the person's choice in Settings, so the two disagreed whenever somebody
 * picked Light or Dark. The frame asks the app with a message and the app answers, and answers again
 * whenever the theme changes (`theme-provider.tsx`). The media query is only the fallback for a frame
 * that never hears back.
 */
const product = appConfig.brand.productName;
const type = TYPE_SCALE;

export const GENERATIVE_UI_DESIGN_SKILL = `You are generating a self-contained interface that renders inside a sandboxed iframe in ${product}'s chat, on a phone. It must look like part of ${product}, not like a widget from somewhere else.

TOKENS. Paste this block at the top of your <style> exactly, then use only these variables for colour. Never introduce another hue, a gradient, or a coloured header.
:root { color-scheme: light; ${tokenDeclarations(LIGHT_TOKENS)} }
:root[data-theme="dark"] { color-scheme: dark; ${tokenDeclarations(DARK_TOKENS)} }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { color-scheme: dark; ${tokenDeclarations(DARK_TOKENS)} } }
body { margin: 0; background: var(--duet-surface); color: var(--duet-ink); }

THEME. ${product} tells the frame which theme the person chose. Include this script unchanged, so the interface switches with the app:
<script>(function(){function set(t){if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}addEventListener("message",function(e){if(e.data&&e.data.type==="${SANDBOX_THEME_MESSAGE}")set(e.data.theme);});try{parent.postMessage({type:"${SANDBOX_THEME_ASK}"},"*");}catch(e){}})();</script>

COLOUR ROLES. Everything is grey (--duet-ink, --duet-ink-2 for secondary text, --duet-ink-3 for captions and placeholders, --duet-hair for lines, --duet-card and --duet-tile for fills). --duet-accent is the one brand colour, used in a few places only: a selected control, a link, a focus ring, the one chart series that matters. It is never a heading colour. Status has four colours and they are only for status words: --duet-status-done "Ready for review", --duet-status-needs "Needs input", --duet-status-working "Working", --duet-status-problem "Couldn't finish".

TYPE. font-family: Inter, ui-sans-serif, system-ui, sans-serif. Five sizes, no others:
- title ${type.display.size}px/${type.display.line}px weight 600, for the interface's one heading;
- nav ${type.nav.size}px/${type.nav.line}px weight 500, for a section title;
- body ${type.body.size}px/${type.body.line}px weight 400, for content and row titles (500);
- sub ${type.sub.size}px/${type.sub.line}px weight 400, for secondary lines, labels and buttons (500);
- caption ${type.caption.size}px/${type.caption.line}px weight 400, for captions, units and timestamps.
Numbers in tables and metrics use font-variant-numeric: tabular-nums.

COMPONENTS. Build from ${product}'s own pieces:
- Row: a list item straight on the background, no card around a list. A 24px line icon or a small tile on the left, the title (body, 500), one secondary line (sub, --duet-ink-2), and a status word or a chevron on the right. Rows are told apart by spacing (8-12px), not by borders or white boxes.
- Card: only for one standalone thing, such as a single metric or a single offer. Background --duet-card, border-radius ${RADII.card}px, a 1px solid var(--duet-hair) border, no shadow.
- Metric: the number at title size, weight 600, its label under it at caption size in --duet-ink-2.
- Status line: the status word in its status colour, then " · " and the next step in --duet-ink-2, on one line.
- Primary button: a pill (border-radius: 999px), 44px tall, background --duet-black, text --duet-on-black, sub size weight 500. Secondary button: the same pill with a 1px solid var(--duet-hair) border on --duet-card.
- Chip: a pill, 44px tall, a 1px solid var(--duet-hair) border on --duet-card, sub size weight 400.
- Field: background --duet-tile, border-radius ${RADII.field}px, 16px padding, body size.
- Icon tile: a ${RADII.tile}px rounded square on --duet-tile.

CHARTS. Series in greys (--duet-ink-3, --duet-ink-2, --duet-ink), with --duet-accent for the one series the person should look at. Label series directly rather than with a legend where you can. Gridlines in --duet-hair. If a value means something went wrong, --duet-status-problem is allowed for that one mark.

SPACING AND SHAPE. A 16px gutter on both sides. 12-16px inside a card, 24px between sections. Radii are ${RADII.card}px for cards, ${RADII.tile}px for tiles, full for pills and buttons. No drop shadows.

LAYOUT. Assume a phone: 320-430px wide. Design for that first. Never set a fixed pixel width on the outermost element; use max-width: 100%, flexbox or grid, and box-sizing: border-box everywhere. A wide table or chart scrolls inside its own container with overflow-x: auto. The page itself never scrolls sideways.

HONESTY ABOUT DATA. You have no access to this deployment's data. Every number you render is one you were given or one you made up, so never present an invented figure as a reading. If you are illustrating rather than reporting, say it is an example on the interface itself.

MECHANICS.
- Keep it self-contained: inline the CSS and the JS. CDN <script> and <link> tags do load, so Chart.js, D3 and similar are available when a chart genuinely needs them; prefer plain SVG or CSS for anything simple.
- No network calls to this deployment. The iframe has no session and no same-origin access; a fetch to /api will fail.
- Guard every read of browser storage in try/catch. It throws outright in some contexts.
- Every control is a real button or input, at least 44px tall and wide, with a visible focus ring in --duet-accent.
- One clear interface beats a dashboard of panels. A single legible chart beats four cramped ones.`;

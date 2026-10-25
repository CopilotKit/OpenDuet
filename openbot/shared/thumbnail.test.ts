import { expect, test } from "bun:test";
import { sanitizeThumbnail } from "./thumbnail";

const valid =
  '<svg viewBox="0 0 320 180"><rect width="320" height="180" fill="var(--duet-tile)"/><text x="20" y="60" fill="var(--duet-ink)">$528K</text></svg>';
test("keeps static themed content", () =>
  expect(sanitizeThumbnail(valid)).toBe(valid));
for (const malicious of [
  "<svg><script>alert(1)</script></svg>",
  "<svg><foreignObject><div>x</div></foreignObject></svg>",
  '<svg><image href="https://evil.test/x"/></svg>',
  '<svg onload="alert(1)"/>',
  '<svg><path style="fill:url(https://evil.test)"/></svg>',
  '<svg><use href="#x"/></svg>',
  '<svg><path fill="url(#x)"/></svg>',
  "<svg><text>&#60;script&#62;</text></svg>",
  '<svg><path fill="red"/><script/></svg>',
  "<svg/><svg/>",
  "<svg><g></svg>",
  '<svg><path fill="red" fill="blue"/></svg>',
  `<svg><text>${"x".repeat(4096)}</text></svg>`,
  "<!DOCTYPE svg><svg/>",
  "<svg><text>oops</text></svg><img src=x onerror=alert(1)>",
])
  test(`rejects unsafe SVG ${malicious.slice(0, 65)}`, () =>
    expect(sanitizeThumbnail(malicious)).toBeNull());

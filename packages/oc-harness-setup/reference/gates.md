# Gates: the five worth having
Ship every gate in the repo it guards, never in the harness; the harness stays zero-backend and only requires each gate exist and run green.
Gate 1 (boundary validation): validate every request at the edge with a schema (Zod or TypeBox), never by hand.
OpenAPI 3.1 describes contracts; it does not validate them — the schema validator does.
Gate 2 (layout scan): hand-write it; no off-the-shelf tool detects overlap, clipping, or overflow.
Fail when `scrollWidth > clientWidth` on any element or the document (horizontal overflow).
Fail when at scroll top the first content rect is not fully below the fixed header rect.
Fail when at scroll end the last content rect is not fully above the fixed footer rect.
Never fail on mid-scroll pass-under: content passing behind fixed chrome is the design, not a defect.
Fail when `elementFromPoint` at a text node's centre returns a different, opaque element (something covers it).
Watch with `ResizeObserver` wherever a measured height feeds a CSS variable; fail on unhandled shift.
Gate 3 (axe on key pages): run axe with wcag2a/wcag2aa/wcag21a/wcag21aa/wcag22aa tags on 2–3 key pages only.
axe catches ~57% of accessibility issues (https://github.com/dequelabs/axe-core); it misses focus order, keyboard traps, and contrast over gradients/images.
Never cite an axe pass as "accessible"; treat every `incomplete` result as a manual check.
Gate 4 (screenshots at three viewports): keep one screenshot per viewport on 1–2 pages (e.g. 360px phone, 768px tablet, 1280px laptop).
Keep baselines in-repo and update only on the same OS/browser; baselines rot fastest (fonts, GPU, snapshot churn).
Cap screenshot pages strictly; a baseline set that grows gets disabled within a month.
Gate 5 (shutdown + idempotency): send `Idempotency-Key` on every non-GET that creates; same key + same body replays the stored response.
On SIGTERM stop accepting, drain in-flight, then exit (https://12factor.net/disposability).
Log to stdout as a structured event stream, one JSON line per event (https://12factor.net/logs).
Contrast bars: body text 4.5:1, large text (>=18pt, or 14pt bold) 3:1, non-text UI 3:1 (https://www.w3.org/TR/WCAG22/).
Perf bars (good @ p75): LCP <=2.5s, INP <=200ms, CLS <=0.1 (https://web.dev/articles/vitals).
Every gate must be able to go red; seed one known failure per gate before trusting it.

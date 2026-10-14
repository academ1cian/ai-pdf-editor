# AI PDF Editor

A careful PDF text editor: upload, choose an exact text occurrence, review a replacement, apply it, validate the exported bytes, and download a genuinely edited PDF.

Status: **in development; not publicly deployed or production-verified yet**.

The standalone editing gate measured 31 distinct synthetic PDFs: **23 successful supported edits, 8 expected unsupported cases, 0 failures**. Successful exports were reopened using independent PDF.js extraction and compared against original renders at 108 dpi; zero unexpected pixels outside each source span. Embedded/subset/Unicode fonts, scans, forms, rotated spans, and overflow are explicitly unsupported by this version.

The implementation uses React, TypeScript, Vite, and MuPDF WASM in a browser worker. Optional Groq structured edit proposals pass deterministic checks and explicit user review. The combined application is AGPL-3.0-only. Source, tests, license inventory, and deployment instructions follow in the next milestones.

Deployment target: Cloudflare Pages plus a Worker with Turnstile and an atomic SQLite Durable Object request/token budget. No paid services are authorized. Browser-based Cloudflare Git integration avoids installing tools on the user's computer.

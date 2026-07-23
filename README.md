# capex-iq

React watchlist app with Cloudflare Pages Functions for market data, capex intel,
news, and scanner APIs.

## Deployment

This project is deployed on Cloudflare Workers (static assets) at
https://capex-iq.us (custom domain on the `capex-iq` Worker).

- Frontend: Vite build output from `dist/`, served as Worker static assets
  (SPA fallback enabled)
- Backend: the files in `functions/` are unchanged Pages-style functions;
  `workers/site/index.js` routes `/prices`, `/scanner`, `/capex-intel`, etc.
  to them with a Pages-compatible context shim
- Deploys: `.github/workflows/deploy-site.yml` builds and runs
  `wrangler deploy` from `workers/site/` on every merge to main (requires the
  `CLOUDFLARE_API_TOKEN` repo secret). Manual: `npx vite build` at the root,
  then `npx wrangler deploy` in `workers/site/`.
- Secrets on the Worker: `ADMIN_PASSWORD`, `DATABASE_URL`, `GEMINI_API_KEY`,
  `FINNHUB_KEY` (set via dashboard or `wrangler secret put`). `ALLOWED_ORIGIN`
  and the `SHARED_DATA` KV binding live in `workers/site/wrangler.jsonc` â€”
  the KV namespace is the same one the old Pages project used.
- Scheduled Worker: `workers/prewarm/` (deployed separately via
  `npx wrangler deploy`) warms the `/prices` KV cache every 2 minutes during
  US market hours by requesting the full ticker universe through the public
  site, so visitor loads hit a warm cache.
- The legacy Cloudflare Pages deployment has been deleted; capex-iq.us is
  the only deployment.

### /prices caching model

Two KV layers: a 60s quote cache (hit check is subset-based against the
`covered` ticker set the cached cycle attempted, so a dead symbol can't
poison the cache) and a 6h reference blob (`priceRefs_v1`) holding each
ticker's historical closes for the 5D/1M/6M/YTD/1Y percentages, 52-week
range, and earnings date. Warm cycles fetch only live v7 quotes (1 request
per 40 tickers); the expensive 2-year chart fetches happen once per 6h.
When Yahoo's v7 quote endpoint freezes (it happens), prices fall back to the
live v8 chart meta per ticker automatically.

## Environment

Configure these Cloudflare environment variables as needed:

- `ALLOWED_ORIGIN`
- `ADMIN_PASSWORD`
- `DATABASE_URL`
- `FINNHUB_KEY`
- `GEMINI_API_KEY`
- `SHARED_DATA` KV binding

## Musk Galaxy view

A second view (tab at the top, or `#musk` in the URL) tracking capex flow and
supply-chain dependency for Elon Musk's companies â€” Tesla, SpaceX/Starlink,
xAI, the Terafab project, Boring, Neuralink. Same machinery as the AI view:
a Sankey fed by search-grounded `/musk-intel` (private-company capex from
public reporting; only TSLA carries live prices), a KV-backed editable map
(`/musk-capex`, dataset defaults in
`src/components/capex-map/muskData.js`), and a dedicated dependency graph
with the same stress propagation. Musk-map tickers are automatically unioned
into the weekly transcript/XBRL/exposure scan universe, so STRESS and BKLG
badges light up on Musk sub-sectors with no extra setup.

## Composite Bottleneck Score (CBS)

`src/composite_score.py` (runs each Sunday right after the XBRL gauges, same
workflow) blends everything the system knows about a ticker's OWN bottleneck
evidence into one 0-100 number: transcript stress (0.50), XBRL backlog score
(0.35), filed customer concentration (0.15) â€” weights renormalized over the
components a name actually has, inputs stored per row so every score is
auditable. Weekly snapshots accumulate in Neon `composite_scores` (history â†’
sparklines), served by `GET /composite`. Surfaces as â¬¢ chips on sub-sector
cards, per-company CBS lines with sparklines in the stress drilldowns, a
"Bottleneck Score Movers" strip (heating/cooling, weekly deltas) above the
dependency graph, and a CBS line in the graph's node panel. A Telegram digest
fires on meaningful weekly moves (Î” â‰¥ 15 or crossing 70). Graph-inherited
risk is deliberately not blended in â€” CBS measures intrinsic heat; the graph
radiates it.

## Signal Performance Scoreboard

`src/signal_scoreboard.py` (runs each Sunday after the CBS step, same
workflow) is the feedback loop that tests whether the signals actually have
edge. Every time the system fires â€” CBS crossing 70, CBS jumping +15 in a
week, transcript stress crossing 70, XBRL order gap breaching +50pp, or a
scout candidate being approved â€” the event is logged to Neon `signal_events`
with the first close after the event date, and 1w/1m/3m forward returns vs
QQQ are filled in as each window matures. Transcript events are backfilled to
their earnings-call dates, so the scoreboard seeds with history immediately.
A 90-day per-ticker refractory stops threshold oscillation from double
counting. `GET /scoreboard` aggregates median excess return and hit rate per
signal type (plus an all-signals rollup); the âš– Signal Scoreboard panel below
the Bottleneck Scout renders the verdict and the most recent signal chips.
No alerting â€” this layer is passive measurement.

## Obsidian weekly digest (local)

`src/obsidian_digest.py` writes a weekly markdown digest into an Obsidian
vault â€” the thesis/journal layer that lives outside the dashboard. It runs
LOCALLY (Windows Task Scheduler task `WatchlistObsidianDigest`, Sundays
6:00 PM, after the cloud ETLs) and reads only the deployed site's public
endpoints (`/composite`, `/scoreboard`, `/stress`, `/candidates`) â€” no DB
credentials on the machine. Each digest lands in `Journal/` with CBS movers,
hottest composites with call evidence, new signal events, the scoreboard
verdict, and the pending scout queue, all as `[[TICKER]]` links. Anything
written under the note's `## My Notes` heading survives regeneration.
Sections degrade gracefully if an endpoint is down; every run appends to
`~/watchlist-digest.log`. Vault path via `OBSIDIAN_VAULT`, site root via
`WATCHLIST_BASE_URL`.

## Robotics view

A third view (tab, or `#robotics` in the URL) tracking the humanoid-robot
buildout, structured on Goldman Sachs' framework â€” the thesis that the value
is in the ~40 repeating component parts, not the robot maker. Six tracks from
Goldman's component categories (Brain & Edge AI, Sensors, Motors, Joints &
Precision Motion, Power Electronics, Rare Earth & Energy); the bottleneck is
precision motion (harmonic/strain-wave gears â€” Harmonic Drive `6324.T`,
roller screws â€” THK `6481.T`) and rare-earth magnets (MP, USAR). Robot makers
(Tesla, Figure, Agility/CCXI, Unitree, 1X, XPeng, BYD â€” mostly private) are
demand hubs on the Sankey, fed by search-grounded `/robotics-intel`. KV-backed
map at `/robotics-capex`, dataset in
`src/components/capex-map/roboticsData.js`. All US/ADR tickers were validated
against live quotes; robotics-map tickers join the weekly scan universe.

## Bottleneck Scout (AI candidate discovery)

`src/bottleneck_scout.py` (run weekly by `.github/workflows/bottleneck-scout.yml`)
uses search-grounded Gemini to hunt recent bottleneck news per capex track
(shortages, allocation, lead times, sole-source suppliers) and proposes
public companies not already on the map â€” US listings preferred, OTC ADRs
accepted. Every proposed ticker is identity-verified against Yahoo (claimed
company name must match the symbol â€” hallucinated tickers are dropped), then
enriched with a one-shot stress snapshot using the same transcript + XBRL
code the map runs on. Candidates land in Neon `bottleneck_candidates`
(status pending), served by `GET /candidates`, and surface in the dashboard's
Bottleneck Scout panel where the admin reviews each with the signals in
view: Approve adds the ticker to the capex map (auto-enrolling it in the
weekly signal scans), Reject suppresses it permanently. Needs the existing
`DATABASE_URL` + `GEMINI_API_KEY` secrets and `WATCHLIST_BASE_URL` variable.

The scout covers BOTH views: each weekly run scouts the AI hyperscaler chain
and the Musk Galaxy chain (themes per Musk track â€” Colossus suppliers, the
Tesla battery/SiC chain, SpaceX/Starlink, Optimus). Candidates carry a
`view` tag (ðŸš€ MUSK chip in the queue) and approval routes the ticker into
the matching map. The `SCOUT_VIEW` workflow input restricts a run to `ai`
or `musk`; `MAX_NEW_CANDIDATES` caps each view separately.

## Capex guidance: grounded intel, history, Sankey hero

`/capex-intel` now runs its total-capex prompt with Google Search grounding,
so the headline number tracks the latest guidance revisions and news instead
of the model's training data, and returns a per-hyperscaler breakdown
(`byCompany`). Every fresh reading is appended to the Neon
`capex_intel_history` table (auto-created; needs the same `DATABASE_URL`
binding as the other endpoints) and served by `GET /capex-history`, giving
the UI a guidance trend â€” the first derivative of hyperscaler capex, which is
the actual signal. The old Sector News / Bloomberg panels are gone; the hero
is now a Sankey (`src/components/CapexSankey.jsx`): hyperscalers on the left
(grounded $B + live prices), the six tracks on the right, ribbon widths
proportional to dollars, click a sector to open its track pane. Per-company
sector mix isn't disclosed anywhere, so ribbons fan out proportionally â€” the
footnote says so.

## Customer-exposure extraction (filed edge weights)

`src/customer_exposure.py` (run monthly by
`.github/workflows/customer-exposure.yml`) reads each company's latest 10-K /
20-F and 10-Q from EDGAR, isolates the customer-concentration passages, and
has Gemini extract structured rows: customer name exactly as printed (or the
anonymous "Customer A" label â€” identities are never guessed), percent of
revenue or receivables, period, and a verbatim quote. Named customers are
mapped to tickers via an alias table and stored in Neon `customer_exposure`,
served by `GET /exposure`. Where a filed disclosure matches a supply-graph
edge, the edge upgrades from curated criticality to the filed revenue-exposure
percentage (shown in cyan as "(filed)" in tooltips and the detail panel), and
the propagation engine treats â‰¥30%-of-revenue relationships as fully
critical. Needs `DATABASE_URL` + `GEMINI_API_KEY` secrets and the
`WATCHLIST_BASE_URL` variable â€” all already configured.

## Supply-chain dependency graph

`src/components/capex-map/supplyGraphData.js` encodes the supplier â†’ customer
graph (~56 nodes, ~112 edges): map tickers plus external chokepoints with no
ticker (China gallium/indium, SK Hynix/Samsung HBM, large power transformers,
grid interconnection queues). The propagation engine combines live transcript
stress and XBRL gauges into a per-node bottleneck strength, then radiates it
downstream with criticality-weighted decay â€” so an InP substrate constraint at
AXT automatically flags Lumentum/Coherent as input-risk and traces all the way
to the hyperscalers. Rendered as an interactive SVG below the capex map: click
any node to trace its upstream suppliers and downstream blast radius, with an
auditable "at risk via X (score, input, hops)" breakdown. Pure frontend â€” the
graph is hand-curated; edit the data module to refine relationships.

## XBRL backlog/inventory gauges

`src/xbrl_gauges.py` (run weekly by `.github/workflows/xbrl-gauges.yml`) pulls
quarterly fundamentals for every capex-map company from SEC's free
companyfacts XBRL API â€” no key, no cost. It computes the gauges where a
bottleneck shows up in the numbers before the narrative: the **order gap**
(RPO/backlog YoY growth minus revenue YoY growth â€” positive means orders are
outrunning shipping capacity) and **inventory days** trends (rising at buyers
= hoarding/double-ordering). Results land in the Neon `xbrl_gauges` table,
are served by `GET /gauges`, and surface as BKLG chips and per-company gauge
lines in the subsector stress drilldowns. Only needs the `DATABASE_URL`
secret and the `WATCHLIST_BASE_URL` variable.

## Transcript NLP stress detection

`src/transcript_stress.py` (run weekly by `.github/workflows/transcript-stress.yml`)
scans the earnings-call transcripts of every company on the capex map for
supply-chain stress language ("on allocation", "lead times extended", "sold
out throughâ€¦"). A deterministic lexicon scan flags transcripts; only flagged
excerpts are sent to Gemini, which scores severity (0â€“100), classifies the
company as bottleneck owner vs input-constrained, and must return verbatim
supporting quotes. Results land in the Neon `transcript_stress` table, are
served by `GET /stress`, and surface as live STRESS badges (with per-company
quote drilldowns) on each subsector card.

Transcripts come from [defeatbeta-api](https://github.com/defeat-beta/defeatbeta-api)
â€” free, no API key, an open Hugging Face dataset queried via DuckDB, with
verified coverage of the watchlist universe including the small caps.

GitHub Actions secrets for the workflow:

- `DATABASE_URL` â€” Neon Postgres (same as scanner ETL). Required.
- `GEMINI_API_KEY` â€” optional; without it scores are lexicon-only (capped at 40)
- `API_NINJAS_KEY` / `EARNINGSCALL_API_KEY` â€” optional PAID fallback transcript
  providers, only consulted for tickers defeatbeta doesn't carry
- `WATCHLIST_BASE_URL` (repo **variable**, not secret) â€” deployed site root so
  the ETL scans the live capex-map ticker list instead of the embedded default

## Notes

- The Bloomberg market-news endpoint prefers same-day headlines in New York market
  time, but falls back to the latest available headlines on weekends and holidays.
- The ETL pipeline can now bootstrap the `ranked_candidates` table in a fresh
  Neon database before loading scanner results.
- Full setup guide: [docs/cloudflare-setup.md](docs/cloudflare-setup.md)

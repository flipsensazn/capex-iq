# wizzles-watchlist

React watchlist app with Cloudflare Pages Functions for market data, capex intel,
news, and scanner APIs.

## Deployment

This project is deployed on Cloudflare Pages.

- Frontend: Vite build output from `dist/`
- Backend: Cloudflare Pages Functions from `functions/`
- Runtime expectation: app routes call root-relative endpoints such as `/prices`,
  `/scanner`, `/market-news`, and `/capex-intel`

## Environment

Configure these Cloudflare environment variables as needed:

- `ALLOWED_ORIGIN`
- `ADMIN_PASSWORD`
- `DATABASE_URL`
- `FINNHUB_KEY`
- `GEMINI_API_KEY`
- `SHARED_DATA` KV binding

## Bottleneck Scout (AI candidate discovery)

`src/bottleneck_scout.py` (run weekly by `.github/workflows/bottleneck-scout.yml`)
uses search-grounded Gemini to hunt recent bottleneck news per capex track
(shortages, allocation, lead times, sole-source suppliers) and proposes
public companies not already on the map — US listings preferred, OTC ADRs
accepted. Every proposed ticker is identity-verified against Yahoo (claimed
company name must match the symbol — hallucinated tickers are dropped), then
enriched with a one-shot stress snapshot using the same transcript + XBRL
code the map runs on. Candidates land in Neon `bottleneck_candidates`
(status pending), served by `GET /candidates`, and surface in the dashboard's
Bottleneck Scout panel where the admin reviews each with the signals in
view: Approve adds the ticker to the capex map (auto-enrolling it in the
weekly signal scans), Reject suppresses it permanently. Needs the existing
`DATABASE_URL` + `GEMINI_API_KEY` secrets and `WATCHLIST_BASE_URL` variable.

## Capex guidance: grounded intel, history, Sankey hero

`/capex-intel` now runs its total-capex prompt with Google Search grounding,
so the headline number tracks the latest guidance revisions and news instead
of the model's training data, and returns a per-hyperscaler breakdown
(`byCompany`). Every fresh reading is appended to the Neon
`capex_intel_history` table (auto-created; needs the same `DATABASE_URL`
binding as the other endpoints) and served by `GET /capex-history`, giving
the UI a guidance trend — the first derivative of hyperscaler capex, which is
the actual signal. The old Sector News / Bloomberg panels are gone; the hero
is now a Sankey (`src/components/CapexSankey.jsx`): hyperscalers on the left
(grounded $B + live prices), the six tracks on the right, ribbon widths
proportional to dollars, click a sector to open its track pane. Per-company
sector mix isn't disclosed anywhere, so ribbons fan out proportionally — the
footnote says so.

## Customer-exposure extraction (filed edge weights)

`src/customer_exposure.py` (run monthly by
`.github/workflows/customer-exposure.yml`) reads each company's latest 10-K /
20-F and 10-Q from EDGAR, isolates the customer-concentration passages, and
has Gemini extract structured rows: customer name exactly as printed (or the
anonymous "Customer A" label — identities are never guessed), percent of
revenue or receivables, period, and a verbatim quote. Named customers are
mapped to tickers via an alias table and stored in Neon `customer_exposure`,
served by `GET /exposure`. Where a filed disclosure matches a supply-graph
edge, the edge upgrades from curated criticality to the filed revenue-exposure
percentage (shown in cyan as "(filed)" in tooltips and the detail panel), and
the propagation engine treats ≥30%-of-revenue relationships as fully
critical. Needs `DATABASE_URL` + `GEMINI_API_KEY` secrets and the
`WATCHLIST_BASE_URL` variable — all already configured.

## Supply-chain dependency graph

`src/components/capex-map/supplyGraphData.js` encodes the supplier → customer
graph (~56 nodes, ~112 edges): map tickers plus external chokepoints with no
ticker (China gallium/indium, SK Hynix/Samsung HBM, large power transformers,
grid interconnection queues). The propagation engine combines live transcript
stress and XBRL gauges into a per-node bottleneck strength, then radiates it
downstream with criticality-weighted decay — so an InP substrate constraint at
AXT automatically flags Lumentum/Coherent as input-risk and traces all the way
to the hyperscalers. Rendered as an interactive SVG below the capex map: click
any node to trace its upstream suppliers and downstream blast radius, with an
auditable "at risk via X (score, input, hops)" breakdown. Pure frontend — the
graph is hand-curated; edit the data module to refine relationships.

## XBRL backlog/inventory gauges

`src/xbrl_gauges.py` (run weekly by `.github/workflows/xbrl-gauges.yml`) pulls
quarterly fundamentals for every capex-map company from SEC's free
companyfacts XBRL API — no key, no cost. It computes the gauges where a
bottleneck shows up in the numbers before the narrative: the **order gap**
(RPO/backlog YoY growth minus revenue YoY growth — positive means orders are
outrunning shipping capacity) and **inventory days** trends (rising at buyers
= hoarding/double-ordering). Results land in the Neon `xbrl_gauges` table,
are served by `GET /gauges`, and surface as BKLG chips and per-company gauge
lines in the subsector stress drilldowns. Only needs the `DATABASE_URL`
secret and the `WATCHLIST_BASE_URL` variable.

## Transcript NLP stress detection

`src/transcript_stress.py` (run weekly by `.github/workflows/transcript-stress.yml`)
scans the earnings-call transcripts of every company on the capex map for
supply-chain stress language ("on allocation", "lead times extended", "sold
out through…"). A deterministic lexicon scan flags transcripts; only flagged
excerpts are sent to Gemini, which scores severity (0–100), classifies the
company as bottleneck owner vs input-constrained, and must return verbatim
supporting quotes. Results land in the Neon `transcript_stress` table, are
served by `GET /stress`, and surface as live STRESS badges (with per-company
quote drilldowns) on each subsector card.

Transcripts come from [defeatbeta-api](https://github.com/defeat-beta/defeatbeta-api)
— free, no API key, an open Hugging Face dataset queried via DuckDB, with
verified coverage of the watchlist universe including the small caps.

GitHub Actions secrets for the workflow:

- `DATABASE_URL` — Neon Postgres (same as scanner ETL). Required.
- `GEMINI_API_KEY` — optional; without it scores are lexicon-only (capped at 40)
- `API_NINJAS_KEY` / `EARNINGSCALL_API_KEY` — optional PAID fallback transcript
  providers, only consulted for tickers defeatbeta doesn't carry
- `WATCHLIST_BASE_URL` (repo **variable**, not secret) — deployed site root so
  the ETL scans the live capex-map ticker list instead of the embedded default

## Notes

- The Bloomberg market-news endpoint prefers same-day headlines in New York market
  time, but falls back to the latest available headlines on weekends and holidays.
- The ETL pipeline can now bootstrap the `ranked_candidates` table in a fresh
  Neon database before loading scanner results.
- Full setup guide: [docs/cloudflare-setup.md](docs/cloudflare-setup.md)

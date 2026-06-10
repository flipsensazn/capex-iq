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

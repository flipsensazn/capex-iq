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

## Notes

- The Bloomberg market-news endpoint prefers same-day headlines in New York market
  time, but falls back to the latest available headlines on weekends and holidays.
- The ETL pipeline can now bootstrap the `ranked_candidates` table in a fresh
  Neon database before loading scanner results.
- Full setup guide: [docs/cloudflare-setup.md](docs/cloudflare-setup.md)

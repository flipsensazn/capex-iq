# Cloudflare Setup

This project is designed for Cloudflare Pages with Pages Functions.

## App Shape

- Frontend build: Vite
- Frontend output directory: `dist`
- Serverless runtime: `functions/`
- Expected API routes:
  - `/prices`
  - `/quote`
  - `/news`
  - `/market-news`
  - `/shortlist`
  - `/capex`
  - `/capex-intel`
  - `/presence`
  - `/cnn-fear-greed`

## Required Cloudflare Configuration

Set up a Cloudflare Pages project connected to this GitHub repository.

Use these build settings:

- Framework preset: `Vite`
- Build command: `npm run build`
- Build output directory: `dist`

Pages Functions are picked up automatically from `functions/`.

## Environment Variables

Configure these variables in Cloudflare Pages for the appropriate environments:

- `ALLOWED_ORIGIN`
  - Set this to the deployed site origin, for example `https://your-site.pages.dev`
- `ADMIN_PASSWORD`
  - Used by admin-only update endpoints such as `/shortlist`, `/capex`, and `/capex-intel`
- `DATABASE_URL`
  - Neon/Postgres connection string used by `presence`
- `FINNHUB_KEY`
  - Used for crypto quotes and fallback pricing in `/prices`
- `GEMINI_API_KEY`
  - Used by `/capex-intel` for dynamic capex allocation generation

## KV Binding

Create a KV namespace and bind it to:

- `SHARED_DATA`

The app uses this binding for:

- cached Yahoo session crumbs
- price cache
- shared shortlist
- shared capex data
- cached capex intel payloads

## Database Notes

The following runtime functions expect `DATABASE_URL` to be present:

- [functions/presence.js](../functions/presence.js)

## Deployment Checklist

1. Push changes to GitHub.
2. Confirm the Cloudflare Pages branch preview or production deployment succeeds.
3. Verify the homepage loads and the root-relative API routes respond from the same origin.
4. Confirm the following panels populate in the browser:
   - market strip / prices
   - Bloomberg news feed
   - Fear & Greed
   - capex intel

## Operational Notes

- `market-news` prefers same-day Bloomberg items in New York market time, but falls back to recent headlines on weekends and holidays.
- Most functions restrict CORS to `ALLOWED_ORIGIN`, so direct terminal requests without a matching origin may return `403`.

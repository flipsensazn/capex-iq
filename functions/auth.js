// GET /auth — Cloudflare Access sign-in handoff.
//
// Before Access moves from /app this is a public redirect. After the move,
// Access authenticates the visitor here and the resulting domain cookie lets
// the redirect land on the public dashboard as a signed-in member.

const AUTH_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0;url=/app">
  <title>Continuing to CAPEX-IQ…</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background: #080b10;
      color: #e8edf5;
      font: 500 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      padding: 24px;
      text-align: center;
    }
    a {
      color: #6ee7c7;
      text-underline-offset: 4px;
    }
  </style>
  <script>location.replace("/app");</script>
</head>
<body>
  <main>
    <a href="/app">Continuing to CAPEX-IQ…</a>
  </main>
</body>
</html>`;

export function onRequest({ request }) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return new Response(AUTH_PAGE, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

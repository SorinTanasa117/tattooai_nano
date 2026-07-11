# InkFrame

A self-hosted browser widget for placing tattoo designs on body photos and rendering them as photorealistic permanent ink via a Gemini AI image model.

## How to run

The workflow **"Start application"** runs `node server.js` on port 5000. Start it from the Replit workflow panel or shell:

```
node server.js
```

No build step required. The server has zero npm runtime dependencies.

## Stack

- **Runtime**: Node.js ≥ 20 (plain `http` module, no framework)
- **Frontend**: Vanilla JS + HTML/CSS (`index.html`, `js/`, `styles.css`)
- **AI**: Google Gemini image generation API (via `AI_PROVIDER_API_KEY`)
- **Storage**: Cloudflare R2 (used for both the dev server and the Netlify functions deployment)

## Environment variables & secrets

All set via Replit environment / Replit Secrets — do **not** add credentials to `.env`.

| Key | Type | Description |
|-----|------|-------------|
| `PORT` | env var | Server port (set to `5000`) |
| `AI_MODEL_NAME` | env var | Gemini model name (default: `gemini-3.1-flash-image`) |
| `RENDER_TIMEOUT_MS` | env var | Max AI render wait in ms (default: `30000`) |
| `R2_ACCOUNT_ID` | env var | Cloudflare R2 account ID |
| `R2_BUCKET_NAME` | env var | Cloudflare R2 bucket name |
| `AI_PROVIDER_API_KEY` | **secret** | Gemini / Google AI Studio API key |
| `R2_ACCESS_KEY_ID` | **secret** | Cloudflare R2 access key |
| `R2_SECRET_ACCESS_KEY` | **secret** | Cloudflare R2 secret key |

## Project structure

```
server.js          – Dev server: static files, upload API, AI proxy
index.html         – Widget UI
js/
  app.js           – Main UI logic
  canvas.js        – Tattoo placement canvas
  geometry.js      – Transform helpers
  payload.js       – Render payload builder
styles.css         – UI styles
netlify/functions/ – Serverless equivalents (for Netlify deployment)
scripts/           – Build/test utilities
```

## User preferences

- Keep the project's existing zero-dependency server structure.
- Store all secrets in Replit Secrets, not in `.env`.

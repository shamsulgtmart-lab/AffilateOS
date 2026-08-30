# TSS FFmpeg Render Worker

A self-contained HTTP service that performs the FFmpeg work the Base44 serverless
runtime cannot: extracting the final frame of a video, concatenating two scenes,
and burning post-production overlay text. It is deployed separately (e.g. on
Render) and called by the Base44 backend.

The worker contains **no Gemini API key** and **never calls Gemini**. All AI video
generation stays inside Base44. The worker only does FFmpeg processing on the
files Base44 sends it.

---

## 1. What the worker does

- `GET /health` — liveness probe (no auth).
- `POST /extract-frame` — extracts the actual final frame of an uploaded MP4 and
  returns it as a JPG.
- `POST /assemble` — concatenates Scene 1 + Scene 2 into one continuous ~16s
  vertical (9:16) video, preserves audio, then burns overlay text on top, and
  returns the final MP4.

There is no transition between Scene 1 and Scene 2 unless one is implied by the
overlay/input data. The final video stays vertical 9:16.

---

## 2. Required environment variable

| Variable | Purpose |
|----------|---------|
| `RENDER_WORKER_SECRET` | Shared secret. Every request to `/extract-frame` and `/assemble` must send `Authorization: Bearer <RENDER_WORKER_SECRET>`. The worker rejects missing/invalid tokens and never exposes the secret. |

The worker does **not** use `GEMINI_API_KEY` and does not depend on Google Cloud.

---

## 3. Local Docker build / run

```bash
cd render-worker
docker build -t tss-ffmpeg-worker .
# Replace <secret> with your own long random secret.
docker run -p 8080:8080 -e RENDER_WORKER_SECRET=<secret> tss-ffmpeg-worker
# Health check:
curl http://localhost:8080/health
```

---

## 4. Render deployment

1. Push the `render-worker/` directory to a GitHub repo (or a subfolder of one).
2. In Render: **New → Web Service → Existing repository** (or **Deploy from
   Docker registry** if you pre-built the image).
3. Settings:
   - **Runtime**: Docker
   - **Build Command**: _(none — the Dockerfile handles it)_
   - **Start Command**: _(none — the Dockerfile CMD handles it)_
   - **Plan**: a paid plan that allows long-running requests (video assembly can
     take 1–3 minutes). The free tier's request timeout may be too short.
   - **Environment Variables**: add `RENDER_WORKER_SECRET` = your long random
     secret (see section 10).
4. Deploy. Render will build the Docker image and start the service on the port
   it injects via `PORT` (the Dockerfile binds to `${PORT}` automatically).

---

## 5. Health endpoint

`GET /health` — no authentication.

```json
{ "status": "ok", "service": "tss-ffmpeg-worker" }
```

---

## 6. `/extract-frame` usage

`POST /extract-frame`

- **Auth**: `Authorization: Bearer <RENDER_WORKER_SECRET>`
- **Content-Type**: `multipart/form-data`
- **Field**: `video` = the MP4 file

**Response**: the extracted final frame as `image/jpeg` (binary).

```bash
curl -X POST http://localhost:8080/extract-frame \
  -H "Authorization: Bearer <secret>" \
  -F "video=@scene1.mp4" \
  -o last_frame.jpg
```

---

## 7. `/assemble` usage

`POST /assemble`

- **Auth**: `Authorization: Bearer <RENDER_WORKER_SECRET>`
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `scene1` = Scene 1 MP4
  - `scene2` = Scene 2 MP4 (optional for 1-scene jobs)
  - `overlay` = JSON string (see section 8)

**Response**: the final assembled MP4 as `video/mp4` (binary).

```bash
curl -X POST http://localhost:8080/assemble \
  -H "Authorization: Bearer <secret>" \
  -F "scene1=@scene1.mp4" \
  -F "scene2=@scene2.mp4" \
  -F 'overlay=@overlays.json;type=application/json' \
  -o final_ugc.mp4
```

---

## 8. Expected request fields / overlay JSON

The `overlay` field is a JSON string. Both shapes are accepted:

Bare array:
```json
[
  { "start": 0, "end": 3, "text": "Example text", "position": "bottom-center", "size": "medium", "text_color": "white", "stroke_color": "black" }
]
```

Wrapped object:
```json
{
  "overlays": [
    { "start": 0, "end": 3, "text": "Example text", "position": "bottom-center", "size": "medium", "text_color": "white", "stroke_color": "black" }
  ]
}
```

Overlay fields:
- `start`, `end` — seconds on the **final combined** timeline.
- `text` — the string to burn in.
- `position` — `top-center` | `center` | `bottom-center` (default `bottom-center`).
- `size` — `small` | `medium` | `large` (default `medium`).
- `text_color` / `stroke_color` — defaults `white` / `black`.

Defaults applied: white text, black stroke, medium readable size, bottom-center.
Overlays are rendered **after** Scene 1 + Scene 2 are concatenated.

---

## 9. Expected responses

| Endpoint | Success | Failure |
|----------|---------|---------|
| `/health` | `200` `{"status":"ok","service":"tss-ffmpeg-worker"}` | — |
| `/extract-frame` | `200` `image/jpeg` (binary) | `400` missing file / `401` bad token / `500` ffmpeg error (JSON `{error, log}`) |
| `/assemble` | `200` `video/mp4` (binary) | `400` missing scene1 / `401` bad token / `500` concat/overlay error (JSON `{error, log}`) |

---

## 10. How to set `RENDER_WORKER_SECRET`

1. Generate a long random secret (e.g. `openssl rand -hex 32`).
2. In **Render**: service → Environment → add `RENDER_WORKER_SECRET` with that
   value.
3. In **Base44**: Dashboard → Settings → Environment Variables → add
   `RENDER_WORKER_SECRET` with the **same** value, plus `RENDER_WORKER_URL` set to
   the Render service URL (e.g. `https://your-service.onrender.com`, no trailing
   slash).

Never put the real secret in the repo, README, logs, or error responses.

---

## 11. How Base44 connects to it

- **`/extract-frame`** — the Base44 function `omniExtractFrame` takes the Scene 1
  MP4 (base64 from Gemini), sends it as multipart field `video` with the Bearer
  header, and receives the last-frame JPG back to use as Scene 2's
  first/reference image.
- **`/assemble`** — the Base44 function `omniAssemble` takes Scene 1 + Scene 2
  MP4s (base64) plus the timeline-mapped overlay array, sends them as multipart
  fields `scene1`, `scene2`, and `overlay` (JSON string) with the Bearer header,
  and receives the final assembled MP4 back for the user to preview/download.

The worker never calls Gemini, never regenerates a scene, and only ever does
FFmpeg work on the files Base44 sends it. All uploaded and intermediate files
are written to a temporary directory that is removed after every request
(success or failure).
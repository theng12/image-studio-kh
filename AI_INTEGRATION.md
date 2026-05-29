# AI Studio — Provider integration notes

Captured from official docs on 2026-05-19. Used as the implementation reference for
`main/ai/providers/*.js`.

---

## kie.ai

- **Base URL:** `https://api.kie.ai`
- **Auth:** `Authorization: Bearer <API_KEY>` + `Content-Type: application/json`
- **All endpoints are async.** Submit returns `{ code: 200, data: { taskId } }`. Poll
  `record-info` until `successFlag` is 1 (done) or 2 (failed).
- **Rate limit:** 20 new submissions / 10 s. Up to ~100 concurrent in queue.

### Models we expose

| Display name           | Model id (UI)         | Submit endpoint                                       | Poll endpoint                                          |
|------------------------|-----------------------|-------------------------------------------------------|--------------------------------------------------------|
| ChatGPT Image (4o)     | `kie:gpt4o-image`     | `POST /api/v1/gpt4o-image/generate`                   | `GET /api/v1/gpt4o-image/record-info?taskId=…`         |
| Flux Kontext Pro       | `kie:flux-kontext-pro`| `POST /api/v1/flux/kontext/generate`                  | `GET /api/v1/flux/kontext/record-info?taskId=…`        |
| Flux Kontext Max       | `kie:flux-kontext-max`| `POST /api/v1/flux/kontext/generate` (model:`…-max`)  | same                                                   |

### Request body — gpt4o-image (image-to-image / variants)

```json
{
  "prompt": "...",
  "size": "1:1" | "3:2" | "2:3",
  "filesUrl": ["https://..."],   // source image URL(s), up to 5
  "maskUrl": "https://...",      // optional, for inpainting
  "nVariants": 1 | 2 | 4,
  "isEnhance": false,
  "enableFallback": false
}
```

### Request body — flux-kontext

```json
{
  "prompt": "...",
  "model": "flux-kontext-pro" | "flux-kontext-max",
  "inputImage": "https://...",   // source image URL
  "aspectRatio": "1:1" | "3:2" | "2:3" | "16:9" | "9:16" | "4:5" | "5:4" | "3:4" | "4:3",
  "outputFormat": "jpeg" | "png",
  "promptUpsampling": false
}
```

### Poll response (both endpoints)

```json
{
  "code": 200,
  "data": {
    "taskId": "...",
    "successFlag": 0,          // 0 = generating, 1 = success, 2 = failed
    "progress": "0.50",        // string fraction, only while generating
    "response": { "result_urls": ["https://..."] },
    "errorMessage": null,
    "createTime": "...",
    "completeTime": "..."
  }
}
```

Generated images live for 14 days then expire — we download them to disk immediately.

### File upload (separate domain — required because both endpoints take URLs, not bytes)

- **Base URL:** `https://kieai.redpandaai.co`
- `POST /api/file-base64-upload` — `{ base64, uploadPath, fileName }` (base64 without data: prefix; size cap unknown — fall back to stream upload if it rejects)
- `POST /api/file-stream-upload` — multipart `file=@..., uploadPath, fileName`
- Returns `{ data: { fileUrl, downloadUrl, expiresAt } }` — file lives 24 h, plenty for the task to complete.

### Test connection

No dedicated `/account` endpoint documented. Use a HEAD or a probe submission isn't ideal.
For now: hit `POST /api/v1/gpt4o-image/generate` with an obviously-invalid body and treat
HTTP 400 (validation error) as "key works", 401 as "key bad", anything else as "unknown".
*(Alternative if available: a `/me` or balance endpoint we discover empirically.)*

---

## fal.ai

- **Queue base URL:** `https://queue.fal.run`
- **Auth:** `Authorization: Key <FAL_KEY>` (note: `Key`, not `Bearer`)
- All endpoints async via the queue API.

### Submit

```
POST https://queue.fal.run/<model-id>
Body: { ...model-specific inputs }
```

Response:

```json
{
  "request_id": "uuid-...",
  "response_url": "https://queue.fal.run/<model>/requests/<id>/response",
  "status_url":   "https://queue.fal.run/<model>/requests/<id>/status",
  "cancel_url":   "https://queue.fal.run/<model>/requests/<id>/cancel",
  "queue_position": 0
}
```

Store the `request_id`; status + response are reachable via either the convenience URLs or
the canonical paths `…/requests/<id>/status` and `…/requests/<id>`.

### Poll status

```
GET https://queue.fal.run/<model-id>/requests/<request_id>/status?logs=1
```

Status enum: `IN_QUEUE` | `IN_PROGRESS` | `COMPLETED`. Failure surfaces inside the COMPLETED
status payload as `error` / `error_type` fields.

### Get result

```
GET https://queue.fal.run/<model-id>/requests/<request_id>
```

Common output shape (for image models):

```json
{
  "images": [{ "url": "https://fal.media/...png", "width": 1024, "height": 1024 }],
  "timings": { "inference": 3.42 },
  "seed": 1234
}
```

### Models we expose (image-to-image / edit)

| Display name              | Model id                            | Key inputs                       |
|---------------------------|-------------------------------------|----------------------------------|
| Flux Pro Kontext          | `fal-ai/flux-pro/kontext`           | `prompt`, `image_url`            |
| Flux Schnell (text)       | `fal-ai/flux/schnell`               | `prompt`                         |
| Flux Dev (text)           | `fal-ai/flux/dev`                   | `prompt`                         |
| Nano Banana edit          | `fal-ai/nano-banana/edit`           | `prompt`, `image_urls[]`         |
| Seedream v4 edit          | `fal-ai/seedream/v4/edit`           | `prompt`, `image_urls[]`         |
| Recraft v3 image-to-image | `fal-ai/recraft/v3/image-to-image`  | `prompt`, `image_url`, `strength`|

### File upload to fal.ai

fal SDKs ship a Storage helper, but the REST shape is simply:

```
POST https://rest.alpha.fal.ai/storage/upload
Authorization: Key <FAL_KEY>
multipart: file=@...
→ { url: "https://fal.media/files/..." }
```

We could also use `data:image/png;base64,...` data-URIs inline in the request body for
smaller images — most fal image models accept that. Implementation chooses base64 when
the image is < 4 MB, otherwise uploads.

### Test connection

`GET https://queue.fal.run/fal-ai/flux/schnell/requests/00000000-0000-0000-0000-000000000000/status`
→ 401 if key bad, 404 if key good (request id doesn't exist).
Cleaner: hit `https://rest.alpha.fal.ai/account/me` if exposed.

---

## Cost estimates (per generated image, USD)

Hard-coded ballparks for the confirmation dialog. Refresh from each provider's pricing page periodically.

| Model                            | Approx $/image |
|----------------------------------|---------------:|
| kie:gpt4o-image (4o)             | $0.040         |
| kie:flux-kontext-pro             | $0.035         |
| kie:flux-kontext-max             | $0.055         |
| fal-ai/flux/schnell              | $0.003         |
| fal-ai/flux/dev                  | $0.025         |
| fal-ai/flux-pro/kontext          | $0.040         |
| fal-ai/nano-banana/edit          | $0.035         |
| fal-ai/seedream/v4/edit          | $0.030         |
| fal-ai/recraft/v3/image-to-image | $0.040         |

Stored in `main/ai/costs.js` so they're easy to update in one place.

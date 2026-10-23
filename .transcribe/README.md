# Timelining transcribe service

Dockerised Railway service for YouTube and Telegram voice transcription (yt-dlp + OpenAI Whisper).

Railway builds from this directory (`rootDirectory: .transcribe`). Do not merge with [`.docker/`](../.docker/) (Neo4j).

## Local build

```bash
cd .transcribe
npm install
npm run build
npm start
```

Requires env: `OPENAI_API_KEY`, `PRIVATE_API_TOKEN`, `TIMELINING_BASE_URL`, `TIMELINING_PRIVATE_API_TOKEN`, `TELEGRAM_BOT_TOKEN`.

Optional: `TRANSCRIBE_TMPDIR` (writable temp directory for yt-dlp downloads; defaults to `TMPDIR`, `os.tmpdir()`, or `/tmp`).

Callbacks for both `youtube` (Resource) and `telegram_voice` (Voice) POST to timelining.

## Railway

Create a second service in the timelining repo with `rootDirectory: .transcribe`. Set the env vars above and expose the generated public URL as `TRANSCRIBE_SERVICE_URL` on timelining Vercel.

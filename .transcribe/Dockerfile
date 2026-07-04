FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install typescript && npm run build && npm uninstall typescript

RUN mkdir -p /tmp && chmod 1777 /tmp

# yt-dlp needs `node` on PATH for --js-runtimes node (YouTube EJS extraction).
ENV PATH="/usr/local/bin:${PATH}"
RUN node --version && command -v node && command -v yt-dlp

ENV TMPDIR=/tmp
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]

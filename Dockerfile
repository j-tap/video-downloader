FROM oven/bun:latest

RUN apt update && \
    apt install -y python3 python3-pip ffmpeg curl ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    yt-dlp --version

WORKDIR /app

COPY . .

COPY data/ /app/data/

RUN bun install

EXPOSE 3000

CMD ["bun", "server/index.ts"]

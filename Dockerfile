FROM oven/bun:latest

RUN apt update && \
    apt install -y python3 python3-pip ffmpeg curl tor ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    yt-dlp --version

RUN echo "SOCKSPort 9050" >> /etc/tor/torrc

WORKDIR /app

COPY . .

RUN bun install

EXPOSE 3000

CMD tor & sleep 5 && bun server/index.ts

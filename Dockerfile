FROM oven/bun:latest

RUN apt update && \
    apt install -y python3 python3-pip ffmpeg && \
    pip3 install --break-system-packages yt-dlp

WORKDIR /app

COPY . .

RUN bun install

EXPOSE 3000

CMD ["bun", "server/index.ts"]

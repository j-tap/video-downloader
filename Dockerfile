FROM oven/bun:latest

RUN apt update && \
    apt install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

ENV DENO_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"

RUN pip3 install --break-system-packages --no-cache-dir "yt-dlp[default,curl-cffi]" && \
    yt-dlp --version

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD bun server/index.ts

FROM node:20-slim

# Install Chromium + fonts + utilities + sqlite3
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-core \
    fontconfig \
    ca-certificates \
    curl \
    wget \
    sqlite3 \
    python3 \
    make \
    g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install Google Fonts: Inter + Playfair Display
RUN mkdir -p /usr/share/fonts/google \
    && wget -q -O /usr/share/fonts/google/Inter.ttf "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" \
    && wget -q -O /usr/share/fonts/google/PlayfairDisplay.ttf "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" \
    && wget -q -O /usr/share/fonts/google/PlayfairDisplay-Italic.ttf "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf" \
    && fc-cache -fv

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Remove build tools after native modules are compiled
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY . .

RUN mkdir -p /app/public/images/fratellidirosa /app/data

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

EXPOSE 3100

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

CMD ["node", "server.js"]

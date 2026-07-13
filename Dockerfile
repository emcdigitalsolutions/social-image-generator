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
    ffmpeg \
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

# Chrome for Testing pinnato: il chromium di Debian segue i security update
# e la 150 crasha in container (SIGTRAP all'avvio, 13/7/2026). Il pacchetto
# apt chromium resta installato solo per la chiusura delle librerie condivise.
ENV CFT_VERSION=131.0.6778.264
RUN npx -y @puppeteer/browsers install chrome@${CFT_VERSION} --path /opt/chrome \
    && ln -sf /opt/chrome/chrome/linux-${CFT_VERSION}/chrome-linux64/chrome /usr/local/bin/chrome-cft \
    && /usr/local/bin/chrome-cft --headless --no-sandbox --disable-gpu --dump-dom about:blank > /dev/null

COPY . .

RUN mkdir -p /app/public/images/fratellidirosa /app/data

ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome-cft
ENV NODE_ENV=production

EXPOSE 3100

CMD ["node", "server.js"]

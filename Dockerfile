FROM node:20-slim

# Install Chromium + fonts + utilities
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-core \
    fontconfig \
    ca-certificates \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install Google Fonts: Inter + Playfair Display
RUN mkdir -p /usr/share/fonts/google \
    && wget -q -O /usr/share/fonts/google/Inter.ttf "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" \
    && wget -q -O /usr/share/fonts/google/PlayfairDisplay.ttf "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" \
    && wget -q -O /usr/share/fonts/google/PlayfairDisplay-Italic.ttf "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf" \
    && fc-cache -fv

WORKDIR /app

COPY package.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/public/images/fratellidirosa

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

EXPOSE 3100

CMD ["node", "server.js"]

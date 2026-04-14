FROM node:20-slim

# Install Chromium + fonts
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-core \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install Google Fonts: Inter + Playfair Display
RUN mkdir -p /usr/share/fonts/google \
    && wget -q -O /tmp/inter.zip "https://fonts.google.com/download?family=Inter" \
    && wget -q -O /tmp/playfair.zip "https://fonts.google.com/download?family=Playfair+Display" \
    && unzip -o /tmp/inter.zip -d /usr/share/fonts/google/ \
    && unzip -o /tmp/playfair.zip -d /usr/share/fonts/google/ \
    && rm /tmp/inter.zip /tmp/playfair.zip \
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

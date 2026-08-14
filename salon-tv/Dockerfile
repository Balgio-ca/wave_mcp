FROM node:22-alpine

# adb pour piloter la Fire TV (paquet android-tools d'Alpine).
RUN apk add --no-cache android-tools

WORKDIR /app

# Dépendances d'abord (cache de couche).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Code applicatif.
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8099
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8099
CMD ["node", "src/server.js"]

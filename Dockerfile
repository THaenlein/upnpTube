FROM node:26-alpine

RUN apk add --no-cache yt-dlp git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --allow-git=all

COPY index.js renderer.js ssdp.js ./

ENTRYPOINT [ "node", "index.js" ]

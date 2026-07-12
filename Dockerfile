FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server/ ./server/
COPY public/ ./public/

RUN mkdir -p /data

EXPOSE 8080

ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "server/index.js"]

FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p public/uploads

EXPOSE 8080

CMD ["node", "server/index.js"]

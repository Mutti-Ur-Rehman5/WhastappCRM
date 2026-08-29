FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

# env vars come from .env via docker-compose; never baked into the image.
CMD ["node", "server.js"]

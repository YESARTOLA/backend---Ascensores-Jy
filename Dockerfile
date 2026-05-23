FROM node:20-bookworm

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=America/Lima

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev

COPY . .

EXPOSE 8080

CMD ["npm", "start"]

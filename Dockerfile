FROM node:20-bookworm-slim

# OpenSSL es requerido por Prisma en imágenes slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=America/Lima

# Copiamos primero package*.json + prisma para aprovechar la cache de Docker:
# si solo cambia código de la app (no dependencias ni schema), no se reinstala.
COPY package*.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev

# Resto del código
COPY . .

EXPOSE 8080

# `npm start` ejecuta:
#   prisma migrate deploy   →  aplica migraciones pendientes (idempotente)
#   node index.js           →  arranca el servidor
CMD ["npm", "start"]

# Dockerfile do backend CRM (agente-autonomo-backend)
FROM node:20-alpine

WORKDIR /app

# Deps primeiro pra cache
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# Codigo
COPY index.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Healthcheck simples - o endpoint /health retorna 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"ok":true' || exit 1

CMD ["node", "index.js"]

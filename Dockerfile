FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
# auth/ (WhatsApp session) and data/ (SQLite) must be mounted as volumes.
VOLUME ["/app/auth", "/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]

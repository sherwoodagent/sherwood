FROM node:22-slim

WORKDIR /app

# Install all deps (including devDependencies for build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build
COPY tsup.config.ts tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

ENV PORT=3100
ENV NODE_ENV=production

# XMTP SQLite DB lives on the persistent volume (mounted at /data on Railway)
# RAILWAY_VOLUME_MOUNT_PATH is set automatically by Railway

EXPOSE 3100
CMD ["node", "dist/index.js"]

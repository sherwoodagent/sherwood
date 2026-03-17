FROM node:20-slim

WORKDIR /app

# Install deps
COPY package.json package-lock.json* ./
RUN npm ci --production

# Copy built output
COPY dist/ ./dist/

ENV PORT=3100
ENV NODE_ENV=production

# XMTP SQLite DB lives on the persistent volume (mounted at /data on Railway)
# RAILWAY_VOLUME_MOUNT_PATH is set automatically by Railway

EXPOSE 3100
CMD ["node", "dist/index.js"]

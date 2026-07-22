# Base image pinned by digest for reproducible builds (SEC-D3). Tag = node:20-bookworm-slim.
# glibc (slim) is deliberate: better-sqlite3 installs a prebuilt binary here, so no
# compiler toolchain is needed in the image (Alpine/musl would force a source build).

# Stage 1: Build frontend
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Production
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
WORKDIR /app

# Backend deps — reproducible install from the lockfile.
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Backend source
COPY backend/src/ ./src/

# Built frontend
COPY --from=frontend-build /app/frontend/dist ./public/

# SQLite data dir (WAL); run as the non-root 'node' user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# In a container the app must listen on all interfaces (the container is the boundary);
# under LXC/PM2 it defaults to 127.0.0.1 instead. See backend/src/index.js.
ENV PORT=3000 \
    NODE_ENV=production \
    DB_PATH=/data/database.sqlite \
    HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN npm ci --production=false
RUN npm run build --workspace @mailmind/api

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/api/dist ./dist
COPY apps/api/package*.json ./
RUN npm ci --production
EXPOSE 4000
CMD ["node", "dist/server.js"]
FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages ./packages
RUN npm install

FROM base AS build
COPY . .
RUN npm run build --workspace @mailmind/api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./package.json
EXPOSE 4000
CMD ["node", "dist/index.js"]
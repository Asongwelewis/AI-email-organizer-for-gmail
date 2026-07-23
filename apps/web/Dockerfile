FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY apps/web ./apps/web
COPY packages ./packages
RUN npm ci --production=false
RUN npm run build --workspace @mailmind/web

FROM nginx:stable-alpine
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./
COPY apps/web/package*.json ./apps/web/
COPY packages ./packages
RUN npm install

FROM base AS build
COPY . .
RUN npm run build --workspace @mailmind/web

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
# syntax=docker/dockerfile:1
# Efficient Energy Storage System — telemetry dashboard
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/dashboard/data

# no npm dependencies: only the source is needed
COPY package.json ./
COPY dashboard ./dashboard
COPY bridge ./bridge
COPY docs ./docs

RUN mkdir -p /app/dashboard/data && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/dashboard/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dashboard/server.js"]

FROM node:20-alpine
WORKDIR /app
COPY server.cjs .
COPY traktor-racer.html .
ENV PORT=3000
ENV DATA_DIR=/data
# STATS_KEY should be overridden via an environment variable in Coolify
EXPOSE 3000
CMD ["node", "server.cjs"]

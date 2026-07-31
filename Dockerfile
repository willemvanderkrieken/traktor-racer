FROM nginx:alpine
# Single self-contained static game (all art embedded as base64)
COPY traktor-racer.html /usr/share/nginx/html/index.html
EXPOSE 80

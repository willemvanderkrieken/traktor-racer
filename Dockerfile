FROM nginx:alpine
# Single self-contained static game (all art embedded as base64)
COPY traktor-racer.html /usr/share/nginx/html/index.html
# Coolify routes to port 3000 by default, so make nginx listen on 3000
RUN printf 'server {\n    listen 3000;\n    server_name _;\n    root /usr/share/nginx/html;\n    index index.html;\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 3000

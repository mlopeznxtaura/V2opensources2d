FROM node:20-alpine AS vendor
WORKDIR /build
RUN npm init -y >/dev/null 2>&1 \
 && npm install @tensorflow/tfjs@4.22.0 @tensorflow-models/body-pix@2.2.1 --omit=dev

FROM nginx:alpine
COPY index.html /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY assets /usr/share/nginx/html/assets
COPY --from=vendor /build/node_modules/@tensorflow/tfjs/dist /usr/share/nginx/html/vendor/tfjs
COPY --from=vendor /build/node_modules/@tensorflow-models/body-pix/dist /usr/share/nginx/html/vendor/body-pix
RUN printf 'server {\n  listen 8080;\n  root /usr/share/nginx/html;\n  index index.html;\n  include /etc/nginx/mime.types;\n  default_type application/octet-stream;\n  types { text/html html; text/css css; application/javascript js mjs; }\n  location = /index.html { add_header Cache-Control "no-store, no-cache, must-revalidate"; try_files $uri =404; }\n  location ~* \\.(js|css)$ { add_header Cache-Control "no-store, no-cache, must-revalidate"; try_files $uri =404; }\n  location /assets/ { add_header Cache-Control "public, max-age=3600"; try_files $uri =404; }\n  location /vendor/ { add_header Cache-Control "public, max-age=86400"; try_files $uri =404; }\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 8080

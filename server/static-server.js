/**
 * Static file server for the dashboard.
 * Serves files from ../client directory.
 * Port: 3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(CLIENT_DIR, req.url === '/' ? 'dashboard.html' : req.url);
  filePath = path.normalize(filePath);

  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Static server running on http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/ or http://localhost:${PORT}/dashboard.html`);
});

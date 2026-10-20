const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;

const server = http.createServer((req, res) => {
  let filePath;
  if (req.url === '/privacy' || req.url === '/privacy.html') {
    filePath = path.join(__dirname, 'public', 'privacy.html');
  } else if (req.url === '/terms' || req.url === '/terms.html') {
    filePath = path.join(__dirname, 'public', 'terms.html');
  } else {
    res.writeHead(302, { Location: '/privacy' });
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Legal pages server running on port ${PORT}`);
});

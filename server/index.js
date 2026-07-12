const express = require('express');
const path = require('path');
const createServer = require('./core');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const { app } = createServer(DATA_DIR);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'license.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'panel.html')));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VORTEX running on port ${PORT}`);
    console.log(`Panel: http://localhost:${PORT}/panel`);
    console.log(`License: http://localhost:${PORT}/`);
  });
}

module.exports = app;

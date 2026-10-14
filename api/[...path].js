'use strict';

const { createServer } = require('../src/server');

// Vercel runs this for every /api/* request. The instance is reused between
// requests, so the store is set up once per instance.
let listening;

module.exports = async (req, res) => {
  listening ||= createServer(process.env).then(({ listener }) => listener);
  let listener;
  try {
    listener = await listening;
  } catch (err) {
    listening = null;
    console.error(err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'The server is not configured correctly' }));
  }
  return listener(req, res);
};

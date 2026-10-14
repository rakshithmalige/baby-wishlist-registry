'use strict';

const http = require('node:http');
const { createServer } = require('./server');

const port = Number(process.env.PORT) || 3000;
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');

createServer(process.env)
  .then(async ({ listener, store }) => {
    const { list } = await store.read();
    http.createServer(listener).listen(port, () => {
      console.log(`${process.env.LIST_TITLE || 'Harvey-Malige Baby Registry'} running on port ${port}`);
      console.log(`Share link: ${publicUrl}/l/${list.shareToken}`);
    });
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

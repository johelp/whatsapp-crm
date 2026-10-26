/** online.js — usuarios conectados por socket (lo alimenta server.js) */
let _map = new Map();
module.exports = {
  setMap(m) { _map = m; },
  getOnlineIds() { return new Set([..._map.values()].map(u => u.id)); },
};

const serverConfig = require("./server.config");
const audioConfig = require("./audio.config");

module.exports = {
  ...serverConfig,
  ...audioConfig,
};

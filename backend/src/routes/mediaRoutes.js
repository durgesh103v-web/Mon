const express = require("express");
const { PHOTOS_DIR } = require("../config");

function registerMediaRoutes(app) {
  app.use("/photos", express.static(PHOTOS_DIR));
}

module.exports = {
  registerMediaRoutes,
};

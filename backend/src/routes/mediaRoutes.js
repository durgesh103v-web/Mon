const express = require("express");
const { PHOTOS_DIR, RECORDINGS_DIR } = require("../config");

function registerMediaRoutes(app) {
  app.use("/photos", express.static(PHOTOS_DIR));
  app.use("/recordings", express.static(RECORDINGS_DIR));
}

module.exports = {
  registerMediaRoutes,
};

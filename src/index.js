'use strict';

const { InnovaPlatform } = require('./platform');
const { PLUGIN_NAME, PLATFORM_NAME } = require('./settings');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, InnovaPlatform);
};

/* Copyright 2017 Streampunk Media Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

const redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
const util = require('util');

module.exports = function (RED) {
  function CableIn (config) {
    RED.nodes.createNode(this, config);
    redioactive.Funnel.call(this, config);

    var node = this;
    node.warn(`Unimplemented CableIn node with config: ${JSON.stringify(config, null, 2)}`);

  }
  util.inherits(CableIn, redioactive.Funnel);
  RED.nodes.registerType('cable-in', CableIn);
};

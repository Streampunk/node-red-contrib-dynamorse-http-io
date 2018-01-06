/* Copyright 2018 Streampunk Media Ltd.

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

const { Redioactive } = require('node-red-contrib-dynamorse-core');
const { pullStream, pushStream } = require('../util/ArachnidIn.js');
const util = require('util');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');

const mimeMatch = /^\s*(\w+)\/([\w-]+)/;
const paramMatch = /\b(\w+)=(\S+)\b/g;

module.exports = function (RED) {
  function SpmHTTPIn (config) {
    RED.nodes.createNode(this, config);
    Redioactive.Funnel.call(this, config);

    let protocol = (config.protocol === 'HTTP') ? http : https;
    let node = this;
    config.pullURL = (config.pullURL.endsWith('/')) ?
      config.pullURL.slice(0, -1) : config.pullURL;
    config.path = (config.path.endsWith('/')) ?
      config.path.slice(0, -1) : config.path;
    let baseTime = (d => [ d / 1000|0, (d % 1000) * 1000000 ])(Date.now());
    let endState = { ended : false, endMark : null };
    let highWaterMark = Number.MAX_SAFE_INTEGER + ':0';
    let server = null; // Allow this.close to close down running servers

    function makeFlowAndSource (headers) {
      let contentType = headers['content-type'];
      let mime = contentType.match(mimeMatch);
      let tags = { format : mime[1], encodingName : mime[2] };
      let parameters = contentType.match(paramMatch);
      parameters.forEach(p => {
        var splitP = p.split('=');
        if (splitP[0] === 'rate') splitP[0] = 'clockRate';
        tags[splitP[0]] = +splitP[1];
        if (isNaN(tags[splitP[0]])) tags[splitP[0]] = splitP[1];
        if (splitP[0] === 'interlace') tags[splitP[0]] = (splitP[1] === 'true');
      });
      if (tags.encodingName === 'x-v210') {
        tags.clockRate = 90000;
        tags.encodingName = 'raw';
        tags.packing = 'v210';
      } else if (tags.encodingName === 'raw') {
        tags.clockRate = 90000;
        tags.packing = 'pgroup';
      }
      if (headers['arachnid-packing'] && tags.format === 'video')
        tags.packing = headers['arachnid-packing'];

      if (tags.format === 'audio') {
        switch (tags.encodingName) {
        case 'L16':
          tags.blockAlign = 2 * tags.channels;
          break;
        case 'L24':
          tags.blockAlign = 3 * tags.channels;
          break;
        case 'L20':
          tags.bloclAlign = 5 * tags.channels;
          break;
        default:
          break;
        }
      }

      if (headers['arachnid-grainduration']) {
        let durMatch = headers['arachnid-grainduration'].match(/(\d+)\/(\d+)/);
        tags.grainDuration = [ +durMatch[1], +durMatch[2] ];
      }

      let cable = {};
      cable[tags.format] = [{ tags : tags }];
      cable.backPressure = `${tags.format}[0]`;

      if (headers['arachnid-sourceid'] && (config.regenerate === false))
        cable[tags.format][0].sourceID = headers['arachnid-sourceid'];
      if (headers['arachnid-flowid'] && (config.regenerate === false))
        cable[tags.format][0].flowID = headers['arachnid-flowid'];
      node.makeCable(cable);
      return { flowID: node.flowID(), sourceID: node.sourceID() };
    }

    if (config.mode === 'push') { // push mode
      let app = express();
      let router = express.Router();
      app.use(config.path, router);

      app.use((err, req, res, next) => { // Have to pass in next for express to work
        node.warn(err);
        if (err.status) {
          res.status(err.status).json({
            code: err.status,
            error: (err.message) ? err.message : 'Internal server error. No message available.',
            debug: (err.stack) ? err.stack : 'No stack available.'
          });
        } else {
          res.status(500).json({
            code: 500,
            error: (err.message) ? err.message : 'Internal server error. No message available.',
            debug: (err.stack) ? err.stack : 'No stack available.'
          });
        }
        if (next === false) next();
      });

      app.use((req, res, next) => { // Have to pass in next for express to work
        this.log(`Fell through express. Request ${req.path} is unhandled.`);
        res.status(404).json({
          code : 404,
          error : `Could not find the requested resource '${req.path}'.`,
          debug : req.path
        });
        if (next == false) next();
      });

      let options = (config.protocol === 'HTTP') ? {} : {
        key : fs.readFileSync(__dirname + '/../certs/dynamorse-key.pem'),
        cert : fs.readFileSync(__dirname + '/../certs/dynamorse-cert.pem')
      };
      server = ((config.protocol === 'HTTP') ?
        protocol.createServer(app) : protocol.createServer(options, app))
        .listen(config.port, err => {
          if (err) node.error(`Failed to start arachnid pull ${config.protocol} server: ${err}`);
        });
      server.on('listening', () => {
        node.warn(`Dynamorse arachnid push ${config.protocol} server listening on port ${config.port}.`);
      });
      server.on('error', node.warn);

      pushStream(router, config, endState, node, node.generator,
        makeFlowAndSource, server.close.bind(server));
    } else { // config.mode is set to pull
      let pullGenerator = pullStream(config, node, endState, baseTime,
        highWaterMark, makeFlowAndSource);
      pullGenerator(this.generator);
    }

    this.on('close', () => {
      if (server) {
        server.close(() => {
          node.warn('Closed server on node close.');
        });
      }
      this.close();
    });
  }
  util.inherits(SpmHTTPIn, Redioactive.Funnel);
  RED.nodes.registerType('spm-http-in', SpmHTTPIn);
};

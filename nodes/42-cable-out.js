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

const redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
const util = require('util');
const express = require('express');
const Grain = require('node-red-contrib-dynamorse-core').Grain;
const http = require('http');
const https = require('https');
const fs = require('fs');
const uuid = require('uuid');
const { pullStream, once, nop } = require('../util/ArachnidOut.js');

module.exports = function (RED) {
  function CableOut (config) {
    RED.nodes.createNode(this, config);
    redioactive.Spout.call(this, config);

    const node = this;
    this.on('error', err => {
      node.warn(`Error transporting flow over ${config.protocol} '${config.path}': ${err}`);
    });
    const protocol = (config.protocol === 'HTTP') ? http : https;
    const options = (config.protocol === 'HTTP') ? {} : {
      key : fs.readFileSync(__dirname + '/../certs/dynamorse-key.pem'),
      cert : fs.readFileSync(__dirname + '/../certs/dynamorse-cert.pem')
    };
    config.path = (config.path.endsWith('/')) ? config.path.slice(0, -1) : config.path;
    let server = null;
    let cablePromise = null;
    let streamDetails = null;

    function setupSubs (cable, subs) {
      if (!Array.isArray(cable) || cable.length === 0) return;
      let firstCable = cable[0];
      let streams = new Map;
      ['video', 'audio', 'anc', 'event'].map(type => { // TODO confirm stream names
        if (Array.isArray(firstCable[type])) {
          for ( let x = 0 ; x < firstCable[type].length ; x++ ) {
            let wire = firstCable[type][x];
            let stream = Object.assign({ type: type, index: x }, firstCable[type][x]);
            stream.paths = [ `/${type}_${x}`, `/${stream.flowID}` ];
            if (stream.name) {
              stream.paths.push(`/${stream.name}`);
            }
            stream.router = express.Router();
            subs.use(stream.paths, stream.router);
            stream.grainCache = [];
            stream.ended = false;
            stream.grainCount = 0;
            stream.begin = process.hrtime();

            ({ clearDown: stream.clearDown, startChecks: stream.startChecks } =
              pullStream(stream.router, config, () => stream.grainCache, wire,
                node, () => stream.ended));
            streams.set(wire.flowID, stream);
          }
        }
      });
      return streams;
    }

    this.each((x, next) => {
      if (!Grain.isGrain(x)) {
        node.warn(`Cable out received something that is not a grain: ${x}`);
        return next();
      }

      if (!cablePromise) {
        cablePromise = this.findCable(x).then(cable => {
          if (config.mode === 'pull') {
            let app = express();
            let subs = express.Router();
            app.use(config.path, subs);
            streamDetails = setupSubs(cable, subs);

            subs.get(['/', '/cable.json'], (req, res) => {
              res.json(cable[0]);
            });

            app.use((err, req, res, next) => { // Must have four args, even if next not called
              node.warn(err);
              if (err.status) {
                if (err.status === 405) { res.setHeader('Allow', ''); } // Allow header mandatory for 405, empty allowed
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
              if (next === false) next(); // NOP to pass linting
            });

            app.use((req, res, next) => { // Assuming needs three args, even if next not called
              res.status(404).json({
                code : 404,
                error : `Could not find the requested resource '${req.path}'.`,
                debug : req.path
              });
              if (next === false) next(); // NOP to pass linting
            });

            server = ((config.protocol === 'HTTP') ?
              protocol.createServer(app) : protocol.createServer(options, app))
              .listen(config.port, err => {
                if (err) node.error(`Failed to start arachnid pull ${config.protocol} server: ${err}`);
                node.warn(`Dynamorse arachnid pull ${config.protocol} server listening on port ${config.port}.`);
              });
            server.on('error', node.warn);
          }
          return cable;
        });
      }

      cablePromise = cablePromise.then(() => {
        let stream = streamDetails.get(uuid.unparse(x.flow_id));
        if (!stream) {
          node.warn(`Received grain with flow ID '${uuid.unparse(x.flow_id)}' that has no stream in the cable.`);
          return next();
        }
        stream.grainCache.push({
          grain : x,
          nextFn : (config.backpressure === true) ? once(next) : nop
        });
        node.wsMsg.send({'push_grain': {
          stream: stream.name,
          ts: Grain.prototype.formatTimestamp(x.ptpOrigin)
        }});
        if (stream.grainCache.length > config.cacheSize) {
          stream.grainCache = stream.grainCache.slice(
            stream.grainCache.length - config.cacheSize);
        }
        if (config.backpressure === false) {
          stream.grainCount++;
          let diffTime = process.hrtime(stream.begin);
          let diff = (stream.grainCount * config.timeout) -
              (diffTime[0] * 1000 + diffTime[1] / 1000000|0);
          setTimeout(next, diff);
        }
        stream.startChecks();
      });
    });

    this.done(() => {
      node.log('Closing the app and/or ending the stream!');

      if (server) {
        if (streamDetails) {
          for ( let [,s] of streamDetails) {
            clearInterval(s.clearDown);
            s.clearDown = null;
            s.ended = true;
          }
        }
        setTimeout(() => {
          // console.log('>>> About to close server.');
          server.close(() => {
            node.warn('Closed server.');
          });
        }, 500); // Allow any new requests to get an ended message
      }
    });
  }
  util.inherits(CableOut, redioactive.Spout);
  RED.nodes.registerType('cable-out', CableOut);
};

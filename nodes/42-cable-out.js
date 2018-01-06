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
    var app = null;
    var subs = null;
    var server = null;
    var cablePromise = [];

    function setupSubs (cable) {
      if (!Array.isArray(cable) || cable.length === 0) return;
      var firstCable = cable[0];
      ['video', 'audio', 'anc', 'event'].forEach(type => {
        if (Array.isArray(firstCable[type])) {
          for ( let x = 0 ; x < firstCable[type].length ; x++ ) {
            let stream = firstCable[type][x];
            let paths = [ `/${type}_${x}`, `/${type}_${x}/stream.json`,
              `/${stream.flowID}`, `/${stream.flowID}/stream.json` ];
            if (stream.name) {
              paths.push(`/${stream.name}`);
              paths.push(`/${stream.name}/stream.json`);
            }
            subs.get(paths, (req, res) => {
              res.json(stream);
            });
            // TODO setup sub-resource arachnid streams
          }
        }
      });
    }

    this.each((x, next) => {
      if (!Grain.isGrain(x)) {
        node.warn(`Cable out received something that is not a grain: ${x}`);
        return next();
      }

      if (Array.isArray(cablePromise)) {
        var responses = cablePromise;
        cablePromise = this.findCable(x).then(cable => {
          responses.forEach(res => { res.json(cable); });
          setupSubs(cable);
          return cable;
        }, e => {
          responses.forEach(res => { res.status(500).json({ error: e }); });
          cablePromise = [];
          return next(); // TODO missing a grain out
        });
      }
      // next();
    });

    if (config.mode === 'pull') {
      app = express();
      subs = express.Router();

      app.get([config.path, config.path + '/cable.json'], (req, res) => {
        if (Array.isArray(cablePromise)) {
          cablePromise.push(res);
        } else {
          cablePromise.then(cable => {
            res.json(cable[0]);
          });
        }
      });
      app.use(config.path, subs);

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

    this.done(() => {
      node.log('Closing the app and/or ending the stream!');
      if (server) setTimeout(() => {
        server.close(() => {
          node.warn('Closed server.');
        });
      }, 0);
    });
  }
  util.inherits(CableOut, redioactive.Spout);
  RED.nodes.registerType('cable-out', CableOut);
};

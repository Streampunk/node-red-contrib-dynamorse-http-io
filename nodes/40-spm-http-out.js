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

const { Redioactive, Grain } =
  require('node-red-contrib-dynamorse-core');
const { pullStream, pushStream, nop, once } = require('../util/ArachnidOut.js');
const util = require('util');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

module.exports = function (RED) {
  // let count = 0;
  function SpmHTTPOut (config) {
    RED.nodes.createNode(this, config);
    Redioactive.Spout.call(this, config);
    let node = this;
    let wire = null;
    /* istanbul ignore next */
    this.on('error', err => {
      node.warn(`Error transporting flow over ${config.protocol} '${config.path}': ${err}`);
    });
    let protocol = (config.protocol === 'HTTP') ? http : https;
    let options = (config.protocol === 'HTTP') ? {} : {
      key : fs.readFileSync(__dirname + '/../certs/dynamorse-key.pem'),
      cert : fs.readFileSync(__dirname + '/../certs/dynamorse-cert.pem')
    };
    let grainCache = [];
    /* istanbul ignore next */
    config.path = (config.path.endsWith('/')) ? config.path.slice(0, -1) : config.path;
    let server = null;
    let begin = null;
    let grainCount = 0;
    let ended = false;
    let highWaterMark = { value : '0:0' };
    let clearDown = null;
    /* istanbul ignore next */
    config.pushURL = (config.pushURL.endsWith('/')) ?
      config.pushURL.slice(0, -1) : config.pushURL;
    let fullURL = config.mode === 'push' ?
      new URL(`${config.pushURL}:${config.port}${config.path}`) : '';

    let sendMore = null;
    let sendEnd = null;
    let dnsPromise = null;

    let startChecks = () => {
      /* istanbul ignore if */
      if (config.mode !== 'push') {
        node.warn(`Start checks called before setup and mode is ${config.mode}.`);
      }
    };

    this.each((x, next) => {
      /* istanbul ignore if */
      if (!Grain.isGrain(x)) {
        node.warn(`HTTP out received something that is not a grain: ${x}`);
        return next();
      }
      // debugger;// this.log(`RECD-NEXT ${x}`);
      let nextJob = (wire) ?
        Promise.resolve(x) :
        this.findCable(x).then(cable => {
          let isVideo = Array.isArray(cable[0].video) && cable[0].video.length > 0;
          wire = isVideo ? cable[0].video[0] : cable[0].audio[0];

          if (config.mode === 'pull') {
            let app = express();
            let router = express.Router();
            app.use(config.path, router);
            ({ clearDown, startChecks } =
              pullStream(router, config, () => grainCache, wire, node, () => ended));

            /* istanbul ignore next */
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
              /* istanbul ignore if */
              if (next === false) next(); // NOP to pass linting
            });

            /* istanbul ignore next */
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
                /* istanbul ignore if */
                if (err) node.error(`Failed to start arachnid pull ${config.protocol} server: ${err}`);
                node.warn(`Dynamorse arachnid pull ${config.protocol} server listening on port ${config.port}.`);
              });
            server.on('error', node.warn);
          }
          if (config.mode === 'push') {
            ({ sendMore, sendEnd, dnsPromise } =
              pushStream(config, wire, node, highWaterMark, fullURL));
          }
          begin = process.hrtime();
        });

      nextJob.then(() => {
        grainCache.push({ grain : x,
          nextFn : (config.backpressure === true) ? once(next) : /* istanbul ignore next */ nop });
        // node.wsMsg.send({'push_grain': { ts: Grain.prototype.formatTimestamp(x.ptpOrigin) }});
        if (grainCache.length > config.cacheSize) {
          grainCache = grainCache.slice(grainCache.length - config.cacheSize);
        }
        /* istanbul ignore if */
        if (config.backpressure === false) {
          grainCount++;
          let diffTime = process.hrtime(begin);
          let diff = (grainCount * config.timeout) -
              (diffTime[0] * 1000 + diffTime[1] / 1000000|0);
          setTimeout(next, diff);
        }
        startChecks();

        if (config.mode === 'push') {
          dnsPromise = dnsPromise
            .then(() => sendMore(grainCache))
            .then(gc => { grainCache = gc; return gc; });
        } // End push
      }).catch(err => {
        /* istanbul ignore next */
        this.error(`spm-http-out received error: ${err}`);
      });
    });

    this.done(() => {
      node.log('Closing the app and/or ending the stream!');
      clearInterval(clearDown);
      clearDown = null;
      ended = true;
      if (config.mode === 'push') {
        dnsPromise = dnsPromise.then(() => sendEnd(highWaterMark.value));
      }
      if (server) setTimeout(() => {
        server.close(() => {
          node.warn('Closed server.');
        });
      }, 0);
    });
  }
  util.inherits(SpmHTTPOut, Redioactive.Spout);
  RED.nodes.registerType('spm-http-out', SpmHTTPOut);
};

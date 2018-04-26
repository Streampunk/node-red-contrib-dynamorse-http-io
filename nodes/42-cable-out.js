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
const { URL } = require('url');
const { pullStream, pushStream, once, nop } = require('../util/ArachnidOut.js');

const streamTypes = ['video', 'audio', 'anc', 'event'];

module.exports = function (RED) {
  function CableOut (config) {
    RED.nodes.createNode(this, config);
    redioactive.Spout.call(this, config);

    const node = this;
    /* istanbul ignore next */
    this.on('error', err => {
      node.warn(`Error transporting flow over ${config.protocol} '${config.path}': ${err}`);
    });
    const protocol = (config.protocol === 'HTTP') ? http : https;
    const options = (config.protocol === 'HTTP') ? {} : {
      key : fs.readFileSync(__dirname + '/../certs/dynamorse-key.pem'),
      cert : fs.readFileSync(__dirname + '/../certs/dynamorse-cert.pem')
    };
    /* istanbul ignore next */
    config.path = (config.path.endsWith('/')) ? config.path.slice(0, -1) : config.path;
    let fullURL = new URL(`${config.pushURL}:${config.port}${config.path}/`);
    let server = null;
    let cablePromise = null;
    let streamDetails = null;

    function setupSubs (cable, subs) {
      /* istanbul ignore if */
      if (!Array.isArray(cable) || cable.length === 0) return;
      let firstCable = cable[0];
      let streams = new Map;
      streamTypes.forEach(type => { // TODO confirm stream names
        if (Array.isArray(firstCable[type])) {
          for ( let x = 0 ; x < firstCable[type].length ; x++ ) {
            let wire = firstCable[type][x];
            let stream = Object.assign({ type: type, index: x }, firstCable[type][x]);
            stream.paths = [ `/${type}_${x}`, `/${stream.flowID}` ];
            /* istanbul ignore else */
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

    function setupPushing (cable) {
      /* istanbul ignore if */
      if (!Array.isArray(cable) || cable.length === 0) return;
      let firstCable = cable[0];
      let streams = new Map;
      streamTypes.forEach(type => {
        if (Array.isArray(firstCable[type])) {
          for ( let x = 0 ; x < firstCable[type].length ; x++ ) {
            let wire = Object.assign({}, firstCable[type][x]);
            wire.highWaterMark = { value : '0:0' };
            wire.grainCache = [];
            wire.ended = true;
            ({ sendMore: wire.sendMore, sendEnd: wire.sendEnd,
              dnsPromise: wire.dnsPromise } =
              pushStream(config, wire, node, wire.highWaterMark,
                new URL(wire.flowID, fullURL)));
            streams.set(wire.flowID, wire);
          }
        }
      });
      return streams;
    }

    this.each((x, next) => {
      /* istanbul ignore if */
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
          } else { // push mode
            return new Promise((fulfil, reject) => {
              let cableJSON = Buffer.from(JSON.stringify(cable), 'utf8');
              let putCableRequest = n => {
                /* istanbul ignore next */
                let errorFn = e => {
                  if (n <= 10) {
                    node.warn(`Attempt ${n} to send cable failed. Retrying in ${n *n * 100} ms. ${e}`);
                    return setTimeout(() => { putCableRequest(n+1); }, n * n * 100);
                  } else {
                    reject(`Failed to PUT cable after ${n} retries: ${e}`);
                  }
                };
                let req = protocol.request({
                  rejectUnauthorized: false,
                  hostname: fullURL.hostname,
                  port: fullURL.port,
                  path: `${fullURL.pathname}/cable.json`,
                  method: 'PUT',
                  headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': cableJSON.length
                  }
                }, res => {
                  let message = '';
                  /* istanbul ignore if */
                  if (res.statusCode !== 200) {
                    return node.warn(`PUTing cable description results in an unxpected ${res.statusCode} status: ${message}`);
                  }
                  res.on('error', errorFn);
                  res.setEncoding('utf8');
                  res.on('data', d => { message += d; });
                  res.on('end', () => {
                    streamDetails = setupPushing(cable);
                    fulfil(cable);
                  });
                });
                req.on('error', errorFn);
                req.end(cableJSON);
              };
              putCableRequest(1);
            });
          }
        });
      }

      cablePromise = cablePromise.then(() => {
        let stream = streamDetails.get(uuid.unparse(x.flow_id));
        /* istanbul ignore if */
        if (!stream) {
          node.warn(`Received grain with flow ID '${uuid.unparse(x.flow_id)}' that has no stream in the cable.`);
          return next();
        }
        stream.grainCache.push({
          grain : x,
          nextFn : (config.backpressure === true) ? once(next) : /* istanbul ignore next */ nop
        });
        /* node.wsMsg.send({'push_grain': {
          stream: stream.name,
          ts: Grain.prototype.formatTimestamp(x.ptpOrigin)
        }}); */
        if (stream.grainCache.length > config.cacheSize) {
          stream.grainCache = stream.grainCache.slice(
            stream.grainCache.length - config.cacheSize);
        }
        /* istanbul ignore if */
        if (config.backpressure === false) {
          stream.grainCount++;
          let diffTime = process.hrtime(stream.begin);
          let diff = (stream.grainCount * config.timeout) -
              (diffTime[0] * 1000 + diffTime[1] / 1000000|0);
          setTimeout(next, diff);
        }
        if (config.mode === 'pull') {
          stream.startChecks();
        } else {
          stream.dnsPromise = stream.dnsPromise
            .then(() => {
              // console.log('>>> Calling send more for stream', stream.flowID);
              return stream.sendMore(stream.grainCache); })
            .then(gc => { stream.grainCache = gc; return gc; });
        }
      });
    });

    this.done(() => {
      node.log('Closing the app and/or ending the stream!');

      if (server) { // Pull mode
        /* istanbul ignore else */
        if (streamDetails) {
          for ( let [,s] of streamDetails) {
            clearInterval(s.clearDown);
            s.clearDown = null;
            s.ended = true;
          }
        }
        this.wsMsg.send({ doneness : true });
        setTimeout(() => {
          // console.log('>>> About to close server.');
          server.close(() => {
            node.warn('Closed server.');
          });
        }, 500); // Allow any new requests to get an ended message
      } else {
        for ( let [,s] of streamDetails ) {
          s.ended = true;
          s.dnsPromise.then(() => {
            s.sendEnd(s.highWaterMark.value);
          });
        }
      }
    });
  }
  util.inherits(CableOut, redioactive.Spout);
  RED.nodes.registerType('cable-out', CableOut);
};

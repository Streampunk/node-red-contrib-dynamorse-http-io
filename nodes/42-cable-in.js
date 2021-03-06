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
const util = require('util');
const http = require('http');
const https = require('https');
const lookup = require('util').promisify(require('dns').lookup);
const { URL } = require('url');
const { pullStream, pushStream } = require('../util/ArachnidIn.js');
const express = require('express');
const getBody = require('raw-body');
const fs = require('fs');

const nop = () => {};
const streamTypes = [ 'video', 'audio', 'anc', 'event' ];

/* istanbul ignore next */
var statusError = (status, message) => {
  let e = new Error(message);
  e.status = status;
  return e;
};

module.exports = function (RED) {
  function CableIn (config) {
    RED.nodes.createNode(this, config);
    Redioactive.Funnel.call(this, config);

    let protocol = (config.protocol === 'HTTP') ? http : https;
    let node = this;
    /* istanbul ignore next */
    config.pullURL = (config.pullURL.endsWith('/')) ?
      config.pullURL.slice(0, -1) : config.pullURL;
    /* istanbul ignore next */
    config.path = (config.path.endsWith('/')) ?
      config.path.slice(0, -1) : config.path;
    let baseTime = (d => [ d / 1000|0, (d % 1000) * 1000000 ])(Date.now());
    // let endState = { ended : false, endMark : null };
    let highWaterMark = Number.MAX_SAFE_INTEGER + ':0';
    let fullURL = new URL(`${config.pullURL}:${config.port}${config.path}`);
    let server = null;
    config.headroom = config.parallel - 1;

    if (config.mode === 'push') {
      let app = express();
      let router = express.Router();
      app.use(config.path, router);
      let cable = null;
      let streams = new Map;
      let closedCount = 0;

      let allClosedCheck = (pushEnd, closeCb) => {
        closedCount++;
        if (Array.from(streams.values()).every(s => s.endState.ended === true) &&
          (closedCount == streams.size)) {
          pushEnd();
          setTimeout(() => {
            server.close(closeCb);
          }, 200);
        }
      };

      router.put('/cable.json', (req, res, next) => {
        getBody(req, {
          length: req.headers['content-length'],
          limit: '10mb',
          encoding: true })
          .then(data => {
            cable = JSON.parse(data)[0];
            // console.log('>>>', 'Received cable', cable);
            delete cable.id;
            node.makeCable(cable);
            streamTypes.forEach(type => {
              if (Array.isArray(cable[type])) {
                for ( let y = 0 ; y < cable[type].length ; y++ ) {
                  let cableRouter = express.Router();
                  let wire = Object.assign({}, cable[type][y]);
                  /* istanbul ignore next */
                  wire.gen = () => {
                    node.warn(`Calling push generator for stream ${wire.flowID} before registration.`);
                  };
                  wire.endState = { ended : false, endMark : null };
                  wire.generating = false;
                  wire.generator = fn => {
                    wire.gen = (push, next) => {
                      if (!wire.generating) {
                        wire.generating = true;
                        fn(push, () => {
                          wire.generating = false;
                          next();
                        });
                      }
                    };
                  };
                  wire.paths = [ '/' + wire.flowID, '/' + wire.name, `/${type}_${y}` ];

                  router.use(wire.paths, cableRouter);
                  pushStream(cableRouter, config, wire.endState, node,
                    wire.generator, wire, allClosedCheck);
                  streams.set(wire.flowID, wire);
                }
              }
            });
            config.headroom = config.parallel * streams.size;
            node.generator((push, next) => {
              for ( let [,s] of streams ) {
                s.gen(push, next);
              }
            });
            res.json({});
          })
          .catch(/* istanbul ignore next */ e => {
            next(statusError(400, `Unable to process posted cable.json: ${e}.`));
          });
      });

      /* istanbul ignore next */
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

      /* istanbul ignore next */
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
          /* istanbul ignore if */
          if (err) node.error(`Failed to start arachnid pull ${config.protocol} server: ${err}`);
        });
      server.on('listening', () => {
        node.warn(`Dynamorse arachnid push ${config.protocol} server listening on port ${config.port}.`);
      });
      server.on('error', node.warn);
    } else { // not push module => pull mode
      lookup(fullURL.hostname)
        .then(({address}) => {
          fullURL.hostname = address;
          let getCableRequest = n => new Promise((fulfil, reject) => {
            /* istanbul ignore next */
            let errorFn = e => {
              if (n <= 10) {
                node.warn(`Attempt ${n} to request cable failed. Retrying in ${n *n * 100} ms. ${e}`);
                return setTimeout(() => fulfil(getCableRequest(n+1)), n * n * 100);
              } else {
                reject(e);
              }
            };
            let req = protocol.request({
              rejectUnauthorized: false,
              hostname: fullURL.hostname,
              port: fullURL.port,
              path: `${fullURL.pathname}/cable.json`,
              method: 'GET'
            }, res => {
              let cableBuilder = '';
              res.on('error', errorFn);
              /* istanbul ignore if */
              if (res.statusCode !== 200) {
                return reject(new Error(`Unecpected response of ${res.statusCode} to cable request ${fullURL.toString()}.`));
              }
              res.on('data', d => {
                cableBuilder += d.toString('utf8');
              });
              res.on('end', () => {
                let cable = JSON.parse(cableBuilder);
                /* istanbul ignore if */
                if (typeof cable !== 'object' || typeof cable.backPressure !== 'string') {
                  return reject(new Error('Received a result that does not look like a cable.'));
                }
                // console.log(JSON.stringify(cable, null, 2));
                fulfil(cable);
              });
            });
            req.on('error', errorFn);
            req.end();
          });
          return getCableRequest(1);
        })
        .then(firstCable => {
          let generators = [];
          delete firstCable.id;
          node.makeCable(firstCable);
          streamTypes.forEach(type => {
            if (!firstCable[type]) return;
            for ( let x = 0 ; x < firstCable[type].length ; x++ ) {
              let wire = firstCable[type][x];
              let streamEnded = { ended : false };
              let pullGenerator = pullStream(config, node, streamEnded, baseTime,
                highWaterMark, wire);
              generators.push(pullGenerator(nop).then(streamGenerator => {
                return { streamGenerator, streamEnded };
              }));
            }
          });
          config.headroom = config.parallel * generators.length;
          return Promise.all(generators);
        })
        .then(generators => {
          let endings = generators.map(({ streamEnded }) => streamEnded );
          let multiPush = push => (err, x) => {
            // console.log('>>>', endings);
            if (Redioactive.isEnd(x)) {
              /* istanbul ignore else */
              if (endings.every(y => y.ended)) {
                push(null, Redioactive.end);
              }
            } else {
              push(err, x);
            }
          };
          node.generator((push, next) => {
            generators.forEach(({streamGenerator: g}) => {
              g(multiPush(push), next); });
          });
        })
        .catch(/* istanbul ignore next */ e => {
          node.warn(`cable-in promise rejection: ${e}`);
        });
    } // end this is pull mode

    /* istanbul ignore next */
    this.on('close', () => {
      if (server) {
        server.close(() => {
          node.warn('Closed server on node close.');
        });
      }
    });
  }

  util.inherits(CableIn, Redioactive.Funnel);
  RED.nodes.registerType('cable-in', CableIn);
};

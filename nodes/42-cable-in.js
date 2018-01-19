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
const url = require('url');
const { pullStream } = require('../util/ArachnidIn.js');

const nop = () => {};

module.exports = function (RED) {
  function CableIn (config) {
    RED.nodes.createNode(this, config);
    Redioactive.Funnel.call(this, config);

    let protocol = (config.protocol === 'HTTP') ? http : https;
    let node = this;
    config.pullURL = (config.pullURL.endsWith('/')) ?
      config.pullURL.slice(0, -1) : config.pullURL;
    config.path = (config.path.endsWith('/')) ?
      config.path.slice(0, -1) : config.path;
    let baseTime = (d => [ d / 1000|0, (d % 1000) * 1000000 ])(Date.now());
    // let endState = { ended : false, endMark : null };
    let highWaterMark = Number.MAX_SAFE_INTEGER + ':0';
    let fullURL = url.parse(`${config.pullURL}:${config.port}${config.path}`);
    let server = null;

    if (config.mode === 'push') {
      // TODO
    } else { // not push module => pull mode
      lookup(fullURL.hostname)
        .then(({address}) => {
          fullURL.hostname = address;
          let getCableRequest = n => new Promise((fulfil, reject) => {
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
              path: `${fullURL.path}/cable.json`,
              method: 'GET'
            }, res => {
              let cableBuilder = '';
              res.on('error', errorFn);
              if (res.statusCode !== 200) {
                return reject(new Error(`Unecpected response of ${res.statusCode} to cable request ${fullURL}.`));
              }
              res.on('data', d => {
                cableBuilder += d.toString('utf8');
              });
              res.on('end', () => {
                let cable = JSON.parse(cableBuilder);
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
          [ 'video', 'audio', 'anc', 'event' ].forEach(type => {
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
          return Promise.all(generators);
        })
        .then(generators => {
          let endings = generators.map(({ streamEnded }) => streamEnded );
          let multiPush = push => (err, x) => {
            // console.log('>>>', endings);
            if (Redioactive.isEnd(x)) {
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
        .catch(e => {
          node.warn(`cable-in promise rejection: ${e}`);
        });
    } // end this is pull mode

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

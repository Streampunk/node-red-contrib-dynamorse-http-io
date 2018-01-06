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

const { Redioactive, Grain, PTPMaths : { compareVersions } } =
  require('node-red-contrib-dynamorse-core');
const { pullStream } = require('../util/ArachnidIn.js');
const util = require('util');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');

const minBufferSize = 10000;

var statusError = (status, message) => {
  var e = new Error(message);
  e.status = status;
  return e;
};

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
    let sourceID = null;
    let flowID = null;
    let tags = {};
    const totalConcurrent = +config.parallel;
    let endState = { ended : false, endMark : null };
    let highWaterMark = Number.MAX_SAFE_INTEGER + ':0';

    function makeFlowAndSource (headers) {
      let contentType = headers['content-type'];
      let mime = contentType.match(mimeMatch);
      tags = { format : mime[1], encodingName : mime[2] };
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
      flowID = node.flowID();
      sourceID = node.sourceID();
      return { flowID, sourceID };
    }

    const buffers = [];
    const bufferIdx = [];
    for ( let x = 0 ; x < totalConcurrent ; x++) {
      let threadBufs = [];
      for ( let y = 0 ; y < config.maxBuffer ; y++ ) {
        threadBufs.push(Buffer.alloc(minBufferSize));
      }
      buffers.push(threadBufs);
      bufferIdx.push(0);
    }

    if (config.mode === 'push') { // push mode
      this.receiveQueue = {};
      this.lowWaterMark = null;
      endState.endMark = null;
      var resolver = null;
      var flowPromise = new Promise(f => { resolver = f; });
      var started = false;
      var app = express();
      var bufferLoop = 0;
      var count = 0;

      app.put(config.path + '/:ts', (req, res, next) => {
        this.log(`Received request ${req.path}.`);
        if (Object.keys(this.receiveQueue).length >= config.cacheSize) {
          return next(statusError(429, `Receive queue is at its limit of ${config.cacheSize} elements.`));
        }
        if (Object.keys(this.receiveQueue).indexOf(req.params.ts) >=0) {
          return next(statusError(409, `Receive queue already contains timestamp ${req.params.ts}.`));
        }
        if (this.lowWaterMark && compareVersions(req.params.ts, this.lowWaterMark) < 0) {
          return next(statusError(400, `Attempt to send grain with timestamp ${req.params.ts} that is prior to the low water mark of ${this.lowWaterMark}.`));
        }
        let idx = [bufferLoop / buffers.length|0, bufferLoop++ % buffers.length];
        this.receiveQueue[req.params.ts] = {
          req: req,
          res: res,
          idx: idx,
          buf: buffers[idx[0], idx[1]]
        };
        if (started === false) {
          resolver(Promise.resolve(makeFlowAndSource(req.headers)));
          started = true;
        } else {
          if (resolver) {
            resolver();
          } else {
            node.warn('No resolver to call.');
          }
        }
        resolver = null;
      });

      app.put(config.path + '/:hwm/end', (req, res) => {
        node.warn(`End received with remote high water mark ${req.params.hwm} and current low water mark ${this.lowWaterMark}.`);
        endState.ended = true;
        endState.endMark = req.params.hwm;
        node.wsMsg.send({'end_received': { hwm: endState.endMark }});
        if (resolver) resolver();
        resolver = null;
        res.json({
          message: 'end_received',
          timestamp: req.params.hwm
        });
      });

      this.generator((push, next) => {
        count++;
        flowPromise = flowPromise.then(() => {
          var sortedKeys = Object.keys(this.receiveQueue)
            .sort(compareVersions);
          var numberToSend = (endState.ended) ? 1 :
            sortedKeys.length - totalConcurrent + 1;
          if (endState.ended && sortedKeys.length === 0) {
            push(null, Redioactive.end);
            return server.close(() => {
              node.warn('Closed server.');
            });
          }
          node.log(`numberToSend: ${numberToSend} with parallel: ${totalConcurrent}.`);
          sortedKeys.slice(0, (numberToSend >= 0) ? numberToSend : 0)
            .forEach(gts => {
              var req = this.receiveQueue[gts].req;
              var res = this.receiveQueue[gts].res;
              var buf = this.receiveQueue[gts].buf;
              var idx = this.receiveQueue[gts].idx;
              delete this.receiveQueue[gts];
              if (this.lowWaterMark && compareVersions(req.params.ts, this.lowWaterMark) < 0) {
                next();
                node.warn(`Later attempt to send grain with timestamp ${req.params.ts} that is prior to the low water mark of ${this.lowWaterMark}.`);
                return res.status(400).json({
                  code: 400,
                  error: `Later attempt to send grain with timestamp ${req.params.ts} that is prior to the low water mark of ${this.lowWaterMark}.`,
                  debug: 'No stack available.'
                });
              }
              var position = 0;
              let contentLength = +req.headers['content-length'];
              if (!isNaN(contentLength) && buf.length < contentLength) {
                node.log(`Extending buffer ${idx} from ${buf.length} bytes to ${contentLength} bytes.`);
                buf = Buffer.alloc(contentLength);
                buffers[idx[0], idx[1]] = buf;
              }
              req.on('data', data => {
                position += data.copy(buf, position);
              });
              res.on('error', node.warn);
              req.on('end', () => {
                let ptpOrigin = req.headers['arachnid-ptporigin'];
                let ptpSync = req.headers['arachnid-ptpsync'];
                let duration = req.headers['arachnid-grainduration'];
                // TODO fix up regeneration
                let gFlowID = flowID; //(config.regenerate) ? flowID : res.headers['arachnid-flowid'];
                let gSourceID = sourceID; // (config.regenerate) ? sourceID : res.headers['arachnid-sourceid'];
                let tc = req.headers['arachnid-timecode'];
                let g = new Grain([ buf.slice(0, position) ], ptpSync, ptpOrigin,
                  tc, gFlowID, gSourceID, duration); // regenerate time as emitted
                push(null, g);
                this.lowWaterMark = gts;

                if (endState.ended) {
                  if (resolver) resolver();
                  resolver = null;
                }

                res.json({
                  message: 'grain_recieved',
                  timestamp: req.headers['arachnid-ptporigin'],
                  bodyLength : position,
                  receiveQueueLength : Object.keys(this.receiveQueue).length
                });
                next();
              });
            });
          if (count < totalConcurrent) next();
          if (resolver === null) {
            return new Promise(f => { resolver = f; });
          } else {
            return resolver(new Promise(f => { resolver = f; }));
          }
        }); // .then(() => { console.log('>>>', JSON.stringify(resolver)); });
      });

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

      var options = (config.protocol === 'HTTP') ? {} : {
        key : fs.readFileSync(__dirname + '/../certs/dynamorse-key.pem'),
        cert : fs.readFileSync(__dirname + '/../certs/dynamorse-cert.pem')
      };
      var server = ((config.protocol === 'HTTP') ?
        protocol.createServer(app) : protocol.createServer(options, app))
        .listen(config.port, err => {
          if (err) node.error(`Failed to start arachnid pull ${config.protocol} server: ${err}`);
        });
      server.on('listening', () => {
        node.warn(`Dynamorse arachnid push ${config.protocol} server listening on port ${config.port}.`);
      });
      server.on('error', node.warn);
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

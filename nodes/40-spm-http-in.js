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
const express = require('express');
// var bodyParser = require('body-parser');
const http = require('http');
const https = require('https');
const fs = require('fs');
const Grain = require('node-red-contrib-dynamorse-core').Grain;
const dns = require('dns');
const url = require('url');

// Maximum drift between high water mark and next request in ms
// TODO calculate this from grain rate
var maxDrift = 40 * 8;
const nineZeros = '000000000';
const minBufferSize = 10000;

var statusError = (status, message) => {
  var e = new Error(message);
  e.status = status;
  return e;
};

function extractVersions(v) {
  var m = v.match(/^([0-9]+):([0-9]+)$/);
  if (m === null) { return [Number.MAX_SAFE_INTEGER, 0]; }
  return [+m[1], +m[2]];
}

function compareVersions(l, r) {
  var lm = extractVersions(l);
  var rm = extractVersions(r);
  if (lm[0] < rm[0]) return -1;
  if (lm[0] > rm[0]) return 1;
  if (lm[1] < rm[1]) return -1;
  if (lm[1] > rm[1]) return 1;
  return 0;
}

function versionToMs (v) {
  var e = extractVersions(v);
  if (e[0] === Number.MAX_SAFE_INTEGER) return e[0];
  return (e[0] * 1000) + (e[1] / 1000000|0);
}

function versionDiffMs (smaller, bigger) {
  var smMs = versionToMs(smaller);
  var bgMs = versionToMs(bigger);
  if (smMs === Number.MAX_SAFE_INTEGER || bgMs === Number.MAX_SAFE_INTEGER) return 0;
  return bgMs - smMs;
}

const mimeMatch = /^\s*(\w+)\/([\w-]+)/;
const paramMatch = /\b(\w+)=(\S+)\b/g;

module.exports = function (RED) {
  function SpmHTTPIn (config) {
    RED.nodes.createNode(this, config);
    redioactive.Funnel.call(this, config);

    var protocol = (config.protocol === 'HTTP') ? http : https;
    var node = this;
    config.pullURL = (config.pullURL.endsWith('/')) ?
      config.pullURL.slice(0, -1) : config.pullURL;
    config.path = (config.path.endsWith('/')) ?
      config.path.slice(0, -1) : config.path;
    var fullPath = `${config.pullURL}:${config.port}${config.path}`;
    var fullURL = url.parse(fullPath);
    var clientID = 'cid' + Date.now();
    this.baseTime = [ Date.now() / 1000|0, (Date.now() % 1000) * 1000000 ];
    var sourceID = null;
    var flowID = null;
    var flows = null;
    var tags = {};
    var totalConcurrent = +config.parallel;
    var ended = false;

    function makeFlowAndSource (headers) {
      var contentType = headers['content-type'];
      var mime = contentType.match(mimeMatch);
      tags = { format : mime[1], encodingName : mime[2] };
      var parameters = contentType.match(paramMatch);
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
      if (headers['arachnid-packing'])
        tags.packing = headers['arachnid-packing'];

      let cable = {};
      cable[tags.format] = [{ tags : tags }];
      cable.backPressure = `${tags.format}[0]`;

      if (headers['arachnid-grainduration']) {
        let durMatch = headers['arachnid-grainduration'].match(/(\d+)\/(\d+)/);
        tags.grainDuration = [ +durMatch[1], +durMatch[2] ];
      }

      if (headers['arachnid-sourceid'] && (config.regenerate === false))
        cable[tags.format][0].sourceID = headers['arachnid-sourceid'];
      if (headers['arachnid-flowid'] && (config.regenerate === false))
        cable[tags.format][0].flowID = headers['arachnid-flowid'];
      flows = node.makeCable(cable);
      flowID = node.flowID();
      sourceID = node.sourceID();
      return Promise.resolve(); // Used for push mode so generator runs in order
    }

    const buffers = [];
    const bufferIdx = [];
    for ( let x = 0 ; x < config.parallel ; x++) {
      let threadBufs = [];
      for ( let y = 0 ; y < config.maxBuffer ; y++ ) {
        threadBufs.push(Buffer.alloc(minBufferSize));
      }
      buffers.push(threadBufs);
      bufferIdx.push(0);
    }

    var keepAliveAgent = new protocol.Agent({keepAlive : true });
    var endCount = 0;
    var endTimeout = null;
    var runNext = (x, push, next) => {
      var requestTimer = process.hrtime();
      // this.log(`Thread ${x}: Requesting ${fullURL.path}/${nextRequest[x]}`);
      var req = protocol.request({
        rejectUnauthorized: false,
        hostname: fullURL.hostname,
        port: fullURL.port,
        path: `${fullURL.path}/${nextRequest[x]}`,
        method: 'GET',
        agent: keepAliveAgent,
        headers: {
          'Arachnid-ClientID': clientID
        }},
      res => {
        // console.log('Response received after', process.hrtime(requestTimer));
        // var count = 0;
        var position = 0;
        var currentIdx = bufferIdx[x] % buffers[x].length;
        var currentBuf = buffers[x][currentIdx];
        // console.log('>>>', x, buffers[0].map(x => x.length));
        if (res.statusCode === 302) {
          var location = res.headers['location'];
          node.log(`Being redirected to ${location}.`);
          location = '/' + location;
          var lm = location.match(/.*\/([0-9]+):([0-9]{9})$/);
          if (lm && lm.length >= 3) {
            nextRequest[x] = `${lm[1]}:${lm[2]}`;
            return setImmediate(() => { runNext(x, push, next); });
          } else {
            node.warn(`Received redirect to unrecognisable location ${location.slice(1)}. Retrying.`);
            setTimeout(() => {
              runNext(x, push, next);
            }, 5);
            return;
          }
        }
        if (res.statusCode === 404) {
          node.warn(`Received not found in thread ${x}, request ${config.path}/${nextRequest[x]} - may be ahead of the game. Retrying.`);
          setTimeout(() => {
            runNext(x, push, next);
          }, 5);
          return;
        }
        if (res.statusCode === 410) {
          node.warn(`BANG! Cache miss when reading end ${config.path}/${nextRequest[x]} on thread ${x}.`);
          // push(`Request for grain ${config.path}/${nextRequest[x]} that has already gone on thread ${x}. Resetting.`);
          nextRequest =
            [ '-5', '-4', '-3', '-2', '-1', '0' ].slice(-config.parallel);
          activeThreads[x] = false;
          clientID = 'cid' + Date.now();
          return next();
        }
        if (res.statusCode === 405) {
          node.log(`Source stream has ended - thread ${x}.`);
          endTimeout = (endTimeout) ? endTimeout :
            setTimeout(() => {
              node.log('Pushing redioactive.end.');
              push(null, redioactive.end);
            }, 1000);
          activeThreads[x] = false;
          ended = true;
          return;
        }
        if (res.statusCode === 200) {
          let contentLength = +res.headers['content-length'];
          if (currentBuf.length < contentLength) {
            node.log(`Extending buffer ${currentIdx} for thread ${x} from ${currentBuf.length} bytes to ${contentLength} bytes.`);
            currentBuf = Buffer.alloc(contentLength);
            buffers[x][currentIdx] = currentBuf;
          }
          nextRequest[x] = res.headers['arachnid-ptporigin'];
          if (!flows) { makeFlowAndSource(res.headers); }
          res.on('data', data => {
            position += data.copy(currentBuf, position);
            // count++;
            // console.log(`Data received for ${count} at`, process.hrtime(requestTimer));
          });
          res.on('end', () => {
            let ptpOrigin = res.headers['arachnid-ptporigin'];
            let ptpSync = res.headers['arachnid-ptpsync'];
            let duration = res.headers['arachnid-grainduration'];
            // TODO fix up regeneration
            let gFlowID = flowID; //(config.regenerate) ? flowID : res.headers['arachnid-flowid'];
            let gSourceID = sourceID; // (config.regenerate) ? sourceID : res.headers['arachnid-sourceid'];
            let tc = res.headers['arachnid-timecode'];
            let g = new Grain([ currentBuf.slice(0, position) ], ptpSync,
              ptpOrigin, tc, gFlowID, gSourceID, duration); // regenerate time as emitted

            let durArray = g.getDuration();
            let originArray = g.getOriginTimestamp();
            originArray [1] = originArray[1] +
              (totalConcurrent * durArray[0] * 1000000000 / durArray[1]|0);
            if (originArray[1] >= 1000000000)
              originArray[0] = originArray[0] + (originArray[1] / 1000000000|0);
            let nanos = (originArray[1]%1000000000).toString();
            nextRequest[x] = `${originArray[0]}:${nineZeros.slice(nanos.length)}${nanos}`;

            pushGrains(g, push);
            activeThreads[x] = false;
            bufferIdx[x]++;
            console.log(`Thread ${x}: Retrieved ${res.headers['arachnid-ptporigin']} in ${process.hrtime(requestTimer)[1] / 1000000} ms`);
            next();
          });
        }
        res.on('error', e => {
          node.warn(`Received error during streaming of get response on thread ${x}: ${e}.`);
          push(`Received error during streaming of get response on thread ${x}: ${e}.`);
          activeThreads[x] = false;
          next();
        });
      });
      req.on('error', e => {
        // Check for flow !== null is so that shutdown does not happen too early
        if (flows !== null && e.message.indexOf('ECONNREFUSED') >= 0) {
          node.log(`Received connection refused on thread ${x}. Assuming end.`);
          activeThreads[x] = true; // Don't make another request.
          endCount++;
          if (endCount === activeThreads.length) {
            push(null, redioactive.end);
          }
          return;
        }
        node.warn(`Received error when requesting frame from server on thread ${x}: ${e}`);
        push(`Received error when requesting frame from server on thread ${x}: ${e}`);
        activeThreads[x] = false;
        next();
      });
      req.end();
      requestTimer = process.hrtime();
    };

    var grainQueue = { };
    var highWaterMark = Number.MAX_SAFE_INTEGER + ':0';
    // Push every grain older than what is in nextRequest, send grains in order
    var pushGrains = (g, push) => {
      grainQueue[g.formatTimestamp(g.ptpOrigin)] = g;
      // console.log('QQQ', nextRequest, 'hwm', highWaterMark);
      var nextMin = nextRequest.reduce((a, b) =>
        compareVersions(a, b) <= 0 ? a : b);
      // console.log('nextMin', nextMin, 'grainQueue', Object.keys(grainQueue));

      Object.keys(grainQueue).filter(gts => compareVersions(gts, nextMin) <= 0)
        .sort(compareVersions)
        .forEach(gts => {
          if (!config.regenerate) {
            // console.log('>>> PUSHING', config.regenerate);
            push(null, grainQueue[gts]);
          } else {
            var g = grainQueue[gts];
            var grainTime = Buffer.allocUnsafe(10);
            grainTime.writeUIntBE(this.baseTime[0], 0, 6);
            grainTime.writeUInt32BE(this.baseTime[1], 6);
            var grainDuration = g.getDuration();
            this.baseTime[1] = ( this.baseTime[1] +
              grainDuration[0] * 1000000000 / grainDuration[1]|0 );
            this.baseTime = [ this.baseTime[0] + this.baseTime[1] / 1000000000|0,
              this.baseTime[1] % 1000000000];
            push(null, new Grain(g.buffers, grainTime, g.ptpOrigin, g.timecode,
              flowID, sourceID, g.duration));
          }
          delete grainQueue[gts];
          highWaterMark = gts;
        });
      if (ended && activeThreads.every(a => a === false)) {
        push(null, redioactive.end);
      }
    };

    var activeThreads =
      [ false, false, false, false, false, false].slice(0, config.parallel);
    var nextRequest =
      [ '-5', '-4', '-3', '-2', '-1', '0' ].slice(-config.parallel);

    if (config.mode === 'push') { // push mode
      this.receiveQueue = {};
      this.lowWaterMark = null;
      var resolver = null;
      var flowPromise = new Promise(f => { resolver = f; });
      var started = false;
      var app = express();
      var bufferLoop = 0;
      //app.use(bodyParser.raw({ limit : config.payloadLimit || 6000000 }));

      app.put(config.path + '/:ts', (req, res, next) => {
        // this.log(`Received request ${req.path}.`);
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
          resolver(makeFlowAndSource(req.headers));
          started = true;
        } else {
          if (resolver) resolver();
        }
        resolver = null;
      });

      this.generator((push, next) => {
        flowPromise = flowPromise.then(() => {
          // this.log('Calling generator.');
          var sortedKeys = Object.keys(this.receiveQueue)
            .sort(compareVersions);
          var numberToSend = sortedKeys.length - config.parallel + 1;
          sortedKeys.slice(0, (numberToSend >= 0) ? numberToSend : 0)
            .forEach(gts => {
              var req = this.receiveQueue[gts].req;
              var res = this.receiveQueue[gts].res;
              var buf = this.receiceQueue[gts].buf;
              var idx = this.receiveQueue[gts].idx;
              delete this.receiveQueue[gts];
              if (this.lowWaterMark && compareVersions(req.params.ts, this.lowWaterMark) < 0) {
                next();
                this.warn(`Later attempt to send grain with timestamp ${req.params.ts} that is prior to the low water mark of ${this.lowWaterMark}.`);
                return res.status(400).json({
                  code: 400,
                  error: `Later attempt to send grain with timestamp ${req.params.ts} that is prior to the low water mark of ${this.lowWaterMark}.`,
                  debug: 'No stack available.'
                });
              }
              var position = 0;
              let contentLength = req.headers['content-length'];
              if (buf.length < contentLength) {
                node.log(`Extending buffer ${idx} from ${buf.length} bytes to ${contentLength} bytes.`);
                buf = Buffer.alloc(contentLength);
                buffers[idx[0], idx[1]] = buf;
              }
              req.on('data', data => {
                position += data.copy(buf, position);
              });
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

                res.json({
                  bodyLength : position,
                  receiveQueueLength : Object.keys(this.receiveQueue).length
                });
                // this.log('Calling next.');
                next();
              });
            });
          if (resolver === null)
            return new Promise(f => { resolver = f; });
          else
            return resolver(new Promise(f => { resolver = f; }));
        });
      });

      app.use((err, req, res, next) => { // Have to pass in next for express to work
        this.warn(err);
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
        this.log(`Dynamorse arachnid push ${config.protocol} server listening on port ${config.port}.`);
      });
      server.on('error', this.warn);
    } else { // config.mode is set to pull
      dns.lookup(fullURL.hostname, (err, addr/*, family*/) => {
        if (err) return this.preFlightError(`Unable to resolve DNS for ${fullURL.hostname}: ${err}`);
        node.log(`Resolved URL hostname ${fullURL.hostname} to ${addr}.`);
        fullURL.hostname = addr;
        this.generator((push, next) => {
          if (ended === false) {
            setImmediate(() => { // Converted from a setTimeout - not required with calbes?
              console.log('+++ DEBUG THREADS', activeThreads);
              for ( let i = 0 ; i < activeThreads.length ; i++ ) {
                let drift = versionDiffMs(highWaterMark, nextRequest[i]);
                if (!activeThreads[i]) {
                  if (drift < maxDrift) {
                    runNext.call(this, i, push, next);
                    activeThreads[i] = true;
                  } else {
                    node.warn(`Not progressing thread ${i} this time due to a drift of ${drift}.`);
                  }
                }
              }
            }, 0);// (flows === null) ? 1000 : 0);
          } else {
            this.log('Not responding to generator.');
          }
        });
      });
    }
  }
  util.inherits(SpmHTTPIn, redioactive.Funnel);
  RED.nodes.registerType('spm-http-in', SpmHTTPIn);
};

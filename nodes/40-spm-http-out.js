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

const { Redioactive, Grain, PTPMaths : { compareVersions } } =
  require('node-red-contrib-dynamorse-core');
const { pullStream } = require('../util/ArachnidOut.js');
const util = require('util');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const uuid = require('uuid');
const dns = require('dns');
const url = require('url');

const nop = () => {};

function reorderCache(c) {
  var co = {};
  var r = [];
  c.forEach(x => {
    co[Grain.prototype.formatTimestamp(x.grain.ptpOrigin)] = x; });
  Object.keys(co).sort(compareVersions).forEach(x => { r.push(co[x]); });
  return r;
}

function clearCacheBefore(c, t) {
  var s = c;
  while (s.length > 0 && compareVersions(
    Grain.prototype.formatTimestamp(s[0].grain.ptpOrigin), t) < 0) {
    s = s.slice(1);
  }
  return s;
}

function once (fn, context) {
  var result;
  var cacheFn = fn;
  var o = () => {
    if (fn) {
      result = fn.apply(context || this, arguments);
      fn = null;
    }
    return result;
  };
  o.reset = () => { fn = cacheFn; };
  return o;
}

module.exports = function (RED) {
  // var count = 0;
  function SpmHTTPOut (config) {
    RED.nodes.createNode(this, config);
    Redioactive.Spout.call(this, config);
    let node = this;
    let wire = null;
    this.on('error', err => {
      node.warn(`Error transporting flow over ${config.protocol} '${config.path}': ${err}`);
    });
    let protocol = (config.protocol === 'HTTP') ? http : https;
    let options = (config.protocol === 'HTTP') ? {} : {
      key : fs.readFileSync(__dirname + '/../certs/dynamorse-key.pem'),
      cert : fs.readFileSync(__dirname + '/../certs/dynamorse-cert.pem')
    };
    let grainCache = [];
    config.path = (config.path.endsWith('/')) ? config.path.slice(0, -1) : config.path;
    let contentType = 'application/octet-stream';
    let packing = 'raw';
    let app = null;
    let server = null;
    let begin = null;
    let grainCount = 0;
    let ended = false;
    let activeThreads = 0;
    let highWaterMark = { value : '0:0' };
    let clearDown = null;
    config.pushURL = (config.pushURL.endsWith('/')) ?
      config.pushURL.slice(0, -1) : config.pushURL;
    let fullPath = `${config.pushURL}:${config.port}${config.path}`;
    let fullURL = url.parse(fullPath);
    let keepAliveAgent = new protocol.Agent({keepAlive : true });
    let dnsPromise = (config.mode === 'pull') ? null : new Promise((resolve, reject) => {
      dns.lookup(fullURL.hostname, (err, addr/*, family*/) => {
        if (err) return reject(err);
        fullURL.hostname = addr;
        node.wsMsg.send({'resolved': { addr: addr }});
        resolve(addr);
      });
    });

    let startChecks = () => {
      node.warn('Start checks called before setup.');
    };

    this.each((x, next) => {
      if (!Grain.isGrain(x)) {
        node.warn(`HTTP out received something that is not a grain: ${x}`);
        return next();
      }
      // debugger;// this.log(`RECD-NEXT ${x}`);
      var nextJob = (wire) ?
        Promise.resolve(x) :
        this.findCable(x).then(cable => {
          let isVideo = Array.isArray(cable[0].video) && cable[0].video.length > 0;
          wire = isVideo ? cable[0].video[0] : cable[0].audio[0];
          let srcTags = wire.tags;

          let encodingName = srcTags.encodingName;
          if (srcTags.packing && srcTags.packing.toLowerCase() === 'v210') encodingName = 'x-v210';
          if (srcTags.format === 'video' &&
              (encodingName === 'raw' || encodingName === 'x-v210' || encodingName === 'h264' )) {
            contentType = `video/${encodingName}; sampling=${srcTags.sampling}; ` +
             `width=${srcTags.width}; height=${srcTags.height}; depth=${srcTags.depth}; ` +
             `colorimetry=${srcTags.colorimetry}; interlace=${srcTags.interlace}`;
          } else {
            contentType = `${srcTags.format}/${srcTags.encodingName}`;
            if (srcTags.clockRate) contentType += `; rate=${srcTags.clockRate}`;
            if (srcTags.channels) contentType += `; channels=${srcTags.channels}`;
          }
          packing = (srcTags.packing) ? srcTags.packing : 'raw';
          node.log(`content type ${contentType}`);

          if (config.mode === 'pull') {
            app = express();
            let router = express.Router();
            app.use(config.path, router);
            let pullRoute =
              pullStream(router, config, grainCache, wire, node, () => ended);
            clearDown = pullRoute.clearDown;
            startChecks = pullRoute.startChecks;

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
          // for ( var u = 1 ; u < config.parallel ; u++ ) { next(); } // Make sure cache has enough on start
          begin = process.hrtime();
        });

      nextJob.then(() => {
        grainCache.push({ grain : x,
          nextFn : (config.backpressure === true) ? once(next) : nop });
        node.wsMsg.send({'push_grain': { ts: Grain.prototype.formatTimestamp(x.ptpOrigin) }});
        if (grainCache.length > config.cacheSize) {
          grainCache = grainCache.slice(grainCache.length - config.cacheSize);
        }
        if (config.backpressure === false) {
          grainCount++;
          var diffTime = process.hrtime(begin);
          var diff = (grainCount * config.timeout) -
              (diffTime[0] * 1000 + diffTime[1] / 1000000|0);
          setTimeout(next, diff);
        }
        startChecks();

        if (config.mode === 'push') {
          var sendMore = () => {
            var newThreadCount = config.parallel - activeThreads;
            newThreadCount = (newThreadCount < 0) ? 0 : newThreadCount;
            node.wsMsg.send({'send_more': { grainCacheLen: grainCache.length,
              activeThreads: activeThreads, newThreadCount: newThreadCount }});
            if (grainCache.length >= newThreadCount) {
              var left = grainCache.slice(0, newThreadCount);
              var right = grainCache.slice(newThreadCount);
              grainCache = right;
            } else {
              if (grainCache.length > 0) {
                grainCache[0].nextFn();
                grainCache[0].nextFn.reset();
              }
              return new Promise(f => { setTimeout(f, 10); });
            }
            left.forEach(gn => {
              activeThreads++;
              var g = gn.grain;
              var ts = Grain.prototype.formatTimestamp(g.ptpOrigin);
              highWaterMark.value =
                (compareVersions(ts, highWaterMark.value) > 0) ? ts : highWaterMark.value;
              var options = {
                agent: keepAliveAgent,
                rejectUnauthorized: false,
                hostname: fullURL.hostname,
                port: fullURL.port,
                path: `${fullURL.path}/${ts}`,
                method: 'PUT',
                headers: {
                  'Content-Type': contentType,
                  'Content-Length': g.buffers[0].length,
                  'Arachnid-PTPOrigin': ts,
                  'Arachnid-PTPSync': Grain.prototype.formatTimestamp(g.ptpSync),
                  'Arachnid-FlowID': uuid.unparse(g.flow_id),
                  'Arachnid-SourceID': uuid.unparse(g.source_id),
                  'Arachnid-Packing': packing,
                  'Arachnid-GrainDuration': g.duration ?
                    Grain.prototype.formatDuration(g.duration) :
                    `${wire.tags.grainDuration[0]}/${wire.tags.grainDuration[1]}`
                }
              };
              if (g.timecode)
                options.headers['Arachnid-Timecode'] =
                  Grain.prototype.formatTimecode(g.timecode);
              if (g.duration)
                options.headers['Arachnid-this.'] =
                  Grain.prototype.formatDuration(g.duration);

              // this.log(`About to make request ${options.path}.`);
              var req = protocol.request(options, res => {
                activeThreads--;
                // this.log(`Response received ${activeThreads}.`);
                if (res.statusCode === 429) {
                  setTimeout(() => {
                    grainCache.push(gn);
                    grainCache = reorderCache(grainCache);
                    sendMore();
                  }, 5);
                  return node.warn(`Going too fast! Returning grain ${ts} to cache.`);
                }
                if (res.statusCode === 409) {
                  gn.nextFn();
                  return node.warn(`Sent a duplicate grain ${ts}. Continuing without repeating.`);
                }
                if (res.statusCode === 400) {
                  var olderCache = grainCache;
                  grainCache = clearCacheBefore(grainCache, ts);
                  for ( var x = 0 ; x < grainCache.length - olderCache.length ; x++) {
                    olderCache[x].nextFn();
                  }
                  return node.warn(`Attempt to push grain below low water mark ${ts}. Clearing older grains.`);
                }
                res.on('data', () => {});
                res.on('end', () => {
                  node.log(`Response ${req.path} has ended. ${grainCount} ${activeThreads} ${ended} ${grainCache.length}`);
                  gn.nextFn();
                });
                res.on('error', e => {
                  node.warn(`Received error when handling push result: ${e}`);
                });
              });

              req.end(g.buffers[0]);

              req.on('error', e => {
                node.warn(`Received error when making a push grain request: ${e}`);
                activeThreads--;
              });
            });
          }; // sendMore function
          dnsPromise = dnsPromise.then(sendMore);
        } // End push
      }).catch(err => {
        this.error(`spm-http-out received error: ${err}`);
      });
    });

    function sendEnd (hwm) {
      var req = protocol.request({
        agent: keepAliveAgent,
        rejectUnauthorized: false,
        hostname: fullURL.hostname,
        port: fullURL.port,
        path: `${fullURL.path}/${hwm}/end`,
        method: 'PUT',
      }, res => {
        res.on('error', e => {
          node.warn(`Unexpected error after pushing stream end: ${e}`);
        });
      });
      req.on('error', e => {
        node.warn(`Unexpected error when requesting end of stream: ${e}`);
      });
      req.end();
      return req;
    }

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

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

var redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
var util = require('util');
var express = require('express');
var bodyParser = require('body-parser');
var http = require('http');
var https = require('https');
var fs = require('fs');
var Grain = require('node-red-contrib-dynamorse-core').Grain;
var uuid = require('uuid');
var Net = require('../util/Net.js');
var dns = require('dns');
var url = require('url');

const variation = 1; // Grain timing requests may vary +-1ms
const nineZeros = '000000000';
const nop = () => {};

var statusError = (status, message) => {
  var e = new Error(message);
  e.status = status;
  return e;
}

function msOriginTs(g) {
  return (g.ptpOrigin.readUIntBE(0, 6) * 1000) +
    (g.ptpOrigin.readUInt32BE(6) / 1000000|0);
}

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

module.exports = function (RED) {
  var count = 0;
  function SpmHTTPOut (config) {
    RED.nodes.createNode(this, config);
    redioactive.Spout.call(this, config);
    var node = this
    if (!this.context().global.get('updated'))
      return this.log('Waiting for global context to be updated.');
    var srcFlow = null;
    this.on('error', err => {
      node.warn(`Error transporting flow over ${config.protocol} '${config.path}': ${err}`)
    });
    var protocol = (config.protocol === 'HTTP') ? http : https;
    var options = (config.protocol === 'HTTP') ? {} : {
      key : fs.readFileSync(__dirname + '/../certs/dynamorse-key.pem'),
      cert : fs.readFileSync(__dirname + '/../certs/dynamorse-cert.pem')
    };
    var grainCache = [];
    var clientCache = {};
    config.path = (config.path.endsWith('/')) ? config.path.slice(0, -1) : config.path;
    var contentType = 'application/octet-stream';
    var started = false;
    var app = null; var server = null;
    var sender = null; var flow = null;
    var senderID = uuid.v4();
    var ledger = this.context().global.get('ledger');
    var nodeAPI = this.context().global.get('nodeAPI');
    var genericID = this.context().global.get('genericID');
    var begin = null;
    var grainCount = 0;
    var ended = false;
    var activeRequests = 0;
    var highWaterMark = '0:0';
    config.pushURL = (config.pushURL.endsWith('/')) ?
      config.pushURL.slice(0, -1) : config.pushURL;
    var fullPath = `${config.pushURL}:${config.port}${config.path}`;
    var fullURL = url.parse(fullPath);
    var keepAliveAgent = new protocol.Agent({keepAlive : true });
    var dnsPromise = (config.mode === 'pull') ? null : new Promise((resolve, reject) => {
      dns.lookup(fullURL.hostname, (err, addr, family) => {
        if (err) return reject(err);
        fullURL.hostname = addr;
        resolve(addr);
      });
    });
    this.each((x, next) => {
      // this.log('RECD-NEXT', x, started);
      if (started === false) {
        node.getNMOSFlow(x, (err, f) => {
          if (err) return node.warn("Failed to resolve NMOS flow.");
          else {
            flow = f;
            console.log('FLOW', f);
            var encodingName = f.tags.encodingName[0];
            if (f.tags.packing && f.tags.packing[0].toLowerCase() === 'v210') encodingName = 'x-v210';
            if (f.tags.format[0] === 'video' &&
                (encodingName === 'raw' || encodingName === 'x-v210')) {
              contentType = `video/${encodingName}; sampling=${f.tags.sampling[0]}; ` +
               `width=${f.tags.width[0]}; height=${f.tags.height[0]}; depth=${f.tags.depth[0]}; ` +
               `colorimetry=${f.tags.colorimetry[0]}; interlace=${f.tags.interlace[0]}`;
            } else {
              contentType = `${f.tags.format[0]}/${f.tags.encodingName[0]}`;
              if (f.tags.clockRate) contentType += `; rate=${f.tags.clockRate[0]}`;
              if (f.tags.channels) contentType += `; channels=${f.tags.channels[0]}`;
            };
          }
          var localName = config.name || `${config.type}-${config.id}`;
          var localDescription = config.description || `${config.type}-${config.id}`;
          // TODO support regeneration of flows
          sender = new ledger.Sender(senderID, null, localName, localDescription,
            (flow) ? flow.id : null, "urn:x-nmos:transport:dash", // TODO add arachnid-specific transport
            genericID, // TODO do better at binding to an address
            `http://${Net.getFirstRealIP4Interface().address}:${config.port}/${config.path}`);
          nodeAPI.putResource(sender).catch(node.warn);
          node.log(`content type ${contentType}`);
        });
        if (app) {
          server = ((config.protocol === 'HTTP') ?
            protocol.createServer(app) : protocol.createServer(options, app))
          .listen(config.port, err => {
            if (err) node.error(`Failed to start arachnid ${config.protocol} server: ${err}`);
            node.log(`Arachnid pull ${config.protocol} server listening on port ${config.port}.`);
          });
          server.on('error', this.warn);
        }
        for ( var u = 1 ; u < config.parallel ; u++ ) { next(); } // Make sure cache has enough on start
        begin = process.hrtime();
        started = true;
      };
      if (Grain.isGrain(x)) {
        grainCache.push({ grain : x,
          nextFn : (config.backpressure === true) ? next : nop });
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
      } else {
        node.warn(`HTTP out received something that is not a grain: ${x}`);
        next();
      }
    });
    if (config.mode === 'pull') {
      app = express();
      // app.use(bodyParser.raw({ limit : 6000000 }));

      app.get(config.path, (req, res) => {
        res.json({
          maxCacheSize : config.cacheSize,
          currentCacheSize : grainCache.length,
          flow_id : (grainCache.length > 0) ? uuid.unparse(grainCache[0].grain.flow_id) : '',
          source_id : (grainCache.length > 0) ? uuid.unparse(grainCache[0].grain.source_id) : '',
          sender_id : (sender) ? sender.id : '',
          cacheTS : grainCache.map(g => {
            return Grain.prototype.formatTimestamp(g.grain.ptpOrigin);
          }),
          clients : Object.keys(clientCache)
        });
      });
      app.get(config.path + "/:ts", (req, res, next) => {
        // var threadNumber = req.headers['arachnid-threadnumber'];
        // threadNumber = (isNaN(+threadNumber)) ? 0 : +threadNumber;
        // console.log('*** Received HTTP GET', req.params.ts, 'thread', threadNumber);
        // var totalConcurrent = req.headers['arachnid-totalconcurrent'];
        // totalConcurrent = (isNaN(+totalConcurrent)) ? 1 : +totalConcurrent;
        this.log(`Received request for ${req.params.ts}.`);
        var nextGrain = grainCache[grainCache.length - 1].nextFn;
        var clientID = req.headers['arachnid-clientid'];
        var g = null;
        var tsMatch = req.params.ts.match(/([0-9]+):([0-9]{9})/);
        if (tsMatch) {
          var secs = +tsMatch[1]|0;
          var nanos = +tsMatch[2]|0;
          var rangeCheck = (secs * 1000) + (nanos / 1000000|0);
          // console.log('<-> Range checking, across the universe', rangeCheck,
          //   msOriginTs(grainCache[0].grain),
          //   msOriginTs(grainCache[grainCache.length - 1].grain));
          g = grainCache.find(y => {

            var grCheck = msOriginTs(y.grain);
            return (rangeCheck >= grCheck - variation) &&
              (rangeCheck <= grCheck + variation);
          });
          // this.log(`Selected grain ${Grain.prototype.formatTimestamp(g.grain.ptpOrigin)}`);
          if (g) {
            nextGrain = g.nextFn;
            g = g.grain;
          } else {
            if (rangeCheck < msOriginTs(grainCache[0].grain)) {
              return next(statusError(410, 'Request for a grain with a timestamp that lies before the available window.'));
            } else {
              // nextGrain();
              // console.log('!!! Responding not found.');
              // this.log(Grain.prototype.formatTimestamp(grainCache[0].grain.ptpOrigin));
              if (ended)
                return next(statusError(503, 'Stream has ended.'));
              else
                return next(statusError(404, 'Request for a grain that lies beyond those currently available.'));
            }
          }
        } else {
          if (!clientID)
            return next(statusError(400, 'When using relative timings, a client ID header must be provided.'));
          var ts = (req.params.ts) ? +req.params.ts : NaN;
          if (isNaN(ts) || ts > 0 || ts <= -6)
            return next(statusError(400, `Timestamp must be a number between ${-5} and 0.`));
          if (!clientCache[clientID] ||
              Date.now() - clientCache[clientID].created > 5000) { // allow for backpressure restart
            clientCache[clientID] = {
              created : Date.now(),
              items : grainCache.slice(-6)
            };
          };
          if (config.backpressure === true && Object.keys(clientCache).length > 1) {
            delete clientCache[clientID];
            return next(statusError(400, `Only one client at a time is possible with back pressure enabled.`));
          }
          var items = clientCache[clientID].items;
          var itemIndex = items.length + ts - 1;
          if (itemIndex < 0) {
            return next(statusError(404, 'Insufficient grains in cache to provide that number of parallel threads.'));
          }
          g = items[itemIndex];
        //  this.log(`Redirecting ${ts} to ${Grain.prototype.formatTimestamp(g.grain.ptpOrigin)}.`);
          return res.redirect(Grain.prototype.formatTimestamp(g.grain.ptpOrigin));
        };
        // this.log('Got to b4 setting headers.');
        if (clientID)
          res.setHeader('Arachnid-ClientID', clientID);
        res.setHeader('Arachnid-PTPOrigin', Grain.prototype.formatTimestamp(g.ptpOrigin));
        res.setHeader('Arachnid-PTPSync', Grain.prototype.formatTimestamp(g.ptpSync));
        res.setHeader('Arachnid-FlowID', uuid.unparse(g.flow_id));
        res.setHeader('Arachnid-SourceID', uuid.unparse(g.source_id));
        res.setHeader('Arachnid-SenderID', senderID);
        if (g.timecode)
          res.setHeader('Arachnid-Timecode',
            Grain.prototype.formatTimecode(g.timecode));
        if (g.duration) {
          res.setHeader('Arachnid-GrainDuration',
            Grain.prototype.formatDuration(g.duration));
        } else {
          node.error('Arachnid requires a grain duration to function (for now).');
        }
        res.setHeader('Content-Type', contentType);
        var data = g.buffers[0];
        res.setHeader('Content-Length', data.length);
        if (req.method === 'HEAD') return res.end();

        var startSend = process.hrtime();
        res.send(data);
        nextGrain();
      });

      app.use((err, req, res, next) => {
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
      });

      app.use((req, res, next) => {
        res.status(404).json({
          code : 404,
          error : `Could not find the requested resource '${req.path}'.`,
          debug : req.path
        });
      });
    } else { // Push
      var newThreadCount = config.parallel - activeThreads;
      var left = grainCache.slice(0, newThreadCount);
      var right = grainCache.slice(newThreadCount);
      grainCache = right;
      dnsPromise.then(() => { left.forEach(gn => {
        activeThreads++;
        var g = gn.grain;
        var ts = Grain.prototype.formatTimestamp(g.ptpOrigin);
        var options = {
          agent: keepAliveAgent,
          rejectUnauthorized: false,
          hostname: fullURL.hostname,
          port: fullURL.port,
          path: `${fullURL.path}/essence/${ts}`,
          method: 'PUT',
          headers: {
            'Content-Type': contentType,
            'Content-Length': g.buffers[0].length,
            'Arachnid-PTPOrigin': ts,
            'Arachnid-PTPSync': Grain.prototype.formatTimestamp(g.ptpSync),
            'Arachnid-FlowID': uuid.unparse(g.flow_id),
            'Arachnid-SourceID': uuid.unparse(g.source_id),
            'Arachnid-SenderID': senderID
          }
        };
        if (g.timecode)
          options.headers['Arachnid-Timecode'] =
            Grain.prototype.formatTimecode(g.timecode);
        if (g.duration)
          options.headers['Arachnid-GrainDuration'] =
            Grain.prototype.formatDuration(g.duration);

        var req = protocol.request(options, res => {
          activeThreads--;
          if (res.statusCode === 429) {
            setTimeout(() => {
              grainCache.push(gn);
              grainCache = reorderCache(grainCache);
            }, 5);
            return this.warn(`Going too fast! Returning grain ${ts} to cache.`);
          }
          if (res.statusCode === 409) {
            gn.nextFn();
            return this.warn(`Sent a duplicate grain ${ts}. Continuing without repeating.`);
          }
          if (res.statusCode === 400) {
            var olderCache = grainCache;
            grainCache = clearCacheBefore(grainCache, ts);
            for ( var x = 0 ; x < grainCache.length - olderCache.length ; x++) {
              olderCache[x].nextFn();
            }
            return this.warn(`Attempt to push grain below low water mark ${ts}. Clearing older grains.`);
          }
          req.on('end', () => {
            highWaterMark = (compareVersions(ts, highWaterMark) > 0) ? ts : highWaterMark;
            gn.nextFn();
            if (activeThreads <= 0 && ended && grainCache.length === 0) {
              setImmediate(() => sendEnd(highWaterMark));
            }
          });
          req.on('error', e => {
            this.warn(`Received error when handling push result: ${e}`);
          });
        });

        req.end(g.buffers[0]);

        req.on('error', e => {
          this.warn(`Received error when making a push grain request: ${e}`);
          activeThreads--;
        });
      }); });

      function sendEnd(hwm) {
        var req = protocol.request({
          agent: keepAliveAgent,
          rejectUnauthorized: false,
          hostname: fullURL.hostname,
          port: fullURL.port,
          path: `${fullURL.path}/essence/${hwm}/end`,
          method: 'PUT',
        }, res => {
          res.on('error', e => {
            this.warn(`Unexpected error after pushing stream end: ${e}`);
          });
        });
      }
    } // End push

    this.clearDown = null;
    if (this.clearDown === null) {
      this.clearDown = setInterval(() => {
        var toDelete = [];
        var now = Date.now();
        Object.keys(clientCache).forEach(k => {
          if (clientCache[k].items && now - clientCache[k].created > 5000)
            toDelete.push(k);
        });
        toDelete.forEach(k => {
          if (config.backpressure === true) {
            node.log(`Clearing items from clientID '${k}' to free related memory.`);
            delete clientCache[k].items;
          } else {
            node.log(`Clearing clientID '${k}' from the client cache.`);
            delete clientCache[k];
          }
        });
      }, 1000);
    };

    this.done(() => {
      node.log('Closing the app and/or ending the stream!');
      clearInterval(this.clearDown);
      this.clearDown = null;
      ended = true;
      if (server) setTimeout(server.close, 20000);
    });
  }
  util.inherits(SpmHTTPOut, redioactive.Spout);
  RED.nodes.registerType("spm-http-out", SpmHTTPOut);
}

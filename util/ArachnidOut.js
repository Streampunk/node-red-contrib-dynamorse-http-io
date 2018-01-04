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


const { Grain, PTPMaths : { compareVersions, msOriginTs } } =
  require('node-red-contrib-dynamorse-core').Grain;
const uuid = require('uuid');
const http = require('http');
const https = require('https');
const url = require('url');

const variation = 1; // Grain timing requests may vary +-1ms

var statusError = (status, message) => {
  var e = new Error(message);
  e.status = status;
  return e;
};

function makeHeaders (wire) {
  var srcTags = wire.tags;
  var result = {};
  result.encodingName = srcTags.encodingName;
  if (srcTags.packing && srcTags.packing.toLowerCase() === 'v210') {
    result.encodingName = 'x-v210';
  }
  if (srcTags.format === 'video' &&
    (result.encodingName === 'raw' || result.encodingName === 'x-v210' || result.encodingName === 'h264' )) {
    result.contentType = `video/${result.encodingName}; sampling=${srcTags.sampling}; ` +
      `width=${srcTags.width}; height=${srcTags.height}; depth=${srcTags.depth}; ` +
      `colorimetry=${srcTags.colorimetry}; interlace=${srcTags.interlace}`;
  } else {
    result.contentType = `${srcTags.format}/${srcTags.encodingName}`;
    if (srcTags.clockRate) result.contentType += `; rate=${srcTags.clockRate}`;
    if (srcTags.channels) result.contentType += `; channels=${srcTags.channels}`;
  }
  result.packing = (srcTags.packing) ? srcTags.packing : 'raw';
  result.grainDuration = srcTags.grainDuration;
  return result;
}

function pullStream (router, config, grainCache, wire, logger, endFn) {

  var startCache = {};
  var { contentType, packing } = makeHeaders(wire);

  function startChecks (startID) {
    if (!startID) {
      let hungry = Object.keys(startCache)
        .map(startChecks)
        .some(x => x === true);
      return hungry;
    }
    let startResponses = startCache[startID].responses;
    if (!startResponses.includes(undefined) &&
        grainCache.length >= startResponses.length) {
      let lastGrains = grainCache.slice(-startResponses.length);
      for ( let i = 0 ; i < startResponses.length ; i++ ) {
        startResponses[i].res.redirect(
          Grain.prototype.formatTimestamp(lastGrains[i].grain.ptpOrigin));
      }
      delete startCache[startID];
      return false;
    } else {
      if (grainCache.length < startResponses.length) {
        if (grainCache.length > 0) {
          grainCache.slice(-1)[0].nextFn();
        }
        return true;
      } else {
        return false;
      }
    }
  }

  router.get('/', (req, res) => {
    res.json({
      maxCacheSize : config.cacheSize,
      currentCacheSize : grainCache.length,
      wire : wire,
      cacheTS : grainCache.map(g => {
        return Grain.prototype.formatTimestamp(g.grain.ptpOrigin);
      }),
      starters : Object.keys(startCache)
    });
  });

  router.get('/start/:sid/:conc/:t', (req, res, next) => {
    // console.log('*** RECEIVED START', req.params);
    let startID = req.params.sid;
    let conc = (req.params.conc) ? +req.params.conc : NaN;
    if (isNaN(conc) || conc <= 0 || conc > 6) {
      return next(statusError(400, `Number of concurrent threads must be a number between 1 and 6. Recieved ${req.paraks.conc}.`));
    }
    let t = (req.params.t) ? +req.params.t : NaN;
    if (isNaN(t) || t <= 0 || t > conc) {
      return next(statusError(400, `Timestamp must be a number between 1 and ${conc}. Received ${req.params.t}.`));
    }
    if (!startCache[startID]) {
      startCache[startID] = {
        created : Date.now(),
        responses : new Array(conc)
      };
    }
    if (Date.now() - startCache[startID].created > 5000) { // allow for backpressure restart
      startCache[startID].responses.forEach(r => {
        r.next(statusError(408, `For start ID ${startID}, thread ${r.t} of ${r.conc}, redirection is not available.`));
      });
      startCache[startID] = {
        created : Date.now(),
        responses : new Array(conc)
      };
    }
    let startResponses = startCache[startID].responses;
    if (startResponses[t - 1]) {
      let res = startResponses[t - 1];
      res.next(statusError(409, `For start ID ${startID}, thread ${res.t} of ${res.conc}, duplicate request for redirection.`));
      logger.warn(`Duplicate request for start ID ${startID}, thread ${res.t} of ${res.conc}, duplicate request for redirection.`);
    }
    startResponses[t - 1] = {
      res: res,
      next: next,
      t: t,
      conc: conc
    };

    return startChecks(startID);
  });

  router.get('/:ts', (req, res, next) => {
    // this.log(`Received request for ${req.params.ts}.`);
    var nextGrain = grainCache[grainCache.length - 1].nextFn;
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
          if (endFn()) {
            return next(statusError(405, 'Stream has ended.'));
          } else {
            return next(statusError(404, 'Request for a grain that lies beyond those currently available.'));
          }
        }
      }
    } else {
      return(next(statusError(400, `Could not match timestamp ${req.params.ts} provided on path.`)));
    }

    // this.log('Got to b4 setting headers.');
    res.setHeader('Arachnid-PTPOrigin', Grain.prototype.formatTimestamp(g.ptpOrigin));
    res.setHeader('Arachnid-PTPSync', Grain.prototype.formatTimestamp(g.ptpSync));
    res.setHeader('Arachnid-FlowID', uuid.unparse(g.flow_id));
    res.setHeader('Arachnid-SourceID', uuid.unparse(g.source_id));
    res.setHeader('Arachnid-Packing', packing);
    if (g.timecode)
      res.setHeader('Arachnid-Timecode',
        Grain.prototype.formatTimecode(g.timecode));
    if (g.duration) {
      res.setHeader('Arachnid-GrainDuration',
        Grain.prototype.formatDuration(g.duration));
    } else {
      logger.error('Arachnid requires a grain duration to function (for now).');
    }
    res.setHeader('Content-Type', contentType);
    var data = g.buffers[0];
    res.setHeader('Content-Length', data.length);
    if (req.method === 'HEAD') return res.end();

    res.send(data);
    if (endFn() === false) {
      nextGrain();
    }
  });

  var clearDown = setInterval(() => {
    var toDelete = [];
    var now = Date.now();
    Object.keys(startCache).forEach(k => {
      if (now - startCache[k].created > 5000)
        toDelete.push(k);
    });
    toDelete.forEach(k => {
      let responses = startCache[k].responses;
      logger.warn(`Deleting start ID ${k} from start cache for ${wire.name} with entries ${responses.map(x => x && x.t)}.`);
      responses.forEach(r => {
        r.next(statusError(408, `Clearing start cache if ${wire.name} for start ID ${k}, thread ${r.t} of ${r.conc}, after 5 seconds.`));
      });
      delete startCache[k];
    });
  }, 1000);

  return { startChecks, clearDown };
}

function pushMore (wire, config, grainCache, logger, highWaterMark) {

  var keepAliveAgent = protocol.Agent({ keepAlive : true });
  var protocol = (config.protocol === 'HTTP') ? http : https;

  var fullURL = url.parse(`${config.pushURL}:${config.port}${config.path}`);
  var activeThreads = 0;

  var { packing, contentType, grainDuration } = makeHeaders(wire);

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

  var sendMore = () => {
    var newThreadCount = config.parallel - activeThreads;
    newThreadCount = (newThreadCount < 0) ? 0 : newThreadCount;
    logger.wsMsg.send({'send_more': { grainCacheLen: grainCache.length,
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
            `${grainDuration[0]}/${grainDuration[1]}`
        }
      };
      if (g.timecode)
        options.headers['Arachnid-Timecode'] =
          Grain.prototype.formatTimecode(g.timecode);
      if (g.duration)
        options.headers['Arachnid-GrainDuration'] =
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
          return logger.warn(`Going too fast! Returning grain ${ts} to cache.`);
        }
        if (res.statusCode === 409) {
          gn.nextFn();
          return logger.warn(`Sent a duplicate grain ${ts}. Continuing without repeating.`);
        }
        if (res.statusCode === 400) {
          var olderCache = grainCache;
          grainCache = clearCacheBefore(grainCache, ts);
          for ( var x = 0 ; x < grainCache.length - olderCache.length ; x++) {
            olderCache[x].nextFn();
          }
          return logger.warn(`Attempt to push grain below low water mark ${ts}. Clearing older grains.`);
        }
        res.on('data', () => {});
        res.on('end', () => {
          logger.log(`Response ${req.path} has ended with ${grainCache.length} grains remaining.`);
          gn.nextFn();
        });
        res.on('error', e => {
          logger.warn(`Received error when handling push result: ${e}`);
        });
      });

      req.end(g.buffers[0]);

      req.on('error', e => {
        logger.warn(`Received error when making a push grain request: ${e}`);
        activeThreads--;
      });
    });
  }; // sendMore function

  return sendMore;
}

module.exports = {
  pullStream: pullStream,
  pushMore: pushMore
};

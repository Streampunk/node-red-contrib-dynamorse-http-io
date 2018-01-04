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

// const uuid = require('uuid');
const { Grain, Redioactive : { end : redEnd }, PTPMaths : { compareVersions } } =
  require('node-red-contrib-dynamorse-core');
const url = require('url');
const http = require('http');
const https = require('https');

const nineZeros = '000000000';
const minBufferSize = 10000;

var statusError = (status, message) => {
  var e = new Error(message);
  e.status = status;
  return e;
};

function startThreads (n) {
  let threads = [];
  let startID = 'sid' + Date.now();
  for ( let x = 1 ; x <= n ; x++ ) {
    threads.push(`start/${startID}/${n}/${x}`);
  }
  return threads;
}

function makeInitialBuffers (totalConcurrent, maxBuffer) {
  let buffers = [];
  let bufferIdx = [];
  for ( let x = 0 ; x < totalConcurrent ; x++) {
    let threadBufs = [];
    for ( let y = 0 ; y < maxBuffer ; y++ ) {
      threadBufs.push(Buffer.alloc(minBufferSize));
    }
    buffers.push(threadBufs);
    bufferIdx.push(0);
  }
  return { buffers, bufferIdx };
}

function pullNext (config, logger, endState, startTime, highWaterMark,
  wireOrMakeWire = null) {

  var keepAliveAgent = protocol.Agent({ keepAlive : true });
  var protocol = (config.protocol === 'HTTP') ? http : https;

  var baseTime = [ startTime [0], startTime[1] ];
  var totalConcurrent = +config.parallel;
  var grainQueue = {};
  var nextRequest = startThreads(totalConcurrent);
  var activeThreads =
    [ false, false, false, false, false, false].slice(0, totalConcurrent);
  var fullURL = url.parse(`${config.pullURL}:${config.port}${config.path}`);

  const { buffers, bufferIdx } = makeInitialBuffers(totalConcurrent. config.maxBuffer);
  var flows = null;
  var endCount = 0;
  var endTimeout = null;

  const wireIsFn = typeof wireOrMakeWire === 'function';
  var flowID = wireIsFn ? null : wireOrMakeWire.flowID;
  var sourceID = wireIsFn ? null : wireOrMakeWire.sourceID;

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
          grainTime.writeUIntBE(baseTime[0], 0, 6);
          grainTime.writeUInt32BE(baseTime[1], 6);
          var grainDuration = g.getDuration();
          baseTime[1] = ( baseTime[1] +
            grainDuration[0] * 1000000000 / grainDuration[1]|0 );
          baseTime = [ baseTime[0] + baseTime[1] / 1000000000|0,
            baseTime[1] % 1000000000];
          push(null, new Grain(g.buffers, grainTime, g.ptpOrigin, g.timecode,
            flowID, sourceID, g.duration));
        }
        delete grainQueue[gts];
        highWaterMark = gts;
      });
    if (endState.ended && activeThreads.every(a => a === false)) {
      push(null, redEnd);
    }
  };

  var runNext = (x, push, next) => {
    var requestTimer = process.hrtime();
    // logger.log(`Thread ${x}: Requesting ${fullURL.path}/${nextRequest[x]}`);
    var req = protocol.request({
      rejectUnauthorized: false,
      hostname: fullURL.hostname,
      port: fullURL.port,
      path: `${fullURL.path}/${nextRequest[x]}`,
      method: 'GET',
      agent: keepAliveAgent
    }, res => {
      // console.log('Response received after', process.hrtime(requestTimer));
      // var count = 0;
      let position = 0;
      let currentIdx = bufferIdx[x] % buffers[x].length;
      let currentBuf = buffers[x][currentIdx];
      // console.log('>>>', x, buffers[0].map(x => x.length));
      if (res.statusCode === 302) {
        var location = res.headers['location'];
        logger.log(`Being redirected to ${location}.`);
        location = '/' + location;
        var lm = location.match(/.*\/([0-9]+):([0-9]{9})$/);
        if (lm && lm.length >= 3) {
          nextRequest[x] = `${lm[1]}:${lm[2]}`;
          return setImmediate(() => { runNext(x, push, next); });
        } else {
          logger.warn(`Received redirect to unrecognisable location ${location.slice(1)}. Retrying.`);
          setTimeout(() => {
            runNext(x, push, next);
          }, 5);
          return;
        }
      }
      if (res.statusCode === 404) {
        logger.warn(`Received not found in thread ${x}, request ${config.path}/${nextRequest[x]} - may be ahead of the game. Retrying.`);
        setTimeout(() => {
          runNext(x, push, next);
        }, 5);
        return;
      }
      if (res.statusCode === 410) {
        logger.warn(`BANG! Cache miss when reading end ${config.path}/${nextRequest[x]} on thread ${x}.`);
        // push(`Request for grain ${config.path}/${nextRequest[x]} that has already gone on thread ${x}. Resetting.`);
        nextRequest = startThreads(totalConcurrent);
        activeThreads[x] = false;
        return next();
      }
      if (res.statusCode === 405) {
        logger.log(`Source stream has ended - thread ${x}.`);
        endTimeout = (endTimeout) ? endTimeout :
          setTimeout(() => {
            logger.log('Pushing redioactive.end.');
            push(null, redEnd);
          }, 200); // TODO smell!
        activeThreads[x] = false;
        endState.ended = true;
        return;
      }
      if (res.statusCode === 200) {
        let contentLength = +res.headers['content-length'];
        if (currentBuf.length < contentLength) {
          logger.log(`Extending buffer ${currentIdx} for thread ${x} from ${currentBuf.length} bytes to ${contentLength} bytes.`);
          currentBuf = Buffer.alloc(contentLength);
          buffers[x][currentIdx] = currentBuf;
        }
        nextRequest[x] = res.headers['arachnid-ptporigin'];
        if (flowID === null && wireIsFn) {
          wireOrMakeWire(res.headers).then(x => {
            flowID = x.flowID;
            sourceID = x.sourceID;
          });
        }
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
          if (config.logTime) {
            console.log(`Thread ${x}: Retrieved in ${process.hrtime(requestTimer)[1] / 1000000} ms`);
          }
          next();
        });
      }
      res.on('error', e => {
        logger.warn(`Received error during streaming of get response on thread ${x}: ${e}.`);
        push(`Received error during streaming of get response on thread ${x}: ${e}.`);
        activeThreads[x] = false;
        next();
      });
    });
    req.on('error', e => {
      // Check for flow !== null is so that shutdown does not happen too early
      if (flows !== null && e.message.indexOf('ECONNREFUSED') >= 0) {
        logger.log(`Received connection refused on thread ${x}. Assuming end.`);
        activeThreads[x] = true; // Don't make another request.
        endCount++;
        if (endCount === activeThreads.length) {
          push(null, redEnd);
        }
        return;
      }
      logger.warn(`Received error when requesting frame from server on thread ${x}: ${e}`);
      push(`Received error when requesting frame from server on thread ${x}: ${e}`);
      activeThreads[x] = false;
      next();
    });
    req.end();
    requestTimer = process.hrtime();
  }; // runNext funciton
  return { runNext, nextRequest };
}

function pushStream (router, config, endState, logger,
  generator, wireOrMakeWire, serverClose) {

  var receiveQueue = {};
  var lowWaterMark = null;
  endState.endMark = null;
  var resolver = null;
  var flowPromise = new Promise(f => { resolver = f; });
  var started = false;
  var bufferLoop = 0;
  var count = 0;
  var totalConcurrent = +config.parallel;
  const wireIsFn = typeof wireOrMakeWire === 'function';
  var flowID = (wireIsFn) ? null : wireOrMakeWire.flowID;
  var sourceID = (wireIsFn) ? null : wireOrMakeWire.sourceID;

  const { buffers } = makeInitialBuffers(totalConcurrent, config.maxBuffer);

  router.put('/:ts', (req, res, next) => {
    logger.log(`Received request ${req.path}.`);
    if (Object.keys(receiveQueue).length >= config.cacheSize) {
      return next(statusError(429, `Receive queue is at its limit of ${config.cacheSize} elements.`));
    }
    if (Object.keys(receiveQueue).indexOf(req.params.ts) >=0) {
      return next(statusError(409, `Receive queue already contains timestamp ${req.params.ts}.`));
    }
    if (lowWaterMark && compareVersions(req.params.ts, lowWaterMark) < 0) {
      return next(statusError(400, `Attempt to send grain with timestamp ${req.params.ts} that is prior to the low water mark of ${lowWaterMark}.`));
    }
    let idx = [bufferLoop / buffers.length|0, bufferLoop++ % buffers.length];
    receiveQueue[req.params.ts] = {
      req: req,
      res: res,
      idx: idx,
      buf: buffers[idx[0], idx[1]]
    };
    if (started === false) {
      if (wireIsFn) {
        resolver(wireOrMakeWire(req.headers).then(x => {
          flowID = x.flowID;
          sourceID = x.sourceID;
        }));
      } else {
        resolver();
      }
      started = true;
    } else {
      if (resolver) {
        resolver();
      } else {
        logger.warn('No resolver to call.');
      }
    }
    resolver = null;
  });

  router.put('/:hwm/end', (req, res) => {
    logger.warn(`End received with remote high water mark ${req.params.hwm} and current low water mark ${lowWaterMark}.`);
    endState.ended = true;
    endState.endMark = req.params.hwm;
    logger.wsMsg.send({'end_received': { hwm: endState.endMark }});
    if (resolver) resolver();
    resolver = null;
    res.json({
      message: 'end_received',
      timestamp: req.params.hwm
    });
  });

  generator((push, next) => {
    count++;
    flowPromise = flowPromise.then(() => {
      var sortedKeys = Object.keys(receiveQueue)
        .sort(compareVersions);
      var numberToSend = (endState.ended) ? 1 :
        sortedKeys.length - totalConcurrent + 1;
      if (endState.ended && sortedKeys.length === 0) {
        push(null, redEnd);
        return serverClose(() => {
          logger.warn('Closed server.');
        });
      }
      logger.log(`numberToSend: ${numberToSend} with parallel: ${totalConcurrent}.`);
      sortedKeys.slice(0, (numberToSend >= 0) ? numberToSend : 0)
        .forEach(gts => {
          var req = receiveQueue[gts].req;
          var res = receiveQueue[gts].res;
          var buf = receiveQueue[gts].buf;
          var idx = receiveQueue[gts].idx;
          delete receiveQueue[gts];
          if (lowWaterMark && compareVersions(req.params.ts, lowWaterMark) < 0) {
            next();
            logger.warn(`Later attempt to send grain with timestamp ${req.params.ts} that is prior to the low water mark of ${lowWaterMark}.`);
            return res.status(400).json({
              code: 400,
              error: `Later attempt to send grain with timestamp ${req.params.ts} that is prior to the low water mark of ${lowWaterMark}.`,
              debug: 'No stack available.'
            });
          }
          var position = 0;
          let contentLength = +req.headers['content-length'];
          if (!isNaN(contentLength) && buf.length < contentLength) {
            logger.log(`Extending buffer ${idx} from ${buf.length} bytes to ${contentLength} bytes.`);
            buf = Buffer.alloc(contentLength);
            buffers[idx[0], idx[1]] = buf;
          }
          req.on('data', data => {
            position += data.copy(buf, position);
          });
          res.on('error', logger.warn);
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
            lowWaterMark = gts;

            if (endState.ended) {
              if (resolver) resolver();
              resolver = null;
            }

            res.json({
              message: 'grain_recieved',
              timestamp: req.headers['arachnid-ptporigin'],
              bodyLength : position,
              receiveQueueLength : Object.keys(receiveQueue).length
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
  }); // pushStream
}

module.exports = {
  pullNext: pullNext,
  pushStream: pushStream
};

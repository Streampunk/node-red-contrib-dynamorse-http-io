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

const TestUtil = require('dynamorse-test');
const testCommon = require('./testCommon.js');

/* TestUtil.nodeRedTest('Testing HTTP-out to HTTP-in push simplest case 40ms', {
  numPushes: 10,
  timeout: 40,
  parallel: 1,
  format: 'video',
  mode: 'push',
  protocol: 'HTTP',
  spoutCount: 0,
  seqTest: [],
  flowTimeout: 10000 // needs to be longer than the time it takes to flow!
}, testCommon.httpGraph, testCommon.recvMsg); */

/* TestUtil.nodeRedTest('Testing HTTP-out to HTTP-in push simplest case 40ms', {
  numPushes: 10,
  timeout: 40,
  parallel: 1,
  format: 'audio',
  mode: 'push',
  protocol: 'HTTP',
  spoutCount: 0,
  seqTest: [],
  flowTimeout: 10000 // needs to be longer than the time it takes to flow!
}, testCommon.httpGraph, testCommon.recvMsg);

TestUtil.nodeRedTest('Testing HTTP-out to HTTP-in push 100 as fast as', {
  numPushes: 100,
  timeout: 0,
  parallel: 1,
  format: 'video',
  mode: 'push',
  protocol: 'HTTP',
  spoutCount: 0,
  seqTest: [],
  flowTimeout: 10000
}, testCommon.httpGraph, testCommon.recvMsg); */

TestUtil.nodeRedTest('Testing HTTP-out to HTTP-in push 2 threads', {
  numPushes: 10,
  timeout: 40,
  parallel: 4,
  format: 'video',
  mode: 'push',
  protocol: 'HTTP',
  spoutCount: 0,
  seqTest: [],
  flowTimeout: 10000
}, testCommon.httpGraph, testCommon.recvMsg);

/* TestUtil.nodeRedTest('Testing HTTP-out to HTTP-in push 3 threads', {
  numPushes: 10,
  timeout: 40,
  parallel: 3,
  format: 'video',
  mode: 'push',
  protocol: 'HTTP',
  spoutCount: 0,
  seqTest: [],
  flowTimeout: 10000
}, testCommon.httpGraph, testCommon.recvMsg);

TestUtil.nodeRedTest('Testing HTTP-out to HTTP-in push 4 threads', {
  numPushes: 10,
  timeout: 40,
  parallel: 4,
  format: 'video',
  mode: 'push',
  protocol: 'HTTP',
  spoutCount: 0,
  seqTest: [],
  flowTimeout: 10000
}, testCommon.httpGraph, testCommon.recvMsg); */

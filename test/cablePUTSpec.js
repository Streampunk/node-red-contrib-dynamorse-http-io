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

const TestUtil = require('dynamorse-test');
const cableCommon = require('./cableCommon.js');

TestUtil.nodeRedTest('Testing Cable-out to Cable-in HTTP push simplest case 40ms', {
  numPushes: 10,
  timeout: 40,
  parallel: 1,
  mode: 'push',
  protocol: 'HTTP',
  spoutCount: {},
  seqTest: {},
  flowTimeout: 10000 // needs to be longer than the time it takes to flow!
}, cableCommon.cableGraph, cableCommon.recvMsg);

/* TestUtil.nodeRedTest('Testing Cable-out to Cable-in HTTP push 100 as fast as', {
  numPushes: 100,
  timeout: 0,
  parallel: 1,
  mode: 'push',
  protocol: 'HTTP',
  spoutCount: {},
  seqTest: {},
  flowTimeout: 10000
}, cableCommon.cableGraph, cableCommon.recvMsg);

for ( let t = 2 ; t <= 2 ; t++ ) {
  TestUtil.nodeRedTest(`Testing Cable-out to Cable-in HTTP push ${t} threads`, {
    numPushes: 20,
    timeout: 40,
    parallel: t,
    mode: 'push',
    protocol: 'HTTP',
    spoutCount: {},
    seqTest: {},
    flowTimeout: 10000
  }, cableCommon.cableGraph, cableCommon.recvMsg);
} */
